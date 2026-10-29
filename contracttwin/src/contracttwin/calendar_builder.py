"""Build notice and deadline dates from cited facts.

A date is included only when the text states it, or when it can be counted
from dates and day counts the text states. Otherwise the entry has no date and
says the date cannot be determined.
"""

from __future__ import annotations

from datetime import date, timedelta

from contracttwin.models import CalendarEntry, Fact
from contracttwin.quote_check import Candidate, review_candidates
from contracttwin.textutil import parse_iso_date, stable_id


def build_calendar(
    facts: list[Fact],
    documents: dict[str, tuple[str, str]],
) -> tuple[list[CalendarEntry], list[Fact], list[str]]:
    warnings: list[str] = []
    derived: list[Candidate] = []
    entries: list[CalendarEntry] = []

    effective = _one(facts, "date_role", "agreement_effective")
    term_end = _one(facts, "date_role", "term_end")
    amendments = [fact for fact in facts if fact.attributes.get("date_role") == "amendment_effective" and fact.operative]
    business_day = _business_day_rule(facts)
    price_notice = _one_attr(facts, "notice_days_before_anniversary")
    eo_notice = _one_attr(facts, "notice_business_days")

    for fact in [effective, term_end, *amendments]:
        if fact is None:
            continue
        iso = str(fact.attributes.get("date"))
        entries.append(_from_fact(fact, iso, "The date is stated in the cited text."))

    if price_notice and effective and term_end:
        entries.extend(_anniversaries(price_notice, effective, term_end, derived, documents, warnings))
    elif price_notice:
        entries.append(
            _undated(
                price_notice,
                "The price-notice rule is stated, but the calendar date cannot be determined because the effective date or the term end is missing.",
            )
        )

    if eo_notice:
        entries.extend(_business_day_notice(eo_notice, business_day, derived, documents, warnings))

    extra_facts, rejected = review_candidates(derived, documents)
    for item in rejected:
        warnings.append(item.reason)
    return entries, extra_facts, warnings


def _anniversaries(
    notice: Fact,
    effective: Fact,
    term_end: Fact,
    derived: list[Candidate],
    documents: dict[str, tuple[str, str]],
    warnings: list[str],
) -> list[CalendarEntry]:
    start = parse_iso_date(str(effective.attributes["date"]))
    end = parse_iso_date(str(term_end.attributes["date"]))
    days = int(notice.attributes["notice_days_before_anniversary"])
    entries: list[CalendarEntry] = []
    year = start.year + 1
    while year <= start.year + 40:
        anniversary, assumed = _anniversary(start, year)
        if anniversary > end:
            break
        assumption_id = None
        if assumed:
            assumption = Candidate(
                kind="assumption",
                domain="notice",
                statement=(
                    f"The effective date is February 29. {year} has no February 29, so the anniversary "
                    "was placed on February 28. The agreement does not state this convention."
                ),
                operative=True,
                section=effective.section,
                document_id=effective.citations[0].document_id,
                document_name=effective.citations[0].document_name,
                quote=effective.citations[0].quote,
                attributes={"assumption": "february-29-anniversary"},
            )
            accepted, rejected = review_candidates([assumption], documents)
            if rejected or not accepted:
                warnings.append("A February 29 anniversary could not be cited, so that year was skipped.")
                year += 1
                continue
            derived.append(assumption)
            assumption_id = accepted[0].id
        notice_date = anniversary - timedelta(days=days)
        inference = _inference_candidate(
            statement=f"The anniversary of the effective date in {year} is {anniversary.isoformat()}.",
            notice=notice,
            extra=[effective, term_end],
            attributes={"date": anniversary.isoformat(), "date_role": "anniversary"},
            depends=[effective.id, term_end.id] + ([assumption_id] if assumption_id else []),
        )
        derived.append(inference)
        notice_inference = _inference_candidate(
            statement=(
                f"Price-adjustment notice for the {anniversary.isoformat()} anniversary is due "
                f"{notice_date.isoformat()}, which is {days} days before that anniversary."
            ),
            notice=notice,
            extra=[effective, term_end],
            attributes={"date": notice_date.isoformat(), "date_role": "price_notice"},
            depends=[effective.id, term_end.id, notice.id] + ([assumption_id] if assumption_id else []),
        )
        derived.append(notice_inference)
        entries.append(
            CalendarEntry(
                id=stable_id("calendar", anniversary.isoformat(), "anniversary"),
                kind="inference",
                domain="pricing",
                description=inference.statement,
                date=anniversary.isoformat(),
                operative=True,
                citations=_quotes(notice, effective, term_end),
                basis="Counted one year at a time from the stated effective date, through the stated term end.",
                depends_on=inference.depends_on,
            )
        )
        entries.append(
            CalendarEntry(
                id=stable_id("calendar", notice_date.isoformat(), "price-notice"),
                kind="inference",
                domain="notice",
                description=notice_inference.statement,
                date=notice_date.isoformat(),
                operative=True,
                citations=_quotes(notice, effective, term_end),
                basis=f"The cited clause requires notice {days} days before each anniversary. These are calendar days, not business days.",
                depends_on=notice_inference.depends_on,
            )
        )
        year += 1
    return entries


