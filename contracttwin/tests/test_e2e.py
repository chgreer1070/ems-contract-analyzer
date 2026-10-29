"""End-to-end reading of the synthetic Harborline agreement and amendment."""

from __future__ import annotations

from .conftest import harborline_analysis, read_fixture


def test_operative_terms_follow_the_amendment_and_keep_the_old_text() -> None:
    result = harborline_analysis()
    base = read_fixture("harborline_msa.txt")
    amendment = read_fixture("harborline_amendment_1.txt")
    texts = {"doc-base": base, "doc-amendment-1": amendment}

    assert result.extractor == "rules"
    assert result.fallback_used is False
    assert result.review_required is True
    assert result.rejected == []
    assert "not a legal conclusion" in result.disclaimer
    assert not any(fact.kind == "assumption" for fact in result.facts)

    assert _values(result, "net_days", operative=True) == {60}
    assert _values(result, "net_days", operative=False) == {45}
    assert _values(result, "ncnr_days", operative=True) == {120}
    assert _values(result, "ncnr_days", operative=False) == {90}
    assert _values(result, "notice_business_days", operative=True) == {10}
    assert _values(result, "notice_business_days", operative=False) == {15}
    assert _values(result, "unit_price", operative=True) == {"12.40"}
    assert _values(result, "adjustment_cap_percent", operative=True) == {"3"}

    firm = [fact for fact in result.facts if fact.domain == "definition" and fact.attributes.get("defined_term") == "Firm Period"]
    assert any(fact.operative and "one hundred twenty (120)" in fact.statement for fact in firm)
    assert any(not fact.operative and "ninety (90)" in fact.statement for fact in firm)

    payment = [clause for clause in result.clause_register if clause.section == "2.2"]
    assert {clause.operative for clause in payment} == {True, False}
    operative_payment = next(clause for clause in payment if clause.operative)
    superseded_payment = next(clause for clause in payment if not clause.operative)
    assert operative_payment.document_id == "doc-amendment-1"
    assert "Net 60" in operative_payment.citation.quote
    assert superseded_payment.document_id == "doc-base"
    assert superseded_payment.superseded_by_document_id == "doc-amendment-1"
    assert "Net 45" in superseded_payment.citation.quote

    for fact in result.facts:
        assert fact.kind in {"fact", "inference", "assumption"}
        if fact.kind == "assumption":
            continue
        assert fact.citations, fact.statement
        for citation in fact.citations:
            assert citation.quote in texts[citation.document_id]

    for obligation in result.obligation_register:
        assert obligation.kind == "fact"
        assert obligation.citation.quote in texts[obligation.citation.document_id]
        assert obligation.statement == obligation.citation.quote

    for clause in result.clause_register:
        assert clause.citation.quote in texts[clause.document_id]


def test_calendar_dates_are_iso_and_the_rest_stay_undated() -> None:
    result = harborline_analysis()
    dated = {entry.date for entry in result.calendar if entry.date}
    assert "2024-01-15" in dated
    assert "2027-01-14" in dated
    assert "2025-03-01" in dated
    assert "2025-01-15" in dated
    assert "2026-01-15" in dated
    assert "2024-11-16" in dated
    assert "2025-11-16" in dated
    assert "2025-07-14" in dated
    assert "2027-01-15" not in dated

    eo = next(entry for entry in result.calendar if entry.date == "2025-07-14")
    assert eo.kind == "inference"
    assert eo.operative is True
    assert "June 30, 2025" in eo.citations[0].quote or any("June 30, 2025" in item.quote for item in eo.citations)

    undated = [entry for entry in result.calendar if entry.date is None]
    assert undated
    assert any("cannot be determined" in entry.description for entry in undated)
    for entry in result.calendar:
        if entry.date is not None:
            assert len(entry.date) == 10
            assert entry.date[4] == "-" and entry.date[7] == "-"


def test_dollar_impacts_cannot_be_determined_from_this_agreement() -> None:
    result = harborline_analysis()
    domains = {domain.domain: domain for domain in result.exposure.domains}
    assert set(domains) == {"pricing", "ncnr", "excess_and_obsolete"}
    for domain in domains.values():
        areas = [impact.area for impact in domain.impacts]
        assert areas == ["margin", "cash", "working_capital", "inventory"]
        for impact in domain.impacts:
            assert impact.determination == "cannot_be_determined"
            assert impact.amount is None
            assert impact.currency is None
            assert "cannot be determined" in impact.summary


def test_survival_cross_references_and_unchanged_sections() -> None:
    result = harborline_analysis()
    by_section = {}
    for clause in result.clause_register:
        if clause.operative:
            by_section[clause.section] = clause
    assert by_section["3.1"].survives_termination is True
    assert by_section["4.2"].survives_termination is True
    assert by_section["5.3"].survives_termination is True
    assert by_section["7.1"].survives_termination is True
    assert by_section["2.1"].survives_termination is False
    assert by_section["2.1"].document_id == "doc-base"
    superseded_firm = next(clause for clause in result.clause_register if clause.section == "3.1" and not clause.operative)
    assert superseded_firm.survives_termination is False

    resolved = {(item.from_section, item.to_section) for item in result.cross_references if item.resolved}
    assert ("3.2", "1.3") in resolved
    assert ("4.1", "3.3") in resolved
    assert ("6.1", "1.3") in resolved
    assert ("6.1", "1.2") in resolved
    assert all(item.citation.quote for item in result.cross_references)

    precedence = [fact for fact in result.facts if fact.domain == "precedence"]
    assert len(precedence) == 1
    assert precedence[0].operative is True
    assert "this Amendment controls" in precedence[0].citations[0].quote


def _values(result, key: str, operative: bool) -> set[object]:
    return {
        fact.attributes[key]
        for fact in result.facts
        if fact.operative is operative and key in fact.attributes
    }
