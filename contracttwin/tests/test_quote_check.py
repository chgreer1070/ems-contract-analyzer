"""The quote checker keeps only citations that appear exactly in the named document."""

from __future__ import annotations

from contracttwin.quote_check import Candidate, review_candidates

DOCUMENTS = {"doc-base": ("Harborline MSA", "Customer shall pay each undisputed invoice within forty-five (45) days after the invoice date.")}


def test_verbatim_quote_is_kept() -> None:
    quote = "Customer shall pay each undisputed invoice within forty-five (45) days after the invoice date."
    accepted, rejected = review_candidates([_candidate(quote)], DOCUMENTS)
    assert rejected == []
    assert accepted[0].citations[0].quote == quote


def test_paraphrase_is_rejected() -> None:
    accepted, rejected = review_candidates([_candidate("Customer pays invoices within forty-five days.")], DOCUMENTS)
    assert accepted == []
    assert "verbatim" in rejected[0].reason


def test_quote_from_the_wrong_document_is_rejected() -> None:
    candidate = _candidate("Customer shall pay each undisputed invoice within forty-five (45) days after the invoice date.")
    candidate.document_id = "doc-amendment-1"
    accepted, rejected = review_candidates([candidate], DOCUMENTS)
    assert accepted == []
    assert rejected[0].reason


def test_short_fragment_is_rejected() -> None:
    accepted, rejected = review_candidates([_candidate("Net 45")], DOCUMENTS)
    assert accepted == []
    assert "at least" in rejected[0].reason


def test_fact_without_a_quote_is_rejected() -> None:
    candidate = _candidate("The payment term is 45 days.")
    candidate.quote = None
    accepted, rejected = review_candidates([candidate], DOCUMENTS)
    assert accepted == []
    assert "cite" in rejected[0].reason


def test_changed_capitalization_is_not_verbatim() -> None:
    accepted, rejected = review_candidates(
        [_candidate("customer shall pay each undisputed invoice within forty-five (45) days after the invoice date.")],
        DOCUMENTS,
    )
    assert accepted == []
    assert rejected


def _candidate(quote: str) -> Candidate:
    return Candidate(
        kind="fact",
        domain="pricing",
        statement="Payment term extracted for the test.",
        operative=True,
        section="2.2",
        document_id="doc-base",
        document_name="Harborline MSA",
        quote=quote,
    )