def _business_day_notice(
    notice: Fact,
    business_day: Fact | None,
    derived: list[Candidate],
    documents: dict[str, tuple[str, str]],
    warnings: list[str],
) -> list[CalendarEntry]:
    days = int(notice.attributes["notice_business_days"])
    anchor = notice.attributes.get("anchor_date")
    about_inventory = notice.attributes.get("notice_topic") == "excess_and_obsolete"
    recurring = (
        f"Excess-and-obsolete notice is due {days} business days after the end of the calendar quarter. "
        "A date for any quarter the text does not name cannot be determined."
        if about_inventory
        else f"Notice is due {days} business days after the stated anchor. A date the text does not name cannot be determined."
    )
    entries = [
        CalendarEntry(
            id=stable_id("calendar", notice.id, "recurring-notice"),
            kind="fact",
            domain="excess_and_obsolete" if about_inventory else "notice",
            description=recurring,
            date=None,
            operative=notice.operative,
            citations=list(notice.citations),
            basis="The clause states the rule. It does not list every quarter-end.",
            depends_on=[notice.id],
        )
    ]
    if not isinstance(anchor, str):
        return entries
    if business_day is None or business_day.attributes.get("business_day_weekends_excluded") is not True:
        entries.append(
            _undated(
                notice,
                f"The text names {anchor} and {days} business days, but the business-day meaning is missing, so the notice date cannot be determined.",
            )
        )
        return entries
    if business_day.attributes.get("business_day_holidays_excluded") is True:
        entries.append(
            _undated(
                notice,
                f"The text excludes holidays but does not list them, so the notice date after {anchor} cannot be determined.",
            )
        )
        return entries
    counted = _add_business_days(parse_iso_date(anchor), days)
    if about_inventory:
        counted_statement = (
            f"Excess-and-obsolete notice for the quarter ending {anchor} is due {counted.isoformat()}, "
            f"which is {days} business days after that date."
        )
    else:
        counted_statement = (
            f"Notice is due {counted.isoformat()}, which is {days} business days after {anchor}."
        )
    inference = _inference_candidate(
        statement=counted_statement,
        notice=notice,
        extra=[business_day],
        attributes={"date": counted.isoformat(), "date_role": "eo_notice"},
        depends=[notice.id, business_day.id],
    )
    accepted, rejected = review_candidates([inference], documents)
    if rejected or not accepted:
        warnings.append(rejected[0].reason if rejected else "The business-day notice could not be cited.")
        return entries
    derived.append(inference)
    entries.append(
        CalendarEntry(
            id=stable_id("calendar", counted.isoformat(), "eo-notice"),
            kind="inference",
            domain="excess_and_obsolete" if about_inventory else "notice",
            description=inference.statement,
            date=counted.isoformat(),
            operative=True,
            citations=_quotes(notice, business_day),
            basis="Business days are the days the cited definition leaves in: Monday through Friday, with no holiday removed.",
            depends_on=[notice.id, business_day.id],
        )
    )
    return entries


def _anniversary(effective: date, year: int) -> tuple[date, bool]:
    try:
        return effective.replace(year=year), False
    except ValueError:
        return date(year, 2, 28), True


def _add_business_days(anchor: date, days: int) -> date:
    current = anchor
    remaining = days
    while remaining:
        current += timedelta(days=1)
        if current.weekday() < 5:
            remaining -= 1
    return current


def _inference_candidate(
    statement: str,
    notice: Fact,
    extra: list[Fact],
    attributes: dict[str, str | int | float | bool | None],
    depends: list[str],
) -> Candidate:
    first = notice.citations[0]
    candidate = Candidate(
        kind="inference",
        domain=notice.domain,
        statement=statement,
        operative=True,
        section=notice.section,
        document_id=first.document_id,
        document_name=first.document_name,
        quote=first.quote,
        attributes=attributes,
        depends_on=[item for item in depends if item],
    )
    for fact in extra:
        citation = fact.citations[0]
        if citation.quote == first.quote and citation.document_id == first.document_id:
            continue
        candidate.extra_quotes.append((citation.document_id, citation.document_name, citation.section, citation.quote))
    return candidate


def _from_fact(fact: Fact, iso: str, basis: str) -> CalendarEntry:
    return CalendarEntry(
        id=stable_id("calendar", fact.id, iso),
        kind="fact",
        domain=fact.domain,
        description=fact.statement,
        date=iso,
        operative=fact.operative,
        citations=list(fact.citations),
        basis=basis,
        depends_on=[fact.id],
    )


def _undated(fact: Fact, description: str) -> CalendarEntry:
    return CalendarEntry(
        id=stable_id("calendar", fact.id, "undated"),
        kind="fact",
        domain=fact.domain,
        description=description,
        date=None,
        operative=fact.operative,
        citations=list(fact.citations),
        basis="The cited text does not supply every date needed to count this deadline.",
        depends_on=[fact.id],
    )


def _quotes(*facts: Fact):
    citations = []
    seen: set[tuple[str, str]] = set()
    for fact in facts:
        for citation in fact.citations:
            key = (citation.document_id, citation.quote)
            if key in seen:
                continue
            seen.add(key)
            citations.append(citation)
    return citations


def _one(facts: list[Fact], key: str, value: str) -> Fact | None:
    matches = [fact for fact in facts if fact.operative and fact.attributes.get(key) == value]
    return matches[0] if matches else None


def _one_attr(facts: list[Fact], key: str) -> Fact | None:
    matches = [
        fact
        for fact in facts
        if fact.operative and key in fact.attributes and fact.attributes.get("conflicting") is not True
    ]
    values = {fact.attributes[key] for fact in matches}
    if len(values) != 1:
        return None
    return matches[-1]


def _business_day_rule(facts: list[Fact]) -> Fact | None:
    matches = [
        fact
        for fact in facts
        if fact.operative and fact.domain == "definition" and fact.attributes.get("defined_term") == "Business Day"
    ]
    return matches[-1] if matches else None
