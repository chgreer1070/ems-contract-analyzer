"""Small text helpers. Newlines are normalized. Words and case are not."""

from __future__ import annotations

import hashlib
import re
from datetime import date, datetime

MAX_DOCUMENT_CHARS = 2_000_000
MIN_QUOTE_CHARS = 20

_MONTHS = {
    "january": 1,
    "february": 2,
    "march": 3,
    "april": 4,
    "may": 5,
    "june": 6,
    "july": 7,
    "august": 8,
    "september": 9,
    "october": 10,
    "november": 11,
    "december": 12,
}

_NUMBER_WORDS = {
    "zero": 0,
    "one": 1,
    "two": 2,
    "three": 3,
    "four": 4,
    "five": 5,
    "six": 6,
    "seven": 7,
    "eight": 8,
    "nine": 9,
    "ten": 10,
    "eleven": 11,
    "twelve": 12,
    "thirteen": 13,
    "fourteen": 14,
    "fifteen": 15,
    "sixteen": 16,
    "seventeen": 17,
    "eighteen": 18,
    "nineteen": 19,
    "twenty": 20,
    "thirty": 30,
    "forty": 40,
    "forty-five": 45,
    "fifty": 50,
    "sixty": 60,
    "seventy": 70,
    "eighty": 80,
    "ninety": 90,
    "one hundred": 100,
    "one hundred twenty": 120,
    "one hundred twenty-five": 125,
    "one hundred eighty": 180,
}

DATE_RE = re.compile(
    r"\b(January|February|March|April|May|June|July|August|September|October|November|December)"
    r"\s+(\d{1,2}),\s+(\d{4})\b"
)
ISO_DATE_RE = re.compile(r"\b(\d{4})-(\d{2})-(\d{2})\b")


def normalize_newlines(text: str) -> str:
    if text.startswith("\ufeff"):
        text = text[1:]
    return text.replace("\r\n", "\n").replace("\r", "\n")


def sha256_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def stable_id(prefix: str, *parts: str) -> str:
    digest = hashlib.sha256("\n".join(parts).encode("utf-8")).hexdigest()[:12]
    return f"{prefix}-{digest}"


def parse_iso_date(value: str) -> date:
    try:
        return datetime.strptime(value, "%Y-%m-%d").date()
    except ValueError as exc:
        raise ValueError(f"Dates must be YYYY-MM-DD. Received {value!r}.") from exc


def iter_dates(text: str) -> list[tuple[int, date]]:
    """Dates in the order they appear. Impossible dates such as February 31 are skipped."""

    found: list[tuple[int, date]] = []
    for match in DATE_RE.finditer(text):
        try:
            found.append(
                (
                    match.start(),
                    date(int(match.group(3)), _MONTHS[match.group(1).lower()], int(match.group(2))),
                )
            )
        except ValueError:
            continue
    for match in ISO_DATE_RE.finditer(text):
        try:
            found.append((match.start(), date(int(match.group(1)), int(match.group(2)), int(match.group(3)))))
        except ValueError:
            continue
    found.sort(key=lambda item: item[0])
    return found


def find_dates(text: str) -> list[date]:
    return [value for _, value in iter_dates(text)]


def date_after_phrase(text: str, phrase: str) -> date | None:
    """The first real date that starts at or after `phrase`."""

    index = text.lower().find(phrase.lower())
    if index < 0:
        return None
    for position, value in iter_dates(text):
        if position >= index:
            return value
    return None


_LABEL = "Amendment Effective Date"
_DEFINITION_GAP = re.compile(r'^[\s,]*\((?:the|this)\s*"$')
_INTRODUCER = re.compile(r"(?:as of|entered into)\b", re.IGNORECASE)


class AmbiguousAmendmentDate(Exception):
    """More than one date on a line could be the Amendment Effective Date."""


