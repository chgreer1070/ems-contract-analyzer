"""Deterministic reading rules for the first-priority EMS terms.

The rules quote whole lines. They do not paraphrase a citation. A computed
date or dollar figure is not created here; later steps do that and label it.
"""

from __future__ import annotations

import re

from contracttwin.precedence import Ledger, SectionVersion
from contracttwin.quote_check import Candidate
from contracttwin.terms import term_candidates
from contracttwin.textutil import date_after_phrase, find_dates, parenthetical_agrees

DAYS_RE = re.compile(
    r"\b(?P<label>[A-Za-z][A-Za-z \-]{0,80}?)\s*\((?P<num>\d+)\)\s+(?P<unit>business days|days)\b",
    re.IGNORECASE,
)
PERCENT_RE = re.compile(
    r"\b(?P<label>[A-Za-z][A-Za-z \-]{0,80}?)\s+percent\s*\((?P<num>\d+(?:\.\d+)?)%\)",
    re.IGNORECASE,
)
PRICE_RE = re.compile(
    r"unit price for product (?P<sku>[A-Za-z0-9\-]+) is USD (?P<amount>\d+\.\d{2})",
    re.IGNORECASE,
)
DEFINITION_RE = re.compile(
    r"\"(?P<term>[^\"]+)\"(?:\s+or\s+\"(?P<alias>[^\"]+)\")?\s+means\s+(?P<meaning>.+)$"
)
SURVIVAL_RE = re.compile(
    r"Sections?\s+(?P<body>[0-9]+(?:\s*,\s*[0-9]+)*(?:\s*,?\s*and\s+[0-9]+)?)\s+survive",
    re.IGNORECASE,
)
EXPOSURE_RE = re.compile(
    r"(?P<what>Excess and Obsolete|margin|working capital|cash) exposure of USD (?P<amount>\d+\.\d{2})",
    re.IGNORECASE,
)
CROSS_RE = re.compile(r"Section\s+(\d+(?:\.\d+)*)")


def extract_rules(ledger: Ledger, amendments: list[tuple[str, str, str]]) -> tuple[list[Candidate], list[str]]:
    """`amendments` is (document_id, name, full text) in input order."""

    warnings: list[str] = []
    candidates: list[Candidate] = []
    if ledger.preamble is not None:
        candidates.extend(_preamble_facts(ledger.preamble, agreement=True))
    for versions in ledger.versions.values():
        for version in versions:
            candidates.extend(_section_facts(version, warnings))
    for document_id, name, text in amendments:
        for line in text.split("\n"):
            if "Amendment Effective Date" in line and find_dates(line):
                dated = _date_fact(line, document_id, name, "amendment_effective", None)
                if dated is not None:
                    candidates.append(dated)
            if "this Amendment controls" in line:
                candidates.append(
                    Candidate(
                        kind="fact",
                        domain="precedence",
                        statement="On and after its effective date, this amendment controls where it conflicts with the agreement.",
                        operative=True,
                        section=None,
                        document_id=document_id,
                        document_name=name,
                        quote=line,
                        attributes={"precedence": "amendment_controls"},
                    )
                )
    return candidates, warnings


def _preamble_facts(version: SectionVersion, agreement: bool) -> list[Candidate]:
    found: list[Candidate] = []
    for line in _lines(version.text):
        if "Amendment Effective Date" in line:
            continue
        # "Effective Date" also appears in the term sentence as a cross-reference.
        # Only a line that sets the date ("entered into" / "as of") is the effective date.
        sets_effective_date = "entered into" in line.lower() or "as of" in line.lower()
        if agreement and sets_effective_date and re.search(r"\bEffective Date\b", line):
            dated = _date_fact(line, version.document_id, version.document_name, "agreement_effective", version.number)
            if dated is not None:
                found.append(dated)
        if agreement and re.search(r"\buntil\b", line):
            dated = _date_fact(line, version.document_id, version.document_name, "term_end", version.number)
            if dated is not None:
                found.append(dated)
    return found


