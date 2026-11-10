"""Later amendments replace the same section. Untouched sections stay in force."""

from __future__ import annotations

from contracttwin.pipeline import AnalysisRequest, analyze

BASE = """CONTRACT

1. Pricing

1.1 Payment. Customer shall pay each undisputed invoice within ten (10) days after the invoice date (Net 10).

1.2 Unit Prices. The unit price for product NW-100 is USD 12.40 per unit.
"""

FIRST = """AMENDMENT NO. 1

This Amendment No. 1 is entered into as of March 1, 2025 (the "Amendment Effective Date").

A. Section 1.1 of the Agreement is deleted and replaced in its entirety with the following:

1.1 Payment. Customer shall pay each undisputed invoice within twenty (20) days after the invoice date (Net 20).
"""

SECOND = """AMENDMENT NO. 2

This Amendment No. 2 is entered into as of June 1, 2025 (the "Amendment Effective Date").

A. Section 1.1 of the Agreement is deleted and replaced in its entirety with the following:

1.1 Payment. Customer shall pay each undisputed invoice within thirty (30) days after the invoice date (Net 30).
"""


def test_stated_dates_beat_typed_dates_and_input_order() -> None:
    """The date written in each amendment places it. A reversed typed date does not."""

    early_text = FIRST.replace("March 1, 2025", "March 1, 2024")
    late_text = SECOND
    result = analyze(
        AnalysisRequest(
            base_name="Base",
            base_text=BASE,
            amendments=[
                ("Typed later", early_text, "2026-01-01"),
                ("Typed earlier", late_text, "2020-01-01"),
            ],
        )
    )
    net = [(fact.operative, fact.attributes["net_days"]) for fact in result.facts if "net_days" in fact.attributes]
    assert (True, 30) in net
    assert (False, 20) in net
    reversed_result = analyze(
        AnalysisRequest(
            base_name="Base",
            base_text=BASE,
            amendments=[
                ("Typed earlier", late_text, "2020-01-01"),
                ("Typed later", early_text, "2026-01-01"),
            ],
        )
    )
    reversed_net = [
        (fact.operative, fact.attributes["net_days"]) for fact in reversed_result.facts if "net_days" in fact.attributes
    ]
    assert reversed_net == net


def test_an_undated_amendment_is_refused() -> None:
    undated = """AMENDMENT

A. Section 1.1 of the Agreement is deleted and replaced in its entirety with the following:

1.1 Payment. Customer shall pay each undisputed invoice within twenty (20) days after the invoice date (Net 20).
"""
    try:
        analyze(AnalysisRequest(base_name="Base", base_text=BASE, amendments=[("No date", undated, "2025-03-01")]))
    except ValueError as exc:
        message = str(exc)
    else:
        raise AssertionError("An amendment with no stated effective date must be refused.")
    assert "No date" in message
    assert "no stated effective date" in message


def test_tied_stated_dates_are_refused_as_ambiguous() -> None:
    same_day = SECOND.replace("June 1, 2025", "March 1, 2025")
    try:
        analyze(
            AnalysisRequest(
                base_name="Base",
                base_text=BASE,
                amendments=[("Amendment No. 2", same_day, "2025-06-01"), ("Amendment No. 1", FIRST, "2025-03-01")],
            )
        )
    except ValueError as exc:
        message = str(exc)
    else:
        raise AssertionError("Two amendments with the same stated effective date must be refused.")
    assert "ambiguous" in message
    assert "2025-03-01" in message
    assert "Amendment No. 1" in message
    assert "Amendment No. 2" in message


def test_later_amendment_wins_and_the_price_section_is_unchanged() -> None:
    result = analyze(
        AnalysisRequest(
            base_name="Base",
            base_text=BASE,
            amendments=[
                ("Amendment No. 2", SECOND, "2025-06-01"),
                ("Amendment No. 1", FIRST, "2025-03-01"),
            ],
        )
    )
    net = [(fact.operative, fact.attributes["net_days"]) for fact in result.facts if "net_days" in fact.attributes]
    assert (True, 30) in net
    assert (False, 20) in net
    assert (False, 10) in net
    operative_price = next(clause for clause in result.clause_register if clause.section == "1.2" and clause.operative)
    assert operative_price.document_id == "doc-base"
    assert "USD 12.40" in operative_price.citation.quote
    assert result.rejected == []


def test_conflicting_written_number_is_not_used() -> None:
    text = """1. Pricing

1.1 Payment. Customer shall pay each undisputed invoice within sixty (45) days after the invoice date.
"""
    result = analyze(AnalysisRequest(base_name="Conflict", base_text=text, amendments=[]))
    assert not any("net_days" in fact.attributes for fact in result.facts)
    assert any("does not match" in warning for warning in result.warnings)


def test_missing_target_section_is_added_and_warned() -> None:
    amendment = """This Amendment No. 1 is entered into as of March 1, 2025 (the "Amendment Effective Date").

A. Section 9.1 of the Agreement is deleted and replaced in its entirety with the following:

9.1 New Term. Customer shall give written notice at least thirty (30) days before the new deadline.
"""
    result = analyze(
        AnalysisRequest(
            base_name="Base",
            base_text=BASE,
            amendments=[("Amendment", amendment, "2025-03-01")],
        )
    )
    assert any(clause.section == "9.1" and clause.operative for clause in result.clause_register)
    assert any("was not in the base agreement" in warning for warning in result.warnings)


def test_dangling_cross_reference_is_unresolved() -> None:
    text = """1. Terms

1.1 Pointer. Customer shall purchase the goods described in Section 9.9.
"""
    result = analyze(AnalysisRequest(base_name="Pointer", base_text=text, amendments=[]))
    assert result.cross_references
    assert result.cross_references[0].to_section == "9.9"
    assert result.cross_references[0].resolved is False
    assert "Section 9.9" in result.cross_references[0].citation.quote
