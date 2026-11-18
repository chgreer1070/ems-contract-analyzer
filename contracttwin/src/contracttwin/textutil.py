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
_TEXT_BOX_PREFIX = "[text box] "
_LABEL_HEAD = re.compile(
    r'^(?P<label>\((?:the|this)\s*"Amendment Effective Date"\)?)(?P<rest>.*)$',
    re.IGNORECASE,
)
_YEAR_LABEL_HEAD = re.compile(
    r'^(?P<label>\d{4}\s*\((?:the|this)\s*"Amendment Effective Date"\)?)(?P<rest>.*)$',
    re.IGNORECASE,
)
_PAREN_LABEL = re.compile(r'\((?:the|this)\s*"Amendment Effective Date"', re.IGNORECASE)
_MONTH_DAY_TAIL = re.compile(
    r"(?:January|February|March|April|May|June|July|August|September|October|November|December)"
    r"\s+\d{1,2},\s*$",
    re.IGNORECASE,
)
_REPLACEMENT_BOUNDARY = re.compile(r"deleted\s+and\s+replaced", re.IGNORECASE)


class AmbiguousAmendmentDate(Exception):
    """More than one date on a line could be the Amendment Effective Date."""


class UnreadableAmendmentDate(Exception):
    """The Amendment Effective Date label is present, but its date cannot be read."""


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


def _without_text_box(line: str) -> str:
    body = line
    while body.startswith(_TEXT_BOX_PREFIX):
        body = body[len(_TEXT_BOX_PREFIX) :]
    return body


def _line_ends_with_introduced_date(line: str) -> bool:
    """True when the line's last date is introduced and nothing follows it but punctuation."""

    spans = _date_spans(line)
    if not spans:
        return False
    date_start, date_end, _value = spans[-1]
    trailing = line[date_end:]
    if trailing.strip() and re.fullmatch(r"[\s,.;:]*", trailing) is None:
        return False
    previous_end = spans[-2][1] if len(spans) > 1 else 0
    return _introduced(line[previous_end:date_start])


def _incomplete_month_is_introduced(line: str) -> bool:
    """True when the line ends with 'June 1,' and that fragment is introduced."""

    match = _MONTH_DAY_TAIL.search(line.rstrip())
    if match is None:
        return False
    spans = _date_spans(line)
    previous_end = spans[-1][1] if spans else 0
    return _introduced(line[previous_end : match.start()])


def _label_to_attach(current: str, following: str) -> tuple[str, str] | None:
    """The label words to attach, and any words that stay on their own line.

    Only the label is attached. A later date on that same physical line stays
    separate, so it cannot make the opening look ambiguous. A line that already
    names the label is left alone.
    """

    current_body = _without_text_box(current)
    if _LABEL in current_body:
        return None
    following_body = _without_text_box(following).lstrip()
    if _line_ends_with_introduced_date(current_body):
        head = _LABEL_HEAD.match(following_body)
        if head is not None:
            return head.group("label"), head.group("rest")
    if _incomplete_month_is_introduced(current_body):
        head = _YEAR_LABEL_HEAD.match(following_body)
        if head is not None:
            return head.group("label"), head.group("rest")
    return None


def _next_label_line(lines: list[str], index: int) -> int | None:
    following = index + 1
    if following < len(lines) and lines[following].strip() == "" and following + 1 < len(lines):
        following += 1
    if following < len(lines):
        return following
    return None


def _rejoin_wrapped_declarations(text: str) -> str:
    """Put a wrapped opening date and its label back on one line.

    One blank line between them is still the same declaration. Words after the
    label stay on the next line. A later repeat of the label does not move the
    first date.
    """

    lines = text.split("\n")
    joined: list[str] = []
    index = 0
    while index < len(lines):
        following = _next_label_line(lines, index)
        attached = _label_to_attach(lines[index], lines[following]) if following is not None else None
        if attached is None or following is None:
            joined.append(lines[index])
            index += 1
            continue
        label, rest = attached
        joined.append(lines[index].rstrip() + " " + label)
        leftover = rest.strip()
        if leftover:
            joined.append(leftover)
        index = following + 1
    return "\n".join(joined)


def joined_declaration(lines: list[str], index: int) -> tuple[date, int] | None:
    """The date on `lines[index]` when its label starts on a following line.

    The second value is the index of that label line. None when this line
    already contains the label, or the following lines are not that label.
    """

    following = _next_label_line(lines, index)
    if following is None:
        return None
    attached = _label_to_attach(lines[index], lines[following])
    if attached is None:
        return None
    label, _rest = attached
    found = amendment_effective_date_on_line(_without_text_box(lines[index]).rstrip() + " " + label)
    if found is None:
        return None
    return found, following


def _opening_date(text: str) -> date | None:
    if _PAREN_LABEL.search(_without_text_box(text)) is None:
        return None
    return amendment_effective_date_on_line(text)


def _unreadable_label(text: str) -> bool:
    """True when the line names the label and does not contain a complete date."""

    body = _without_text_box(text)
    if _PAREN_LABEL.search(body) is None:
        return False
    return not _date_spans(body)


def stated_amendment_effective_date(text: str) -> date | None:
    """The first effective date this amendment states for itself.

    A line counts when it names "Amendment Effective Date" and one date on
    that line is the date the label names. A date and its label on neighboring
    lines are read as one declaration, because PDF extraction keeps the line
    break. The fact reader uses the same wrap. A date for the original
    agreement on the same line does not place the amendment. A later line that
    repeats the label does not move the first date. A line where more than one
    date could be the label is refused. A label with no readable date is
    refused as well, instead of letting a date inside later replacement text
    place the amendment.
    """

    logical = _rejoin_wrapped_declarations(normalize_newlines(text))
    boundary = _REPLACEMENT_BOUNDARY.search(logical)
    boundary_at = boundary.start() if boundary else None
    saw_unreadable = False
    position = 0
    for line in logical.split("\n"):
        phrase = _REPLACEMENT_BOUNDARY.search(line)
        opening = line[: phrase.start()] if phrase else line
        found = _opening_date(opening)
        inside_replacement = boundary_at is not None and phrase is None and position >= boundary_at
        if found is not None:
            if saw_unreadable and inside_replacement:
                raise UnreadableAmendmentDate
            return found
        if _unreadable_label(opening):
            saw_unreadable = True
        if phrase is not None and not saw_unreadable:
            tail_found = _opening_date(line[phrase.end() :])
            if tail_found is not None:
                return tail_found
        if saw_unreadable and (phrase is not None or inside_replacement):
            raise UnreadableAmendmentDate
        position += len(line) + 1
    if saw_unreadable:
        raise UnreadableAmendmentDate
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
