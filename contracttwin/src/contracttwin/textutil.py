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
