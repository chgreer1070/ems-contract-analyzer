"""The reader must not promote a nearby number into a term the sentence did not state."""

from __future__ import annotations

from fastapi.testclient import TestClient

from contracttwin.api import app
from contracttwin.pipeline import AnalysisRequest, analyze

client = TestClient(app)


def test_one_line_uses_the_date_that_follows_each_phrase() -> None:
    text = (
        'This Agreement is entered into as of January 15, 2024 (the "Effective Date") '
        "and continues until January 14, 2027.\n"
    )
    result = analyze(AnalysisRequest(base_name="Combined", base_text=text, amendments=[]))
    dates = {fact.attributes.get("date_role"): fact.attributes.get("date") for fact in result.facts}
    assert dates["agreement_effective"] == "2024-01-15"
    assert dates["term_end"] == "2027-01-14"


def test_impossible_date_does_not_abort_the_reading() -> None:
    text = 'This Agreement is entered into as of February 31, 2024 (the "Effective Date").\n'
    result = analyze(AnalysisRequest(base_name="Bad date", base_text=text, amendments=[]))
    assert not any(fact.attributes.get("date_role") == "agreement_effective" for fact in result.facts)


def test_price_unit_payment_anchor_and_negation_stay_with_the_words() -> None:
    text = """1. Pricing

1.1 Unit Prices. The unit price for product NW-100 is USD 12.40 per thousand.

1.2 Deposit. Customer shall pay the deposit within ten (10) days after the order date.

1.3 Discount. The price includes a two percent (2%) discount.

1.4 Not an amount. The schedule does not state an Excess and Obsolete exposure of USD 10000.00.

1.5 Notice. Customer shall give written notice no later than ten (10) business days after March 1, 2025, see also January 1, 2020.
"""
    result = analyze(AnalysisRequest(base_name="Careful", base_text=text, amendments=[]))
    price = next(fact for fact in result.facts if "unit_price" in fact.attributes)
    assert price.attributes["per_unit"] is False
    assert "per unit" not in price.statement
    assert not any("net_days" in fact.attributes for fact in result.facts)
    assert not any("adjustment_cap_percent" in fact.attributes for fact in result.facts)
    assert not any(fact.attributes.get("explicit_amount") == "10000.00" for fact in result.facts)
    notice = next(fact for fact in result.facts if "anchor_date" in fact.attributes)
    assert notice.attributes["anchor_date"] == "2025-03-01"
    assert notice.attributes["notice_topic"] == "general"


def test_old_words_repeated_in_the_new_section_are_not_the_operative_term() -> None:
    base = """1. Pricing

1.1 Payment. Customer shall pay each undisputed invoice within forty-five (45) days after the invoice date (Net 45).
"""
    amendment = """This Amendment No. 1 is entered into as of March 1, 2025 (the "Amendment Effective Date").

A. Section 1.1 of the Agreement is hereby deleted and replaced in its entirety with the following:

1.1 Payment. The previous forty-five (45) days no longer applies. Customer shall pay each undisputed invoice within sixty (60) days after the invoice date (Net 60).

E. Except as stated above, the Agreement remains in force.
"""
    result = analyze(
        AnalysisRequest(
            base_name="Base",
            base_text=base,
            amendments=[("Amendment No. 1", amendment, "2024-01-01")],
        )
    )
    operative = {fact.attributes["net_days"] for fact in result.facts if fact.operative and "net_days" in fact.attributes}
    assert operative == {60}
    assert any("does not match the date written" in warning for warning in result.warnings)


def test_two_stated_amounts_are_not_collapsed_to_one() -> None:
    text = """1. Inventory

1.1 Amounts. Customer shall pay an Excess and Obsolete exposure of USD 100.00 and an Excess and Obsolete exposure of USD 250.00.
"""
    result = analyze(AnalysisRequest(base_name="Two amounts", base_text=text, amendments=[]))
    inventory = next(
        impact
        for domain in result.exposure.domains
        if domain.domain == "excess_and_obsolete"
        for impact in domain.impacts
        if impact.area == "inventory"
    )
    assert inventory.determination == "cannot_be_determined"
    assert "cannot be determined" in inventory.summary
    assert inventory.amount is None


def test_a_bad_word_file_is_refused() -> None:
    response = client.post(
        "/v1/agreements/files",
        data={"manifest": '{"base": {"name": "Broken", "role": "base", "filename": "broken.docx"}}'},
        files=[("files", ("broken.docx", b"this is not a zip", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"))],
    )
    assert response.status_code == 400
    assert response.status_code != 500
