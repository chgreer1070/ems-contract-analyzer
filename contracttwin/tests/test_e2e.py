"""End-to-end reading of the synthetic Harborline agreement and amendment."""

from __future__ import annotations

from io import BytesIO
from zipfile import ZipFile

from contracttwin.ingest import extract_upload
from contracttwin.pipeline import AnalysisRequest, analyze

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

    names = {document.document_id: document.name for document in result.documents}
    for fact in result.facts:
        assert fact.kind in {"fact", "inference", "assumption"}
        assert fact.section and fact.section.strip(), fact.statement
        if fact.kind == "assumption":
            continue
        assert fact.citations, fact.statement
        for citation in fact.citations:
            assert citation.document_id in names
            assert citation.document_name == names[citation.document_id]
            assert citation.section and citation.section.strip(), fact.statement
            assert citation.quote in texts[citation.document_id]

    effective_line = next(
        line for line in amendment.splitlines() if "entered into" in line and "Amendment Effective Date" in line
    )
    controls_line = next(line for line in amendment.splitlines() if line.startswith("If this Amendment conflicts"))
    amendment_effective = next(fact for fact in result.facts if fact.attributes.get("date_role") == "amendment_effective")
    assert amendment_effective.section == "Preamble"
    assert amendment_effective.citations[0].document_id == "doc-amendment-1"
    assert amendment_effective.citations[0].section == "Preamble"
    assert amendment_effective.citations[0].quote == effective_line
    amendment_controls = next(
        fact
        for fact in result.facts
        if fact.domain == "precedence" and fact.citations[0].quote == controls_line
    )
    assert amendment_controls.section == "Preamble"
    assert amendment_controls.citations[0].document_id == "doc-amendment-1"
    assert amendment_controls.citations[0].section == "Preamble"
    assert amendment_controls.citations[0].quote == controls_line

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
    assert precedence[0].section == "Preamble"
    assert "this Amendment controls" in precedence[0].citations[0].quote


def test_the_same_amendment_words_inside_a_numbered_section_keep_that_section() -> None:
    base = """CONTRACT

This Contract is entered into as of January 15, 2024 (the "Effective Date").

2. Pricing

2.2 Payment. Customer shall pay each undisputed invoice within forty-five (45) days after the invoice date (Net 45).
"""
    amendment = """AMENDMENT NO. 1

This Amendment No. 1 is entered into as of March 1, 2025 (the "Amendment Effective Date").

If this Amendment conflicts with the Agreement, this Amendment controls on and after the Amendment Effective Date.

A. Section 2.2 of the Agreement is deleted and replaced in its entirety with the following:

2.2 Payment. Customer shall pay each undisputed invoice within sixty (60) days after the invoice date (Net 60).
If this Amendment conflicts with the Agreement, this Amendment controls.
The parties entered into the replacement as of April 1, 2025 (the "Amendment Effective Date").
"""
    result = analyze(
        AnalysisRequest(
            base_name="Base",
            base_text=base,
            amendments=[("Amendment No. 1", amendment, "2025-03-01")],
        )
    )
    dated = {
        fact.section: fact.citations[0].quote
        for fact in result.facts
        if fact.attributes.get("date_role") == "amendment_effective"
    }
    assert dated["Preamble"].startswith("This Amendment No. 1 is entered into as of March 1, 2025")
    assert dated["2.2"].startswith("The parties entered into the replacement as of April 1, 2025")
    controls = {
        fact.section: fact.citations[0].quote
        for fact in result.facts
        if fact.attributes.get("precedence") == "amendment_controls"
    }
    assert controls["Preamble"].startswith("If this Amendment conflicts")
    assert controls["2.2"] == "If this Amendment conflicts with the Agreement, this Amendment controls."
    assert _values(result, "net_days", operative=True) == {60}
    assert _values(result, "net_days", operative=False) == {45}


