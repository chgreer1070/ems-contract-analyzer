"""The extra EMS terms stay tied to the sentence that states them."""

from __future__ import annotations

from contracttwin.pipeline import AnalysisRequest, analyze

from .conftest import read_fixture


def test_cedarline_terms_are_cited_and_not_priced_by_guesswork() -> None:
    text = read_fixture("cedarline_terms.txt")
    result = analyze(AnalysisRequest(base_name="Cedarline", base_text=text, amendments=[]))
    assert result.rejected == []

    cap = _one(result, "liability_cap_amount")
    assert cap.attributes["liability_cap_amount"] == "250000.00"
    assert "USD 250000.00" in cap.citations[0].quote
    assert "shall not exceed" in cap.citations[0].quote

    exclusion = _statement(result, "excludes indirect, incidental, special, and consequential")
    assert "consequential damages" in exclusion.citations[0].quote

    indemnity = next(fact for fact in result.facts if fact.domain == "indemnity" and fact.operative)
    assert indemnity.kind == "fact"
    assert indemnity.attributes["walk_away"] is True
    assert "without limitation" in indemnity.citations[0].quote
    assert any("Possible walk-away" in warning for warning in result.warnings)

    warranty = _one(result, "warranty_months")
    assert warranty.attributes["warranty_months"] == 12
    assert warranty.attributes["warranty_remedy"] == "repair or replace"
    assert any("warranty dollar reserve cannot be determined" in warning for warning in result.warnings)

    termination = _one(result, "termination_notice_days")
    assert termination.attributes["termination_notice_days"] == 90
    assert termination.attributes["termination_kind"] == "convenience"

    forecast = _one(result, "forecast_months")
    assert forecast.attributes["forecast_months"] == 12
    assert any("forecast volume cannot be determined" in warning for warning in result.warnings)

    end_of_life = _one(result, "eol_notice_days")
    assert end_of_life.attributes["eol_notice_days"] == 180
    assert end_of_life.attributes["last_time_buy"] is True
    assert "last time buy" in end_of_life.citations[0].quote

    consigned = next(fact for fact in result.facts if fact.domain == "consignment")
    assert "Title to consigned inventory remains with Customer" in consigned.citations[0].quote
    assert any("consigned inventory cannot be determined" in warning for warning in result.warnings)

    late = _one(result, "late_fee_percent")
    assert late.domain == "pricing"
    assert late.attributes["late_fee_percent"] == "1"
    assert any("dollar late fee cannot be determined" in warning for warning in result.warnings)

    for fact in result.facts:
        for citation in fact.citations:
            assert citation.quote in text

    for domain in result.exposure.domains:
        for impact in domain.impacts:
            assert impact.determination == "cannot_be_determined"
            assert impact.amount is None

    surviving = {clause.section for clause in result.clause_register if clause.operative and clause.survives_termination}
    assert "1.1" in surviving
    assert "2.1" in surviving
    assert "3.1" in surviving
    assert "7.1" not in surviving


def test_a_capped_third_party_indemnity_is_not_called_a_walk_away() -> None:
    text = """1. Indemnity

1.1 Claims. Manufacturer shall indemnify Customer against any third-party claim subject to the liability cap.
"""
    result = analyze(AnalysisRequest(base_name="Capped", base_text=text, amendments=[]))
    assert not any("Possible walk-away" in warning for warning in result.warnings)
    indemnity = next(fact for fact in result.facts if fact.domain == "indemnity")
    assert indemnity.attributes.get("walk_away") is not True
    assert "subject to the liability cap" in indemnity.citations[0].quote


def _one(result, key: str):
    matches = [fact for fact in result.facts if fact.operative and key in fact.attributes]
    assert len(matches) == 1, key
    return matches[0]


def _statement(result, snippet: str):
    matches = [fact for fact in result.facts if snippet in fact.statement]
    assert len(matches) == 1, snippet
    return matches[0]
