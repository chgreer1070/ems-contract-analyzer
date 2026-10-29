"""More EMS terms, still quoted from the line they came from.

A dollar effect is not invented. If the sentence does not state the number
the question needs, the caller gets a warning that says it cannot be determined.
"""

from __future__ import annotations

import re

from contracttwin.precedence import SectionVersion
from contracttwin.quote_check import Candidate
from contracttwin.textutil import parenthetical_agrees

MONTHS_RE = re.compile(
    r"\b(?P<label>[A-Za-z][A-Za-z \-]{0,40}?)\s*\((?P<num>\d+)\)\s+months?\b",
    re.IGNORECASE,
)
PERCENT_RE = re.compile(
    r"\b(?P<label>[A-Za-z][A-Za-z \-]{0,40}?)\s+percent\s*\((?P<num>\d+(?:\.\d+)?)%\)",
    re.IGNORECASE,
)
DAYS_RE = re.compile(
    r"\b(?P<label>[A-Za-z][A-Za-z \-]{0,60}?)\s*\((?P<num>\d+)\)\s+days\b",
    re.IGNORECASE,
)
MONEY_RE = re.compile(r"USD (?P<amount>\d+\.\d{2})")
UNCAPPED_RE = re.compile(r"\b(uncapped|unlimited|without limitation|without limit)\b", re.IGNORECASE)
THIRD_PARTY_RE = re.compile(r"third[-\s]party", re.IGNORECASE)
CAPPED_RE = re.compile(r"shall not exceed|not exceed|subject to the liability cap|liability cap", re.IGNORECASE)


def term_candidates(line: str, version: SectionVersion, warnings: list[str]) -> list[Candidate]:
    if len(line.strip()) < 20:
        return []
    found: list[Candidate] = []
    found.extend(_liability(line, version))
    found.extend(_indemnity(line, version, warnings))
    found.extend(_warranty(line, version, warnings))
    found.extend(_termination(line, version))
    found.extend(_forecast(line, version, warnings))
    found.extend(_consignment(line, version, warnings))
    found.extend(_late_fee(line, version, warnings))
    return found


def _liability(line: str, version: SectionVersion) -> list[Candidate]:
    found: list[Candidate] = []
    lowered = line.lower()
    if "indirect, incidental, special, or consequential" in lowered:
        found.append(_fact(version, "liability", "The text excludes indirect, incidental, special, and consequential damages.", line, {}))
    if "aggregate liability" in lowered or "limitation of liability" in lowered:
        amount = MONEY_RE.search(line)
        if amount and CAPPED_RE.search(line):
            found.append(
                _fact(
                    version,
                    "liability",
                    f"The liability cap stated in the text is USD {amount.group('amount')}.",
                    line,
                    {"liability_cap_amount": amount.group("amount"), "currency": "USD"},
                )
            )
        elif CAPPED_RE.search(line):
            found.append(
                _fact(
                    version,
                    "liability",
                    "The text caps liability, but the dollar cap cannot be determined because no dollar amount is stated.",
                    line,
                    {},
                )
            )
    return found


def _indemnity(line: str, version: SectionVersion, warnings: list[str]) -> list[Candidate]:
    if not re.search(r"indemnif", line, re.IGNORECASE):
        return []
    third_party = THIRD_PARTY_RE.search(line) is not None
    uncapped = UNCAPPED_RE.search(line) is not None
    capped = CAPPED_RE.search(line) is not None
    attributes: dict[str, str | int | float | bool | None] = {
        "third_party": third_party,
        "uncapped": uncapped,
    }
    if third_party and uncapped:
        attributes["walk_away"] = True
        warnings.append(
            f"Section {version.number}: Possible walk-away. The text states a third-party indemnity without a cap."
        )
    elif third_party and not capped:
        warnings.append(
            f"Section {version.number}: Possible walk-away. A third-party indemnity is stated, and a cap cannot be determined from this sentence."
        )
    return [_fact(version, "indemnity", line.strip(), line, attributes)]


def _warranty(line: str, version: SectionVersion, warnings: list[str]) -> list[Candidate]:
    if not re.search(r"warrant", line, re.IGNORECASE):
        return []
    attributes: dict[str, str | int | float | bool | None] = {}
    months = MONTHS_RE.search(line)
    if months and parenthetical_agrees(months.group("label"), int(months.group("num"))):
        attributes["warranty_months"] = int(months.group("num"))
    if re.search(r"repair or replace", line, re.IGNORECASE):
        attributes["warranty_remedy"] = "repair or replace"
    warnings.append(
        f"Section {version.number}: The warranty dollar reserve cannot be determined because the text states no failure rate or cost."
    )
    statement = "The text states a warranty."
    if "warranty_months" in attributes:
        statement = f"The warranty period stated in the text is {attributes['warranty_months']} months."
    return [_fact(version, "warranty", statement, line, attributes)]


