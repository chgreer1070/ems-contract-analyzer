"""Apply amendments in effective-date order.

A later amendment replaces the same section number. Text that is not mentioned
stays in force from the base agreement. Replaced text is kept and marked as
no longer operative, so the earlier wording is still visible.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import date

from contracttwin.segment import TEXT_BOX_LABEL, segment
from contracttwin.textutil import AmbiguousAmendmentDate, UnreadableAmendmentDate, stated_amendment_effective_date

SECTION_REPLACEMENT_RE = re.compile(
    r"Section\s+(?P<num>\d+(?:\.\d+)*)\b[^\n]{0,120}?deleted and replaced in its entirety with the following:\s*\n+",
    re.IGNORECASE,
)
DEFINITION_REPLACEMENT_RE = re.compile(
    r"The definition of \"(?P<term>[^\"]+)\" in Section\s+(?P<num>\d+(?:\.\d+)*)\b[^\n]{0,120}?deleted and replaced with the following:\s*\n+",
    re.IGNORECASE,
)
# A change this reader does not apply. "deleted and replaced" keeps its own warning.
_UNREAD_CHANGE = re.compile(
    r"Section\s+\d+(?:\.\d+)*\b[^\n]{0,120}?\bis\s+(?:hereby\s+)?amended\b|\bsubstitut(?:e|ed|es|ing)\b",
    re.IGNORECASE,
)
# The next amendment instruction, not a lettered sentence inside the new section.
# A text-box label may sit between the line break and that instruction. The match
# is only the line break, so the replacement stays an exact slice of the source.
_TEXT_BOX_LABEL = re.escape(TEXT_BOX_LABEL)
NEXT_CLAUSE_RE = re.compile(
    rf"\n(?=(?:{_TEXT_BOX_LABEL})*[A-Z]\.\s+(?:Section\s+\d|The definition\b|Except\b))",
    re.IGNORECASE,
)


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

    ordered = _in_stated_date_order(amendments)
    for amendment in ordered:
        operations = _operations(amendment.text)
        if not operations and re.search(r"deleted and replaced", amendment.text, re.IGNORECASE):
            ledger.warnings.append(
                f"{amendment.name} mentions a replacement, but that replacement could not be read. The earlier section was left unchanged."
            )
        elif _has_unparsed_change(amendment.text):
            if operations:
                ledger.warnings.append(
                    f"{amendment.name} was not applied in full. An instruction was not a replacement this reading understands, "
                    "so that part was left unchanged."
                )
            else:
                ledger.warnings.append(
                    f"{amendment.name} was not applied. Its instructions were not a replacement this reading understands, "
                    "so the earlier text was left unchanged."
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


def _in_stated_date_order(amendments: list[PreparedDocument]) -> list[PreparedDocument]:
    """Place each amendment by the effective date written in that amendment.

    Selection order and a date typed in beside the file are not used. Two
    amendments that state the same date are refused: input order must not
    break the tie. An amendment that does not state a date is refused.
    """

    dated: list[tuple[date, PreparedDocument]] = []
    for amendment in amendments:
        label = amendment.filename or amendment.name
        try:
            stated = stated_amendment_effective_date(amendment.text)
        except AmbiguousAmendmentDate:
            raise ValueError(
                f"{label} names an Amendment Effective Date, but more than one date on that line could be that date, "
                "so the reading stopped."
            ) from None
        except UnreadableAmendmentDate:
            raise ValueError(
                f"{label} names an Amendment Effective Date, but that date could not be read, "
                "so the reading stopped. A later date was not used to place the amendment."
            ) from None
        if stated is None:
            raise ValueError(
                f"{label} has no stated effective date, so it was not read. "
                "An amendment is ordered only by the effective date written in that amendment."
            )
        dated.append((stated, amendment))
    by_date: dict[date, list[str]] = {}
    for stated, amendment in dated:
        by_date.setdefault(stated, []).append(amendment.filename or amendment.name)
    for stated, labels in by_date.items():
        if len(labels) < 2:
            continue
        shown = f"{labels[0]} and {labels[1]}" if len(labels) == 2 else ", ".join(labels[:-1]) + ", and " + labels[-1]
        raise ValueError(
            f"{shown} state the same effective date {stated.isoformat()}, "
            "so their order is ambiguous and the reading stopped."
        )
    return [amendment for _, amendment in sorted(dated, key=lambda item: item[0])]


def _covered_spans(text: str) -> list[tuple[int, int]]:
    spans: list[tuple[int, int]] = []
    for pattern in (SECTION_REPLACEMENT_RE, DEFINITION_REPLACEMENT_RE):
        for match in pattern.finditer(text):
            remainder = text[match.end() :]
            boundary = NEXT_CLAUSE_RE.search(remainder)
            end = match.end() + boundary.start() if boundary else len(text)
            spans.append((match.start(), end))
    return spans


def _has_unparsed_change(text: str) -> bool:
    """True when a section change sits outside a replacement this reader parsed."""

    covered = _covered_spans(text)
    return any(
        not any(start <= match.start() and match.end() <= end for start, end in covered)
        for match in _UNREAD_CHANGE.finditer(text)
    )


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
