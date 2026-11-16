"""Later amendments replace the same section. Untouched sections stay in force."""

from __future__ import annotations

from io import BytesIO
from zipfile import ZipFile

from contracttwin.ingest import extract_upload
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


def test_a_text_box_label_does_not_merge_the_next_amendment() -> None:
    """A text-box label sits in front of each line. The next instruction still ends the prior replacement.

    The quoted replacement stays an exact slice of the amendment, label included.
    The same words without the label separate the same way. Synthetic text only.
    """

    goods = "1. Delivery. Supplier shall deliver the goods within ten days."
    parts = "2. Delivery. Supplier shall deliver the spare parts within twenty days."
    paragraphs = [
        "AMENDMENT NO. 1",
        'This Amendment No. 1 is entered into as of March 1, 2025 (the "Amendment Effective Date").',
        "A. Section 1 of the Agreement is deleted and replaced in its entirety with the following:",
        goods,
        "B. Section 2 of the Agreement is deleted and replaced in its entirety with the following:",
        parts,
    ]
    base = """CONTRACT

1. Delivery

Supplier shall deliver the goods within five days.

2. Acceptance

Supplier shall deliver the spare parts within five days.
"""
    unlabeled = "\n".join(paragraphs)
    labeled = extract_upload("synthetic-amendment.docx", _amendment_text_box(paragraphs)).text
    assert labeled.splitlines() == [f"[text box] {line}" for line in paragraphs]

    plain = _read(base, unlabeled)
    boxed = _read(base, labeled)
    _assert_separated(plain, unlabeled, goods, parts, boxed=False)
    _assert_separated(boxed, labeled, goods, parts, boxed=True)


def test_dangling_cross_reference_is_unresolved() -> None:
    text = """1. Terms

1.1 Pointer. Customer shall purchase the goods described in Section 9.9.
"""
    result = analyze(AnalysisRequest(base_name="Pointer", base_text=text, amendments=[]))
    assert result.cross_references
    assert result.cross_references[0].to_section == "9.9"
    assert result.cross_references[0].resolved is False
    assert "Section 9.9" in result.cross_references[0].citation.quote


def _read(base: str, amendment: str):
    return analyze(
        AnalysisRequest(
            base_name="Synthetic Base",
            base_text=base,
            amendments=[("Synthetic Amendment", amendment, "2025-03-01")],
        )
    )


def _assert_separated(result, source: str, goods: str, parts: str, boxed: bool) -> None:
    def deliveries(operative: bool, section: str) -> list[str]:
        return [
            item.statement
            for item in result.obligation_register
            if item.operative is operative and item.section == section and "shall deliver" in item.statement
        ]

    assert deliveries(True, "1") == [goods]
    assert deliveries(True, "2") == [parts]
    assert parts not in deliveries(True, "1")
    assert "five days" not in " ".join(deliveries(True, "1") + deliveries(True, "2"))

    for section, sentence in (("1", goods), ("2", parts)):
        obligation = next(
            item
            for item in result.obligation_register
            if item.operative and item.section == section and item.statement == sentence
        )
        assert obligation.citation.quote == sentence
        assert obligation.citation.quote in source
        place = f"Text box in section {section}" if boxed else section
        assert obligation.citation.section == place
        clause = next(item for item in result.clause_register if item.operative and item.section == section)
        assert clause.citation.quote in source
        assert sentence in clause.citation.quote
        assert (goods if section == "2" else parts) not in clause.citation.quote
        if boxed:
            assert clause.citation.quote == f"[text box] {sentence}"
        else:
            assert clause.citation.quote == sentence
            assert "[text box]" not in clause.citation.quote


def _amendment_text_box(paragraphs: list[str]) -> bytes:
    def xml(value: str) -> str:
        return value.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace('"', "&quot;")

    inner = "".join(f"<w:p><w:r><w:t>{xml(line)}</w:t></w:r></w:p>" for line in paragraphs)
    document = f"""<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p>
      <w:r>
        <w:drawing>
          <w:txbxContent>{inner}</w:txbxContent>
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