def _section_facts(version: SectionVersion, warnings: list[str]) -> list[Candidate]:
    found: list[Candidate] = []
    for line in _lines(version.text):
        found.extend(_definitions(line, version))
        found.extend(_days(line, version, warnings))
        found.extend(_percents(line, version, warnings))
        price = PRICE_RE.search(line)
        if price and not _span_is_historical(line, price.start(), price.end()):
            per_unit = "per unit" in line.lower()
            amount = price.group("amount")
            sku = price.group("sku")
            statement = (
                f"The unit price for product {sku} is USD {amount} per unit."
                if per_unit
                else f"The text states a price of USD {amount} for product {sku}."
            )
            found.append(
                Candidate(
                    kind="fact",
                    domain="pricing",
                    statement=statement,
                    operative=version.operative,
                    section=version.number,
                    document_id=version.document_id,
                    document_name=version.document_name,
                    quote=line,
                    attributes={
                        "sku": sku,
                        "unit_price": amount,
                        "currency": "USD",
                        "per_unit": per_unit,
                    },
                )
            )
        if not _line_negates_exposure(line):
            for exposure in EXPOSURE_RE.finditer(line):
                if _span_is_historical(line, exposure.start(), exposure.end()):
                    continue
                area = _explicit_area(exposure.group("what"))
                found.append(
                    Candidate(
                        kind="fact",
                        domain=_explicit_domain(area),
                        statement=f"The text states a {area.replace('_', ' ')} exposure of USD {exposure.group('amount')}.",
                        operative=version.operative,
                        section=version.number,
                        document_id=version.document_id,
                        document_name=version.document_name,
                        quote=line,
                        attributes={
                            "explicit_amount": exposure.group("amount"),
                            "explicit_currency": "USD",
                            "explicit_area": area,
                        },
                    )
                )
        survival = SURVIVAL_RE.search(line)
        if survival:
            numbers = ",".join(re.findall(r"\d+", survival.group("body")))
            found.append(
                Candidate(
                    kind="fact",
                    domain="survival",
                    statement=f"Sections {numbers.replace(',', ', ')} survive expiration or termination.",
                    operative=version.operative,
                    section=version.number,
                    document_id=version.document_id,
                    document_name=version.document_name,
                    quote=line,
                    attributes={"surviving_sections": numbers},
                )
            )
        if _is_obligation(line):
            found.append(
                Candidate(
                    kind="fact",
                    domain=_domain_for_line(line),
                    statement=line.strip(),
                    operative=version.operative,
                    section=version.number,
                    document_id=version.document_id,
                    document_name=version.document_name,
                    quote=line,
                    attributes={"obligation": True},
                )
            )
        if "calendar quarter ending" in line.lower():
            quarter_end = date_after_phrase(line, "ending")
            if quarter_end is not None:
                found.append(
                    Candidate(
                        kind="fact",
                        domain="notice",
                        statement=f"The text names the calendar quarter ending {quarter_end.isoformat()} for this notice.",
                        operative=version.operative,
                        section=version.number,
                        document_id=version.document_id,
                        document_name=version.document_name,
                        quote=line,
                        attributes={"quarter_end": quarter_end.isoformat()},
                    )
                )
        found.extend(term_candidates(line, version, warnings))
    return found


def _definitions(line: str, version: SectionVersion) -> list[Candidate]:
    match = DEFINITION_RE.search(line)
    if not match:
        return []
    terms = [match.group("term")]
    if match.group("alias"):
        terms.append(match.group("alias"))
    found: list[Candidate] = []
    for term in terms:
        attributes: dict[str, str | int | float | bool | None] = {"defined_term": term}
        day_match = DAYS_RE.search(match.group("meaning"))
        if day_match and parenthetical_agrees(day_match.group("label"), int(day_match.group("num"))):
            if _is_firm_or_ncnr(term, line):
                attributes["ncnr_days"] = int(day_match.group("num"))
        if "Business Day" in term:
            attributes["business_day_weekends_excluded"] = "Saturday" in line and "Sunday" in line
            attributes["business_day_holidays_excluded"] = "public holidays are not excluded" not in line.lower() and "holiday" in line.lower()
            if "public holidays are not excluded" in line.lower():
                attributes["business_day_holidays_excluded"] = False
        found.append(
            Candidate(
                kind="fact",
                domain="definition",
                statement=f'"{term}" means {match.group("meaning").strip()}',
                operative=version.operative,
                section=version.number,
                document_id=version.document_id,
                document_name=version.document_name,
                quote=line,
                attributes=attributes,
            )
        )
    return found