def _date_spans(text: str) -> list[tuple[int, int, date]]:
    spans: list[tuple[int, int, date]] = []
    for match in DATE_RE.finditer(text):
        try:
            value = date(int(match.group(3)), _MONTHS[match.group(1).lower()], int(match.group(2)))
        except ValueError:
            continue
        spans.append((match.start(), match.end(), value))
    for match in ISO_DATE_RE.finditer(text):
        try:
            value = date(int(match.group(1)), int(match.group(2)), int(match.group(3)))
        except ValueError:
            continue
        spans.append((match.start(), match.end(), value))
    spans.sort(key=lambda item: item[0])
    return spans


def _introduced(region: str) -> bool:
    """True when `region` ends with "as of" or "entered into" and no date sits between."""

    matches = list(_INTRODUCER.finditer(region))
    if not matches:
        return False
    return not find_dates(region[matches[-1].end() :])


def amendment_effective_date_on_line(line: str) -> date | None:
    """The date this line's Amendment Effective Date label names.

    The label names the date written immediately before it, as in
    `(the "Amendment Effective Date")`, when "as of" or "entered into"
    introduces that date. A single introduced date on the line is that date
    as well. More than one date that could be the label is refused.
    """

    if _LABEL not in line:
        return None
    spans = _date_spans(line)
    if not spans:
        return None
    label_positions: list[int] = []
    start = 0
    while True:
        found = line.find(_LABEL, start)
        if found < 0:
            break
        label_positions.append(found)
        start = found + len(_LABEL)
    parenthetical: list[date] = []
    introduced_parenthetical: list[date] = []
    for label_pos in label_positions:
        before = [span for span in spans if span[1] <= label_pos]
        if not before:
            continue
        date_start, date_end, value = before[-1]
        previous_end = before[-2][1] if len(before) > 1 else 0
        gap = line[date_end:label_pos]
        if not _DEFINITION_GAP.fullmatch(gap):
            continue
        parenthetical.append(value)
        if _introduced(line[previous_end:date_start]):
            introduced_parenthetical.append(value)
    unique_parenthetical = list(dict.fromkeys(parenthetical))
    if len(unique_parenthetical) > 1:
        raise AmbiguousAmendmentDate
    if len(introduced_parenthetical) == 1:
        return introduced_parenthetical[0]
    if unique_parenthetical:
        if len(spans) > 1:
            raise AmbiguousAmendmentDate
        return None
    introduced: list[date] = []
    cursor = 0
    for date_start, date_end, value in spans:
        if _introduced(line[cursor:date_start]):
            introduced.append(value)
        cursor = date_end
    unique_introduced = list(dict.fromkeys(introduced))
    if len(unique_introduced) > 1 or (len(unique_introduced) == 1 and len(spans) > 1):
        raise AmbiguousAmendmentDate
    if len(unique_introduced) == 1:
        return unique_introduced[0]
    return None


def stated_amendment_effective_date(text: str) -> date | None:
    """The first effective date this amendment states for itself.

    A line counts when it names "Amendment Effective Date" and one date on
    that line is the date the label names. The fact reader uses the same
    association on each line. A date for the original agreement on the same
    line does not place the amendment. A later line that repeats the label
    does not move the first date. A line where more than one date could be
    the label is refused.
    """

    for line in text.split("\n"):
        found = amendment_effective_date_on_line(line)
        if found is not None:
            return found
    return None


def trailing_number_words(label: str) -> int | None:
    """Read the number words at the end of a label, such as 'at least sixty'."""

    tokens = re.findall(r"[a-z]+(?:-[a-z]+)?", label.lower())
    if not tokens:
        return None
    for length in range(min(4, len(tokens)), 0, -1):
        phrase = " ".join(tokens[-length:])
        if phrase in _NUMBER_WORDS:
            return _NUMBER_WORDS[phrase]
    return None


def parenthetical_agrees(label: str, digits: int) -> bool:
    """True when the written number is missing or matches the digits in parentheses.

    'sixty (45)' is a conflict and is not accepted. 'within sixty (60)' is accepted.
    """

    words = trailing_number_words(label)
    return words is None or words == digits
