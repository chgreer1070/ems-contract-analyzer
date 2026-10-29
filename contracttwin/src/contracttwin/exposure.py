"""Turn cited terms into margin, cash, working-capital, and inventory impacts.

A dollar figure is reported only when the contract text states that figure.
Everything else says the impact cannot be determined. This step does not invent
volume, cost, or revenue.
"""

from __future__ import annotations

from typing import assert_never

from contracttwin.models import DomainExposure, ExposureSummary, Fact, Impact, ImpactArea

_AREAS: tuple[ImpactArea, ...] = ("margin", "cash", "working_capital", "inventory")

_REASONS = {
    "pricing": "the text states price or payment timing but does not state cost, volume, invoice totals, or a dollar impact",
    "ncnr": "the text assigns non-cancellable purchase liability but does not state quantities, component cost, or a dollar impact",
    "excess_and_obsolete": "the text assigns excess-and-obsolete liability but does not state quantities, actual cost, or a dollar impact",
}


def build_exposure(facts: list[Fact]) -> ExposureSummary:
    domains: list[DomainExposure] = []
    for domain in ("pricing", "ncnr", "excess_and_obsolete"):
        related = [fact for fact in facts if fact.operative and fact.kind == "fact" and fact.domain == domain]
        impacts = [_impact_for(area, domain, related) for area in _AREAS]
        domains.append(DomainExposure(domain=domain, impacts=impacts))
    return ExposureSummary(domains=domains)


def _impact_for(area: ImpactArea, domain: str, facts: list[Fact]) -> Impact:
    explicit = [
        fact
        for fact in facts
        if fact.attributes.get("explicit_area") == area and fact.attributes.get("explicit_amount")
    ]
    amounts = {str(fact.attributes.get("explicit_amount")) for fact in explicit}
    if len(amounts) > 1:
        return Impact(
            area=area,
            determination="cannot_be_determined",
            kind=None,
            summary=(
                f"The {_label(area)} impact cannot be determined because the text states more than one amount "
                f"({', '.join(sorted(amounts))})."
            ),
            amount=None,
            currency=None,
            source_fact_ids=[fact.id for fact in explicit],
            citations=[],
        )
    if explicit:
        fact = explicit[0]
        amount = str(fact.attributes["explicit_amount"])
        currency = str(fact.attributes.get("explicit_currency") or "USD")
        return Impact(
            area=area,
            determination="supported",
            kind="fact",
            summary=f"The text states a {_label(area)} amount of {currency} {amount}.",
            amount=amount,
            currency=currency,
            source_fact_ids=[fact.id],
            citations=list(fact.citations),
        )
    return Impact(
        area=area,
        determination="cannot_be_determined",
        kind=None,
        summary=f"The {_label(area)} impact cannot be determined because {_REASONS[domain]}.",
        amount=None,
        currency=None,
        source_fact_ids=[fact.id for fact in facts[:12]],
    )


def _label(area: ImpactArea) -> str:
    if area == "margin":
        return "margin"
    if area == "cash":
        return "cash"
    if area == "working_capital":
        return "working capital"
    if area == "inventory":
        return "inventory"
    assert_never(area)