def _days(line: str, version: SectionVersion, warnings: list[str]) -> list[Candidate]:
    found: list[Candidate] = []
    for match in DAYS_RE.finditer(line):
        digits = int(match.group("num"))
        if not parenthetical_agrees(match.group("label"), digits):
            warnings.append(
                f"Section {version.number} writes a number that does not match the digits in parentheses, so that number was not used."
            )
            continue
        unit = match.group("unit").lower()
        domain, key = _day_key(line, unit, match.start(), match.end())
        if key is None:
            continue
        historical = _span_is_historical(line, match.start(), match.end())
        operative = version.operative and not historical
        attributes: dict[str, str | int | float | bool | None] = {key: digits}
        if key == "notice_business_days":
            anchor = date_after_phrase(line, "after") or date_after_phrase(line, "ending")
            if anchor is not None:
                attributes["anchor_date"] = anchor.isoformat()
                attributes["anchor_relation"] = "business_days_after"
            attributes["notice_topic"] = (
                "excess_and_obsolete"
                if any(word in line.lower() for word in ("excess and obsolete", "e&o", "obsolete"))
                else "general"
            )
        found.append(
            Candidate(
                kind="fact",
                domain=domain,
                statement=_day_statement(key, digits, operative, line),
                operative=operative,
                section=version.number,
                document_id=version.document_id,
                document_name=version.document_name,
                quote=line,
                attributes=attributes,
            )
        )
    return found


def _percents(line: str, version: SectionVersion, warnings: list[str]) -> list[Candidate]:
    found: list[Candidate] = []
    for match in PERCENT_RE.finditer(line):
        digits = float(match.group("num"))
        if not parenthetical_agrees(match.group("label"), int(digits)):
            warnings.append(
                f"Section {version.number} writes a percent that does not match the digits in parentheses, so that percent was not used."
            )
            continue
        if re.search(r"shall not exceed|not exceed|\bcap\b", line, re.IGNORECASE):
            domain = "pricing"
            key = "adjustment_cap_percent"
            statement = f"The annual price adjustment cap is {match.group('num')} percent."
        elif "reduc" in line.lower() or "flexib" in line.lower():
            domain = "ncnr"
            key = "flexibility_percent"
            statement = f"Forecast flexibility outside the firm period is {match.group('num')} percent."
        else:
            continue
        found.append(
            Candidate(
                kind="fact",
                domain=domain,
                statement=statement,
                operative=version.operative,
                section=version.number,
                document_id=version.document_id,
                document_name=version.document_name,
                quote=line,
                attributes={key: match.group("num")},
            )
        )
    return found


def _date_fact(line: str, document_id: str, document_name: str, role: str, section: str | None) -> Candidate | None:
    if role == "term_end":
        found = date_after_phrase(line, "until")
    else:
        found = date_after_phrase(line, "as of") or date_after_phrase(line, "entered into")
    if found is None:
        return None
    iso = found.isoformat()
    labels = {
        "agreement_effective": f"The agreement effective date is {iso}.",
        "amendment_effective": f"The amendment effective date is {iso}.",
        "term_end": f"The stated term runs until {iso}.",
    }
    return Candidate(
        kind="fact",
        domain="general",
        statement=labels[role],
        operative=True,
        section=section,
        document_id=document_id,
        document_name=document_name,
        quote=line,
        attributes={"date": iso, "date_role": role},
    )


