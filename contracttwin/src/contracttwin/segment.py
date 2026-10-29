"""Split an agreement into numbered sections without changing the words."""

from __future__ import annotations

import re
from dataclasses import dataclass

# Accepts "1. Title", "1.1 Title", and "1.1. Title".
HEADER_RE = re.compile(r"^(?P<num>\d+(?:\.\d+)*)(?:\.|\s)\s*(?P<title>\S.*)$")


@dataclass(frozen=True)
class SectionSlice:
    number: str
    title: str
    text: str
    start: int
    end: int


def segment(text: str) -> tuple[SectionSlice | None, list[SectionSlice]]:
    """Return the preamble and numbered sections.

    Each section's text is an exact slice of `text`, so a citation can quote it.
    """

    line_spans = _line_spans(text)
    header_indexes = [index for index, (_, _, content) in enumerate(line_spans) if HEADER_RE.match(content)]
    if not header_indexes:
        preamble = _slice(text, 0, len(text))
        if preamble is None:
            return None, []
        return SectionSlice("Preamble", "Preamble", preamble, 0, len(preamble)), []

    first_header_start = line_spans[header_indexes[0]][0]
    preamble_text = _slice(text, 0, first_header_start)
    preamble = None
    if preamble_text is not None:
        preamble = SectionSlice("Preamble", "Preamble", preamble_text, 0, len(preamble_text))

    sections: list[SectionSlice] = []
    for position, line_index in enumerate(header_indexes):
        start = line_spans[line_index][0]
        end = line_spans[header_indexes[position + 1]][0] if position + 1 < len(header_indexes) else len(text)
        body = _slice(text, start, end)
        if body is None:
            continue
        match = HEADER_RE.match(line_spans[line_index][2])
        if match is None:
            continue
        title = match.group("title").strip() or match.group("num")
        sections.append(
            SectionSlice(
                number=match.group("num"),
                title=title,
                text=body,
                start=start,
                end=start + len(body),
            )
        )
    return preamble, sections


def _line_spans(text: str) -> list[tuple[int, int, str]]:
    spans: list[tuple[int, int, str]] = []
    cursor = 0
    for raw in text.split("\n"):
        spans.append((cursor, cursor + len(raw), raw))
        cursor += len(raw) + 1
    return spans


def _slice(text: str, start: int, end: int) -> str | None:
    snippet = text[start:end].strip("\n")
    if not snippet.strip():
        return None
    if snippet not in text:
        raise RuntimeError("Section slice was not found verbatim in the source.")
    return snippet
