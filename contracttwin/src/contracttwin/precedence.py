"""Apply amendments in effective-date order.

A later amendment replaces the same section number. Text that is not mentioned
stays in force from the base agreement. Replaced text is kept and marked as
no longer operative, so the earlier wording is still visible.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

SECTION_REPLACEMENT_RE = re.compile(
    r"Section\s+(?P<num>\d+(?:\.\d+)*)\b[^\n]{0,120}?deleted and replaced in its entirety with the following:\s*\n+",
    re.IGNORECASE,
)
DEFINITION_REPLACEMENT_RE = re.compile(
    r"The definition of \"(?P<term>[^\"]+)\" in Section\s+(?P<num>\d+(?:\.\d+)*)\b[^\n]{0,120}?deleted and replaced with the following:\s*\n+",
    re.IGNORECASE,
)
# The next amendment instruction, not a lettered sentence inside the new section.
NEXT_CLAUSE_RE = re.compile(r"\n(?=[A-Z]\.\s+(?:Section\s+\d|The definition\b|Except\b))", re.IGNORECASE)


@dataclass
class SectionVersion:
    number: str
    title: str
    text: str
    document_id: str
    document_name: str
    operative: bool
    superseded_by_document_id: str | None = None
    survives_termination: bool = False


@dataclass
class PreparedDocument:
    document_id: str
    name: str
    role: str
    text: str
    manifest_effective_date: str | None
    filename: str | None = None
    order: int = 0


@dataclass
class Ledger:
    versions: dict[str, list[SectionVersion]] = field(default_factory=dict)
    preamble: SectionVersion | None = None
    warnings: list[str] = field(default_factory=list)


def build_ledger(base: PreparedDocument, amendments: list[PreparedDocument]) -> Ledger:
    from contracttwin.segment import segment

    preamble, sections = segment(base.text)
    ledger = Ledger()
    if preamble is not None:
        ledger.preamble = SectionVersion(
            number="Preamble",
            title="Preamble",
            text=preamble.text,
            document_id=base.document_id,
            document_name=base.name,
            operative=True,
        )
    for section in sections:
        ledger.versions.setdefault(section.number, []).append(
            SectionVersion(
                number=section.number,
                title=section.title,
                text=section.text,
                document_id=base.document_id,
                document_name=base.name,
                operative=True,
            )
        )

    ordered = sorted(amendments, key=lambda item: (item.manifest_effective_date or "9999-12-31", item.order))
    for amendment in ordered:
        if amendment.manifest_effective_date is None:
            ledger.warnings.append(
                f"{amendment.name} has no effective date, so it was applied after dated amendments."
            )
        operations = _operations(amendment.text)
        if not operations and re.search(r"deleted and replaced", amendment.text, re.IGNORECASE):
            ledger.warnings.append(
                f"{amendment.name} mentions a replacement, but that replacement could not be read. The earlier section was left unchanged."
            )
        for start, number, body in operations:
            if not body:
                ledger.warnings.append(
                    f"{amendment.name} says it replaces section {number}, but the replacement text was empty."
                )
                continue
            if body not in amendment.text:
                raise RuntimeError("Amendment replacement was not a verbatim slice of the amendment.")
            _replace(ledger, number, body, amendment, start)
    return ledger


def _operations(text: str) -> list[tuple[int, str, str]]:
    found: list[tuple[int, str, str]] = []
    for match in SECTION_REPLACEMENT_RE.finditer(text):
        body = _body_after(text, match.end())
        found.append((match.start(), match.group("num"), body))
    for match in DEFINITION_REPLACEMENT_RE.finditer(text):
        body = _body_after(text, match.end())
        found.append((match.start(), match.group("num"), body))
    found.sort(key=lambda item: item[0])
    return found


def _body_after(text: str, start: int) -> str:
    remainder = text[start:]
    boundary = NEXT_CLAUSE_RE.search(remainder)
    end = start + boundary.start() if boundary else len(text)
    return text[start:end].strip("\n")


def _replace(
    ledger: Ledger,
    number: str,
    body: str,
    amendment: PreparedDocument,
    _start: int,
) -> None:
    title = _title_from_body(number, body)
    existing = ledger.versions.get(number, [])
    if not existing:
        ledger.warnings.append(
            f"{amendment.name} replaces section {number}, which was not in the base agreement. The new text was added."
        )
    for version in existing:
        if version.operative:
            version.operative = False
            version.superseded_by_document_id = amendment.document_id
    ledger.versions.setdefault(number, []).append(
        SectionVersion(
            number=number,
            title=title,
            text=body,
            document_id=amendment.document_id,
            document_name=amendment.name,
            operative=True,
        )
    )


def _title_from_body(number: str, body: str) -> str:
    first = body.split("\n", 1)[0].strip()
    prefix = f"{number}."
    if first.startswith(prefix):
        first = first[len(prefix) :].strip()
    return first or number