def _day_key(line: str, unit: str, start: int, end: int) -> tuple[str, str | None]:
    window = line[max(0, start - 80) : min(len(line), end + 80)].lower()
    if unit == "business days" and "notice" in window:
        return "notice", "notice_business_days"
    if unit == "days" and ("invoice" in window or re.search(r"\bnet\b", window)):
        return "pricing", "net_days"
    if "non-cancellable" in window or "ncnr" in window or "firm period" in window:
        return "ncnr", "ncnr_days"
    if "notice" in window and unit == "days" and "anniversary" in window:
        return "notice", "notice_days_before_anniversary"
    if "notice" in window and unit == "days":
        return "notice", "notice_days"
    if "standard materials" in window:
        return "excess_and_obsolete", "standard_material_window_days"
    return "general", None


def _day_statement(key: str, digits: int, operative: bool, line: str) -> str:
    status = "Operative" if operative else "Superseded"
    if key == "net_days" and "invoice" in line.lower():
        payment = f"{status} payment term is {digits} days after the invoice date."
    elif key == "net_days":
        payment = f"{status} payment term is {digits} days."
    else:
        payment = ""
    statements = {
        "net_days": payment,
        "ncnr_days": f"{status} non-cancellable, non-returnable firm period is {digits} days.",
        "notice_business_days": f"{status} notice period is {digits} business days.",
        "notice_days_before_anniversary": f"{status} price notice must be given {digits} days before the anniversary.",
        "notice_days": f"{status} notice period is {digits} days.",
        "standard_material_window_days": f"{status} standard-material window is {digits} days.",
    }
    return statements[key]


def _span_is_historical(line: str, start: int, end: int) -> bool:
    """True when this number, not an earlier sentence, is described as already replaced."""

    window = line[start : min(len(line), end + 24)].lower()
    return bool(re.search(r"\b(no longer|formerly|previously|previous|superseded)\b", window))


def _line_negates_exposure(line: str) -> bool:
    return bool(re.search(r"\b(does not|do not|not state|never states|is not)\b", line, re.IGNORECASE))


def _domain_for_line(line: str) -> str:
    lowered = line.lower()
    if "indemnif" in lowered:
        return "indemnity"
    if "warrant" in lowered:
        return "warranty"
    if "consign" in lowered:
        return "consignment"
    if "terminat" in lowered:
        return "termination"
    if "forecast" in lowered or "end-of-life" in lowered or "end of life" in lowered or "last time buy" in lowered:
        return "forecast"
    if "liability" in lowered:
        return "liability"
    if "notice" in lowered:
        return "notice"
    if "excess and obsolete" in lowered or "e&o" in lowered or "inventory" in lowered:
        return "excess_and_obsolete"
    if "ncnr" in lowered or "non-cancellable" in lowered or "firm period" in lowered or "forecast" in lowered:
        return "ncnr"
    if "price" in lowered or "invoice" in lowered or "pay" in lowered:
        return "pricing"
    if "survive" in lowered:
        return "survival"
    return "general"


def _is_obligation(line: str) -> bool:
    return bool(re.search(r"\b(shall|must)\b", line, re.IGNORECASE))


def _is_firm_or_ncnr(term: str, line: str) -> bool:
    blob = f"{term} {line}".lower()
    return "firm period" in blob or "ncnr" in blob or "non-cancellable" in blob


def _explicit_area(phrase: str) -> str:
    lowered = phrase.lower()
    if lowered == "margin":
        return "margin"
    if lowered == "cash":
        return "cash"
    if lowered == "working capital":
        return "working_capital"
    return "inventory"


def _explicit_domain(area: str) -> str:
    if area == "inventory":
        return "excess_and_obsolete"
    return "pricing"


def _lines(text: str) -> list[str]:
    return [line for line in text.split("\n") if line.strip()]


def cross_references(version: SectionVersion) -> list[tuple[str, str]]:
    """Return (target section, quote line) pairs from one operative section."""

    found: list[tuple[str, str]] = []
    for line in _lines(version.text):
        for match in CROSS_RE.finditer(line):
            target = match.group(1)
            if target == version.number:
                continue
            found.append((target, line))
    return found
