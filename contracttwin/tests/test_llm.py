"""A model may add a fact only when its quote is copied exactly and still in force."""

from __future__ import annotations

from contracttwin.llm import ExtractorUnavailable, OptionalLlmExtractor
from contracttwin.pipeline import AnalysisRequest, analyze
from contracttwin.quote_check import Candidate

BASE = """CONTRACT

This Contract is entered into as of January 15, 2024 (the "Effective Date").

1. Pricing

1.1 Payment. Customer shall pay each undisputed invoice within forty-five (45) days after the invoice date (Net 45).
"""

AMENDMENT = """AMENDMENT NO. 1

This Amendment No. 1 is entered into as of March 1, 2025 (the "Amendment Effective Date").

If this Amendment conflicts with the Agreement, this Amendment controls on and after the Amendment Effective Date.

A. Section 1.1 of the Agreement is deleted and replaced in its entirety with the following:

1.1 Payment. Customer shall pay each undisputed invoice within sixty (60) days after the invoice date (Net 60).

E. Except as amended above, the Agreement remains in full force.
"""


class ScriptedExtractor:
    name = "llm"

    def __init__(self, candidates: list[Candidate] | None = None, fail: bool = False) -> None:
        self.candidates = candidates or []
        self.fail = fail

    def extract(self, documents) -> list[Candidate]:
        del documents
        if self.fail:
            raise ExtractorUnavailable("No model key is configured. The rule reading was used.")
        return self.candidates


def test_rules_still_run_when_the_model_is_unavailable() -> None:
    result = analyze(
        AnalysisRequest(
            base_name="Base",
            base_text=BASE,
            amendments=[("Amendment No. 1", AMENDMENT, "2025-03-01")],
            extractor=ScriptedExtractor(fail=True),
        )
    )
    assert result.fallback_used is True
    assert result.extractor == "rules"
    assert _net(result, True) == {60}
    assert any("rule reading" in warning for warning in result.warnings)


def test_paraphrase_is_rejected_and_the_rule_reading_remains() -> None:
    bad = Candidate(
        kind="fact",
        domain="pricing",
        statement="The customer pays in sixty days.",
        operative=True,
        section="1.1",
        document_id="doc-amendment-1",
        document_name="Amendment No. 1",
        quote="The customer pays in sixty days, more or less, under this amendment.",
    )
    result = analyze(
        AnalysisRequest(
            base_name="Base",
            base_text=BASE,
            amendments=[("Amendment No. 1", AMENDMENT, "2025-03-01")],
            extractor=ScriptedExtractor([bad]),
        )
    )
    assert result.extractor == "rules+llm"
    assert result.rejected
    assert "verbatim" in result.rejected[0].reason
    assert _net(result, True) == {60}
    assert all("more or less" not in fact.statement for fact in result.facts)


def test_superseded_quote_cannot_stay_operative() -> None:
    old = Candidate(
        kind="fact",
        domain="pricing",
        statement="The model repeated the old payment term.",
        operative=True,
        section="1.1",
        document_id="doc-base",
        document_name="Base",
        quote="Customer shall pay each undisputed invoice within forty-five (45) days after the invoice date (Net 45).",
    )
    result = analyze(
        AnalysisRequest(
            base_name="Base",
            base_text=BASE,
            amendments=[("Amendment No. 1", AMENDMENT, "2025-03-01")],
            extractor=ScriptedExtractor([old]),
        )
    )
    echoed = [fact for fact in result.facts if fact.statement == "The model repeated the old payment term."]
    assert len(echoed) == 1
    assert echoed[0].operative is False


def test_verbatim_model_quote_is_added() -> None:
    extra = Candidate(
        kind="fact",
        domain="precedence",
        statement="The model copied the control sentence.",
        operative=True,
        section=None,
        document_id="doc-amendment-1",
        document_name="Amendment No. 1",
        quote="E. Except as amended above, the Agreement remains in full force.",
    )
    result = analyze(
        AnalysisRequest(
            base_name="Base",
            base_text=BASE,
            amendments=[("Amendment No. 1", AMENDMENT, "2025-03-01")],
            extractor=ScriptedExtractor([extra]),
        )
    )
    assert any(fact.statement == "The model copied the control sentence." and fact.operative for fact in result.facts)


def test_model_parser_rejects_a_non_quote() -> None:
    extractor = OptionalLlmExtractor(complete=lambda _prompt: '{"statements": [{"statement": "Pays quickly.", "quote": "Pays quickly and in full now.", "document_id": "doc-base", "section": "1.1", "domain": "pricing"}]}')
    result = analyze(
        AnalysisRequest(base_name="Base", base_text=BASE, amendments=[], extractor=extractor)
    )
    assert result.rejected
    assert _net(result, True) == {45}


def test_unusable_model_output_falls_back() -> None:
    extractor = OptionalLlmExtractor(complete=lambda _prompt: "not json")
    result = analyze(AnalysisRequest(base_name="Base", base_text=BASE, amendments=[], extractor=extractor))
    assert result.fallback_used is True
    assert result.extractor == "rules"
    assert _net(result, True) == {45}


def _net(result, operative: bool) -> set[int]:
    return {
        int(fact.attributes["net_days"])
        for fact in result.facts
        if fact.operative is operative and "net_days" in fact.attributes
    }
