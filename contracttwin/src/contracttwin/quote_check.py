"""Reject a statement whose cited words are not in the named document.

The check is exact. It does not ignore case, spacing, or punctuation.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from contracttwin.models import Citation, Fact, RejectedCandidate
from contracttwin.textutil import MIN_QUOTE_CHARS, stable_id


@dataclass
class Candidate:
    kind: str
    domain: str
    statement: str
    operative: bool
    section: str | None
    document_id: str | None
    document_name: str | None
    quote: str | None
    attributes: dict[str, str | int | float | bool | None] = field(default_factory=dict)
    extra_quotes: list[tuple[str, str, str, str | None]] = field(default_factory=list)
    depends_on: list[str] = field(default_factory=list)


def review_candidates(
    candidates: list[Candidate],
    documents: dict[str, tuple[str, str]],
) -> tuple[list[Fact], list[RejectedCandidate]]:
    """`documents` maps document id to (name, extracted text)."""

    accepted: list[Fact] = []
    rejected: list[RejectedCandidate] = []
    seen: set[str] = set()
    for candidate in candidates:
        citations, reason = _citations_for(candidate, documents)
        if reason is not None:
            rejected.append(
                RejectedCandidate(
                    statement=candidate.statement,
                    reason=reason,
                    document_id=candidate.document_id,
                    quote=candidate.quote,
                )
            )
            continue
        fact = Fact(
            id=_unique(candidate, seen),
            kind=_kind(candidate.kind),
            domain=_domain(candidate.domain),
            statement=candidate.statement,
            operative=candidate.operative,
            section=candidate.section,
            citations=citations,
            attributes=candidate.attributes,
            depends_on=list(candidate.depends_on),
        )
        accepted.append(fact)
    return accepted, rejected


def _citations_for(
    candidate: Candidate,
    documents: dict[str, tuple[str, str]],
) -> tuple[list[Citation], str | None]:
    quotes: list[tuple[str | None, str | None, str | None, str | None]] = [
        (candidate.document_id, candidate.document_name, candidate.section, candidate.quote)
    ]
    quotes.extend(candidate.extra_quotes)
    if not candidate.statement.strip():
        return [], "The statement was empty."
    citations: list[Citation] = []
    for document_id, document_name, section, quote in quotes:
        if quote is None or quote == "":
            if candidate.kind == "assumption":
                continue
            return [], "A fact or inference must cite the contract text it came from."
        if len(quote) < MIN_QUOTE_CHARS:
            return [], f"The citation is only {len(quote)} characters. A citation must be at least {MIN_QUOTE_CHARS} characters so a short fragment cannot pass."
        if document_id is None or document_id not in documents:
            return [], "The citation names a document that was not ingested."
        stored_name, stored_text = documents[document_id]
        if quote not in stored_text:
            return [], "The citation text was not found verbatim in the named document."
        citations.append(
            Citation(
                document_id=document_id,
                document_name=document_name or stored_name,
                section=section,
                quote=quote,
            )
        )
    if candidate.kind != "assumption" and not citations:
        return [], "A fact or inference must cite the contract text it came from."
    return citations, None


def _unique(candidate: Candidate, seen: set[str]) -> str:
    base = stable_id(
        candidate.kind,
        candidate.domain,
        candidate.statement,
        candidate.section or "",
        str(candidate.operative),
        candidate.quote or "",
    )
    ident = base
    counter = 2
    while ident in seen:
        ident = f"{base}-{counter}"
        counter += 1
    seen.add(ident)
    return ident


def _kind(value: str) -> str:
    if value not in {"fact", "inference", "assumption"}:
        raise ValueError(f"Unknown statement kind {value!r}.")
    return value


def _domain(value: str) -> str:
    allowed = {
        "pricing",
        "ncnr",
        "excess_and_obsolete",
        "notice",
        "definition",
        "survival",
        "precedence",
        "liability",
        "indemnity",
        "warranty",
        "termination",
        "forecast",
        "consignment",
        "general",
    }
    if value not in allowed:
        raise ValueError(f"Unknown domain {value!r}.")
    return value