def _termination(line: str, version: SectionVersion) -> list[Candidate]:
    if not re.search(r"terminat", line, re.IGNORECASE):
        return []
    attributes: dict[str, str | int | float | bool | None] = {}
    if re.search(r"for convenience", line, re.IGNORECASE):
        attributes["termination_kind"] = "convenience"
    elif re.search(r"for cause", line, re.IGNORECASE):
        attributes["termination_kind"] = "cause"
    days = DAYS_RE.search(line)
    if days and parenthetical_agrees(days.group("label"), int(days.group("num"))):
        attributes["termination_notice_days"] = int(days.group("num"))
    if not attributes:
        return []
    days_text = attributes.get("termination_notice_days")
    kind = attributes.get("termination_kind") or "termination"
    statement = f"The text states a {kind} termination"
    if isinstance(days_text, int):
        statement += f" on {days_text} days' notice"
    statement += "."
    return [_fact(version, "termination", statement, line, attributes)]


def _forecast(line: str, version: SectionVersion, warnings: list[str]) -> list[Candidate]:
    lowered = line.lower()
    if not any(phrase in lowered for phrase in ("rolling", "last time buy", "last-time-buy", "end-of-life", "end of life")) and "eol" not in lowered:
        return []
    attributes: dict[str, str | int | float | bool | None] = {}
    months = MONTHS_RE.search(line)
    if months and "forecast" in lowered and parenthetical_agrees(months.group("label"), int(months.group("num"))):
        attributes["forecast_months"] = int(months.group("num"))
    days = DAYS_RE.search(line)
    if days and parenthetical_agrees(days.group("label"), int(days.group("num"))):
        if "end-of-life" in lowered or "end of life" in lowered or re.search(r"\beol\b", lowered):
            attributes["eol_notice_days"] = int(days.group("num"))
        if "last time buy" in lowered or "last-time-buy" in lowered:
            attributes["last_time_buy"] = True
    if "forecast" in lowered:
        warnings.append(
            f"Section {version.number}: The forecast volume cannot be determined because the text states no quantities."
        )
    statement = "The text states a forecast or end-of-life supply term."
    if "forecast_months" in attributes:
        statement = f"The rolling forecast stated in the text covers {attributes['forecast_months']} months."
    elif "eol_notice_days" in attributes:
        statement = f"End-of-life notice stated in the text is {attributes['eol_notice_days']} days."
    return [_fact(version, "forecast", statement, line, attributes)]


def _consignment(line: str, version: SectionVersion, warnings: list[str]) -> list[Candidate]:
    if not re.search(r"consign", line, re.IGNORECASE):
        return []
    if not re.search(r"\b(shall|title|remains|risk)\b", line, re.IGNORECASE):
        return []
    warnings.append(
        f"Section {version.number}: The dollar value of consigned inventory cannot be determined because the text states no quantity or cost."
    )
    return [_fact(version, "consignment", line.strip(), line, {"consigned": True})]


def _late_fee(line: str, version: SectionVersion, warnings: list[str]) -> list[Candidate]:
    if not re.search(r"\blate\b", line, re.IGNORECASE):
        return []
    percent = PERCENT_RE.search(line)
    if percent is None or not parenthetical_agrees(percent.group("label"), int(float(percent.group("num")))):
        return []
    warnings.append(
        f"Section {version.number}: The dollar late fee cannot be determined because the text states no unpaid balance."
    )
    return [
        _fact(
            version,
            "pricing",
            f"The late fee stated in the text is {percent.group('num')} percent per month.",
            line,
            {"late_fee_percent": percent.group("num")},
        )
    ]


def _fact(
    version: SectionVersion,
    domain: str,
    statement: str,
    line: str,
    attributes: dict[str, str | int | float | bool | None],
) -> Candidate:
    return Candidate(
        kind="fact",
        domain=domain,
        statement=statement,
        operative=version.operative,
        section=version.number,
        document_id=version.document_id,
        document_name=version.document_name,
        quote=line,
        attributes=attributes,
    )
