"""Dollar impacts stay blank unless the text states the amount. Dates follow the text."""

from __future__ import annotations

from contracttwin.pipeline import AnalysisRequest, analyze


def test_stated_inventory_amount_is_the_only_supported_impact() -> None:
    text = """1. Inventory

1.1 Liability. Customer shall pay an Excess and Obsolete exposure of USD 10000.00 for the named program.
"""
    result = analyze(AnalysisRequest(base_name="Stated amount", base_text=text, amendments=[]))
    domains = {item.domain: item for item in result.exposure.domains}
    inventory = next(impact for impact in domains["excess_and_obsolete"].impacts if impact.area == "inventory")
    assert inventory.determination == "supported"
    assert inventory.kind == "fact"
    assert inventory.amount == "10000.00"
    assert inventory.currency == "USD"
    assert inventory.citations
    assert "USD 10000.00" in inventory.citations[0].quote
    for impact in domains["excess_and_obsolete"].impacts:
        if impact.area != "inventory":
            assert impact.determination == "cannot_be_determined"
            assert "cannot be determined" in impact.summary
    for impact in domains["pricing"].impacts:
        assert impact.determination == "cannot_be_determined"


def test_february_29_anniversary_is_labeled_as_an_assumption() -> None:
    text = """LEAP AGREEMENT

This Leap Agreement is entered into as of February 29, 2024 (the "Effective Date"), by and between Northwind Devices, Inc. and Harborline Manufacturing, LLC.

The initial term begins on the Effective Date and continues until March 1, 2025.

1. Pricing

1.1 Price Notice. Manufacturer shall give written notice at least sixty (60) days before each anniversary of the Effective Date before an annual price adjustment may take effect.
"""
    result = analyze(AnalysisRequest(base_name="Leap", base_text=text, amendments=[]))
    assumptions = [fact for fact in result.facts if fact.kind == "assumption"]
    assert len(assumptions) == 1
    assert "February 28" in assumptions[0].statement
    assert assumptions[0].citations
    assert "February 29, 2024" in assumptions[0].citations[0].quote
    dated = {entry.date for entry in result.calendar}
    assert "2025-02-28" in dated
    assert "2024-12-30" in dated
    notice = next(entry for entry in result.calendar if entry.date == "2024-12-30")
    assert assumptions[0].id in notice.depends_on


def test_business_day_date_is_not_counted_when_the_meaning_is_missing() -> None:
    text = """1. Notices

1.1 E&O Notice. Customer shall give written notice no later than ten (10) business days after June 30, 2025.
"""
    result = analyze(AnalysisRequest(base_name="Undefined business day", base_text=text, amendments=[]))
    assert not any(entry.date == "2025-07-14" for entry in result.calendar)
    assert any(entry.date is None and "cannot be determined" in entry.description for entry in result.calendar)