def test_an_amendment_text_box_names_the_box_and_quotes_only_its_words() -> None:
    """An amendment date or control sentence in a text box cites the box.

    The fact stays in the preamble or the numbered section. The quote is the
    sentence itself, without the text-box label. Synthetic words only.
    """

    preamble_date = 'This Amendment No. 1 is entered into as of March 1, 2025 (the "Amendment Effective Date").'
    preamble_controls = "If this Amendment conflicts with the Agreement, this Amendment controls on and after the Amendment Effective Date."
    section_date = 'The parties entered into the replacement as of April 1, 2025 (the "Amendment Effective Date").'
    section_controls = "If this Amendment conflicts with the Agreement, this Amendment controls."
    amendment = "\n".join(
        [
            f"[text box] {preamble_date}",
            f"[text box] {preamble_controls}",
            "[text box] 2.2 Payment",
            f"[text box] {section_date}",
            f"[text box] {section_controls}",
        ]
    )
    base = """CONTRACT

This Contract is entered into as of January 15, 2024 (the "Effective Date").

2. Pricing

2.2 Payment. Customer shall pay each undisputed invoice within forty-five (45) days after the invoice date.
"""
    result = analyze(AnalysisRequest(base_name="Base", base_text=base, amendments=[("Amendment No. 1", amendment, "2025-03-01")]))
    assert result.rejected == []
    dated = {
        fact.section: fact
        for fact in result.facts
        if fact.attributes.get("date_role") == "amendment_effective"
    }
    assert dated["Preamble"].citations[0].section == "Text box in section Preamble"
    assert dated["Preamble"].citations[0].quote == preamble_date
    assert "[text box]" not in dated["Preamble"].citations[0].quote
    assert dated["2.2"].citations[0].section == "Text box in section 2.2"
    assert dated["2.2"].citations[0].quote == section_date
    controls = {
        fact.section: fact
        for fact in result.facts
        if fact.attributes.get("precedence") == "amendment_controls"
    }
    assert controls["Preamble"].citations[0].section == "Text box in section Preamble"
    assert controls["Preamble"].citations[0].quote == preamble_controls
    assert controls["2.2"].citations[0].section == "Text box in section 2.2"
    assert controls["2.2"].citations[0].quote == section_controls

    extracted = extract_upload("synthetic-amendment-box.docx", _amendment_box(preamble_date, preamble_controls))
    assert f"[text box] {preamble_date}" in extracted.text.splitlines()
    read = analyze(
        AnalysisRequest(
            base_name="Base",
            base_text=base,
            amendments=[("Amendment No. 1", extracted.text, "2025-03-01")],
        )
    )
    word_date = next(fact for fact in read.facts if fact.attributes.get("date_role") == "amendment_effective")
    assert word_date.section == "Preamble"
    assert word_date.citations[0].section == "Text box in section Preamble"
    assert word_date.citations[0].quote == preamble_date
    assert word_date.citations[0].quote in extracted.text
    word_controls = next(fact for fact in read.facts if fact.attributes.get("precedence") == "amendment_controls")
    assert word_controls.citations[0].section == "Text box in section Preamble"
    assert word_controls.citations[0].quote == preamble_controls


def _amendment_box(date_line: str, controls_line: str) -> bytes:
    """A made-up Word file. Both amendment sentences sit in one text box."""

    def xml(value: str) -> str:
        return value.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace('"', "&quot;")

    document = f"""<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p>
      <w:r>
        <w:drawing>
          <w:txbxContent>
            <w:p><w:r><w:t>{xml(date_line)}</w:t></w:r></w:p>
            <w:p><w:r><w:t>{xml(controls_line)}</w:t></w:r></w:p>
          </w:txbxContent>
        </w:drawing>
      </w:r>
    </w:p>
  </w:body>
</w:document>
"""
    buffer = BytesIO()
    with ZipFile(buffer, "w") as package:
        package.writestr("word/document.xml", document)
    return buffer.getvalue()


def _values(result, key: str, operative: bool) -> set[object]:
    return {
        fact.attributes[key]
        for fact in result.facts
        if fact.operative is operative and key in fact.attributes
    }
