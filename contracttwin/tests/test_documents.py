"""Word tracked changes and PDF pages that have no readable text."""

from __future__ import annotations

from io import BytesIO
from zipfile import ZipFile

from fastapi.testclient import TestClient

from contracttwin.api import app
from contracttwin.docx_reader import read_docx
from contracttwin.extract_rules import extract_rules
from contracttwin.ingest import IngestError, extract_upload
from contracttwin.precedence import PreparedDocument, build_ledger
from contracttwin.quote_check import Candidate, review_candidates

from .conftest import API_HEADERS

client = TestClient(app, headers=API_HEADERS)


def test_docx_keeps_accepted_words_and_the_redline() -> None:
    payload = _docx_with_redline_and_table()
    extracted = extract_upload("redline.docx", payload)
    assert "sixty (60)" in extracted.text
    assert "forty-five (45)" not in extracted.text
    assert "NW-100 | USD 12.40" in extracted.text
    kinds = {(item.kind, item.text) for item in extracted.revisions}
    assert ("deletion", "forty-five (45)") in kinds
    assert ("insertion", "sixty (60)") in kinds

    response = client.post(
        "/v1/agreements/files",
        data={"manifest": '{"base": {"name": "Redline", "role": "base", "filename": "redline.docx"}}'},
        files=[("files", ("redline.docx", payload, "application/vnd.openxmlformats-officedocument.wordprocessingml.document"))],
    )
    assert response.status_code == 200, response.text
    body = response.json()
    nets = [fact["attributes"].get("net_days") for fact in body["facts"] if fact["operative"]]
    assert 60 in nets
    assert 45 not in nets
    revisions = body["documents"][0]["revisions"]
    assert any(item["kind"] == "deletion" and item["text"] == "forty-five (45)" for item in revisions)


def test_pdf_table_cells_are_kept_verbatim() -> None:
    extracted = extract_upload("prices.pdf", _pdf_table())
    assert "NW-100 | USD 12.40" in extracted.text


def test_footnotes_and_text_boxes_are_read_and_comments_stay_out_of_the_text() -> None:
    extracted = extract_upload("notes.docx", _docx_with_notes())
    assert "The unit price in the footnote is USD 9.50 per unit." in extracted.text
    assert "The text box states a late fee of one percent (1%) per month." in extracted.text
    assert "This comment is not contract text." not in extracted.text
    assert len(extracted.annotations) == 1
    note = extracted.annotations[0]
    assert note.kind == "comment"
    assert note.operative is False
    assert note.author == "Ada Reviewer"
    assert note.text == "This comment is not contract text."


def test_footnote_and_text_box_citations_name_the_document_the_place_and_the_exact_words() -> None:
    footnote = "The unit price for product NW-100 is USD 9.50 per unit."
    box = "Customer shall pay a late fee of one percent (1%) per month."
    deleted = "Customer shall pay the deleted-only penalty within forty-five (45) days."
    comment = "This comment is not contract text."
    payload = _docx_with_cited_notes(footnote, box, deleted, comment)
    extracted = extract_upload("harborline-notes.docx", payload)
    assert [line for line in extracted.text.splitlines() if line.strip()] == [
        "1. Pricing",
        "1.1 Price. See the footnote.",
        f"[text box] {box}",
        f"[footnote 1] {footnote}",
    ]
    assert any(item.kind == "deletion" and item.text == deleted for item in extracted.revisions)
    assert len(extracted.annotations) == 1
    assert extracted.annotations[0].operative is False
    assert extracted.annotations[0].text == comment
    documents = {"doc": ("Harborline Notes", extracted.text)}
    for quote in (deleted, comment):
        accepted, rejected = review_candidates(
            [
                Candidate(
                    kind="fact",
                    domain="pricing",
                    statement="This wording is not the contract.",
                    operative=True,
                    section="1.1",
                    document_id="doc",
                    document_name="Harborline Notes",
                    quote=quote,
                )
            ],
            documents,
        )
        assert accepted == []
        assert "verbatim" in rejected[0].reason

    response = client.post(
        "/v1/agreements/files",
        data={"manifest": '{"base": {"name": "Harborline Notes", "role": "base", "filename": "harborline-notes.docx"}}'},
        files=[("files", ("harborline-notes.docx", payload, "application/vnd.openxmlformats-officedocument.wordprocessingml.document"))],
    )
    assert response.status_code == 200, response.text
    facts = response.json()["facts"]
    price = next(fact for fact in facts if fact["attributes"].get("unit_price") == "9.50")
    price_citation = price["citations"][0]
    assert price["section"] == "1.1"
    assert price_citation["document_name"] == "Harborline Notes"
    assert price_citation["section"] == "Footnote 1"
    assert price_citation["quote"] == footnote
    assert price_citation["quote"] in extracted.text
    box_facts = [fact for fact in facts if any(item["quote"] == box for item in fact["citations"])]
    assert box_facts
    for fact in box_facts:
        citation = fact["citations"][0]
        assert fact["section"] == "1.1"
        assert citation["document_name"] == "Harborline Notes"
        assert citation["section"] == "Text box in section 1.1"
        assert citation["quote"] == box
        assert citation["quote"] in extracted.text
    assert not any(deleted in item["quote"] or comment in item["quote"] for fact in facts for item in fact["citations"])


def test_a_footnote_xml_id_is_cited_as_the_number_on_the_page() -> None:
    """The only normally numbered note can be stored as XML id 42.

    Word shows footnote 1. The citation must say Footnote 1. The check reads
    the file, finds the price, and accepts the citation. Synthetic words only.
    """

    note = "The unit price for product NW-100 is USD 9.50 per unit."
    separator_settings = '<w:footnote w:id="-1"/><w:footnote w:id="0"/>'
    payloads = (
        _docx_with_displayed_footnote([("42", note)]),
        _docx_with_displayed_footnote([("42", note)], settings_footnote_pr=separator_settings),
    )
    for payload in payloads:
        text, accepted, rejected = _cited_footnote_facts(payload)
        assert rejected == []
        assert f"[footnote 1] {note}" in text.splitlines()
        assert "[footnote 42]" not in text
        assert "[footnote XML id 42]" not in text
        fact = next(item for item in accepted if item.attributes.get("unit_price") == "9.50")
        citation = fact.citations[0]
        assert fact.section == "1.1"
        assert citation.document_name == "Synthetic Footnote"
        assert citation.section == "Footnote 1"
        assert citation.quote == note
        assert citation.quote in text
        assert not any(item.section == "Footnote 42" for item in fact.citations)


def test_footnote_numbers_follow_reference_order_and_a_later_start() -> None:
    """The first reference is footnote 1 even when its XML id is the larger one.

    A note that Word numbers from 5 stays footnote 5, including when that
    start is written in the document settings. Synthetic words only.
    """

    first = "The unit price for product NW-100 is USD 9.50 per unit."
    second = "The unit price for product NW-200 is USD 8.25 per unit."
    text, accepted, rejected = _cited_footnote_facts(
        _docx_with_displayed_footnote([("42", first), ("7", second)])
    )
    assert rejected == []
    assert f"[footnote 2] {second}" in text.splitlines()
    assert f"[footnote 1] {first}" in text.splitlines()
    by_price = {fact.attributes.get("unit_price"): fact.citations[0].section for fact in accepted}
    assert by_price["9.50"] == "Footnote 1"
    assert by_price["8.25"] == "Footnote 2"

    start_at_five = '<w:numFmt w:val="decimal"/><w:numStart w:val="5"/><w:numRestart w:val="continuous"/>'
    for payload in (
        _docx_with_displayed_footnote([("42", first)], section_footnote_pr=start_at_five),
        _docx_with_displayed_footnote(
            [("42", first)],
            settings_footnote_pr='<w:numFmt w:val="decimal"/><w:numStart w:val="5"/>',
        ),
    ):
        _text, accepted, rejected = _cited_footnote_facts(payload)
        assert rejected == []
        fact = next(item for item in accepted if item.attributes.get("unit_price") == "9.50")
        assert fact.citations[0].section == "Footnote 5"
        assert fact.citations[0].quote == first

    overridden, accepted, rejected = _cited_footnote_facts(
        _docx_with_displayed_footnote(
            [("42", first)],
            section_footnote_pr='<w:numFmt w:val="decimal"/><w:numStart w:val="8"/>',
            settings_footnote_pr='<w:numFmt w:val="lowerRoman"/><w:numStart w:val="5"/>',
        )
    )
    assert rejected == []
    assert "[footnote 8]" in overridden
    fact = next(item for item in accepted if item.attributes.get("unit_price") == "9.50")
    assert fact.citations[0].section == "Footnote 8"
    assert fact.citations[0].quote == first


def test_a_footnote_number_that_cannot_be_counted_names_the_xml_id() -> None:
    """A number this reader cannot count is not presented as the page number.

    Synthetic words only.
    """

    note = "The unit price for product NW-100 is USD 9.50 per unit."
    cases = (
        ("roman numerals", {"section_footnote_pr": '<w:numFmt w:val="lowerRoman"/>'}),
        ("page restart", {"section_footnote_pr": '<w:numRestart w:val="eachPage"/>'}),
        ("custom mark", {"custom_mark": True}),
        ("note in a header", {"header_reference": True}),
        (
            "two numbering blocks",
            {
                "sect_pr_xml": (
                    "<w:sectPr><w:footnotePr><w:numFmt w:val=\"decimal\"/></w:footnotePr>"
                    "<w:footnotePr><w:numFmt w:val=\"lowerRoman\"/></w:footnotePr></w:sectPr>"
                )
            },
        ),
    )
    for name, options in cases:
        text, accepted, rejected = _cited_footnote_facts(_docx_with_displayed_footnote([("42", note)], **options))
        assert rejected == [], name
        fact = next(item for item in accepted if item.attributes.get("unit_price") == "9.50")
        assert fact.section == "1.1", name
        assert fact.citations[0].section == "Footnote XML id 42", name
        assert fact.citations[0].quote == note
        assert fact.citations[0].quote in text
        assert "[footnote XML id 42]" in text
        assert "[footnote 42]" not in text
        assert "[footnote 1]" not in text


def test_repeated_footnote_copies_are_counted_once() -> None:
    """A compatibility copy of the same note is still one footnote.

    Two copies that name different notes are not counted. Synthetic words only.
    """

    note = "The unit price for product NW-100 is USD 9.50 per unit."
    same = """<mc:AlternateContent xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006">
      <mc:Choice><w:r><w:footnoteReference w:id="42"/></w:r></mc:Choice>
      <mc:Fallback><w:r><w:footnoteReference w:id="42"/></w:r></mc:Fallback>
    </mc:AlternateContent>"""
    different = """<mc:AlternateContent xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006">
      <mc:Choice><w:r><w:footnoteReference w:id="42"/></w:r></mc:Choice>
      <mc:Fallback><w:r><w:footnoteReference w:id="7"/></w:r></mc:Fallback>
    </mc:AlternateContent>"""
    text, accepted, rejected = _cited_footnote_facts(
        _docx_with_displayed_footnote([("42", note)], reference_xml=same)
    )
    assert rejected == []
    fact = next(item for item in accepted if item.attributes.get("unit_price") == "9.50")
    assert fact.citations[0].section == "Footnote 1"
    assert "[footnote 1]" in text
    other = "The unit price for product NW-200 is USD 8.25 per unit."
    text, accepted, rejected = _cited_footnote_facts(
        _docx_with_displayed_footnote([("42", note), ("7", other)], reference_xml=different)
    )
    assert rejected == []
    sections = {fact.citations[0].section for fact in accepted}
    assert sections == {"Footnote XML id 42", "Footnote XML id 7"}
    assert "[footnote 1]" not in text


def test_a_deleted_footnote_reference_does_not_take_a_page_number() -> None:
    """A reference that was deleted is not footnote 1 after the change is accepted.

    A deleted earlier reference also does not push the remaining note to footnote 2.
    Synthetic words only.
    """

    note = "The unit price for product NW-100 is USD 9.50 per unit."
    deleted = (
        '<w:del w:id="1" w:author="Synthetic Counsel" w:date="2026-10-08T12:00:00Z">'
        '<w:r><w:footnoteReference w:id="42"/></w:r></w:del>'
    )
    text, accepted, rejected = _cited_footnote_facts(
        _docx_with_displayed_footnote([("42", note)], reference_xml=deleted)
    )
    assert rejected == []
    fact = next(item for item in accepted if item.attributes.get("unit_price") == "9.50")
    assert fact.citations[0].section == "Footnote XML id 42"
    assert fact.citations[0].quote == note
    assert "[footnote 1]" not in text

    live_after_deletion = deleted.replace('w:id="42"', 'w:id="99"') + '<w:r><w:footnoteReference w:id="42"/></w:r>'
    text, accepted, rejected = _cited_footnote_facts(
        _docx_with_displayed_footnote([("42", note)], reference_xml=live_after_deletion)
    )
    assert rejected == []
    fact = next(item for item in accepted if item.attributes.get("unit_price") == "9.50")
    assert fact.citations[0].section == "Footnote 1"
    assert fact.citations[0].quote == note


def test_a_damaged_unused_part_does_not_block_the_footnote_number() -> None:
    """A broken part that is not a header, footer, or comment still leaves the note readable.

    Synthetic words only.
    """

    note = "The unit price for product NW-100 is USD 9.50 per unit."
    source = BytesIO(_docx_with_displayed_footnote([("42", note)]))
    buffer = BytesIO()
    with ZipFile(source) as incoming, ZipFile(buffer, "w") as outgoing:
        for item in incoming.infolist():
            outgoing.writestr(item.filename, incoming.read(item.filename))
        outgoing.writestr(
            "word/theme/theme1.xml",
            '<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">MARKER</a:theme>',
        )
    data = bytearray(buffer.getvalue())
    marker = data.find(b"MARKER")
    assert marker > 0
    data[marker] = ord("X")
    text, accepted, rejected = _cited_footnote_facts(bytes(data))
    assert rejected == []
    fact = next(item for item in accepted if item.attributes.get("unit_price") == "9.50")
    assert fact.citations[0].section == "Footnote 1"
    assert fact.citations[0].quote == note
    assert f"[footnote 1] {note}" in text.splitlines()


def test_a_text_box_and_the_words_after_it_stay_separate() -> None:
    box = "Customer shall pay a late fee."
    following = "Customer shall deliver goods."
    document = f"""<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p>
      <w:r>
        <w:drawing>
          <w:txbxContent><w:p><w:r><w:t>{box}</w:t></w:r></w:p></w:txbxContent>
        </w:drawing>
      </w:r>
      <w:r><w:t>{following}</w:t></w:r>
    </w:p>
  </w:body>
</w:document>
"""
    buffer = BytesIO()
    with ZipFile(buffer, "w") as package:
        package.writestr("word/document.xml", document)
    extracted = extract_upload("split-box.docx", buffer.getvalue())
    assert f"[text box] {box}" in extracted.text.splitlines()
    assert following in extracted.text.splitlines()
    assert f"{box}{following}" not in extracted.text


def test_a_text_box_between_body_runs_keeps_the_sentence_together() -> None:
    """A box anchored in the middle of a sentence does not split that sentence.

    The box stays on its own line. The notice day count stays with the notice
    words, so the anniversary notice is still read. Synthetic words only.
    """

    before = "Customer shall give written notice at least "
    box = "Rates remain fixed."
    after = "thirty (30) days before each anniversary of the Effective Date."
    sentence = f"{before}{after}"
    document = f"""<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:r><w:t>1. Pricing</w:t></w:r></w:p>
    <w:p>
      <w:r><w:t>{before}</w:t></w:r>
      <w:r>
        <w:drawing>
          <w:txbxContent><w:p><w:r><w:t>{box}</w:t></w:r></w:p></w:txbxContent>
        </w:drawing>
      </w:r>
      <w:r><w:t>{after}</w:t></w:r>
    </w:p>
  </w:body>
</w:document>
"""
    buffer = BytesIO()
    with ZipFile(buffer, "w") as package:
        package.writestr("word/document.xml", document)
    payload = buffer.getvalue()
    extracted = extract_upload("synthetic-split-notice.docx", payload)
    assert sentence in extracted.text.splitlines()
    assert f"[text box] {box}" in extracted.text.splitlines()
    assert before.strip() not in extracted.text.splitlines()
    assert after not in extracted.text.splitlines()

    response = client.post(
        "/v1/agreements/files",
        data={"manifest": '{"base": {"name": "Synthetic Notice", "role": "base", "filename": "synthetic-split-notice.docx"}}'},
        files=[("files", ("synthetic-split-notice.docx", payload, "application/vnd.openxmlformats-officedocument.wordprocessingml.document"))],
    )
    assert response.status_code == 200, response.text
    facts = response.json()["facts"]
    notice = next(fact for fact in facts if fact["attributes"].get("notice_days_before_anniversary") == 30)
    citation = notice["citations"][0]
    assert notice["section"] == "1"
    assert citation["section"] == "1"
    assert citation["quote"] == sentence
    assert box not in citation["quote"]


def test_a_leading_text_box_does_not_indent_the_following_heading() -> None:
    """Space, a tab, or a line break before a box must not stick to the next line.

    The heading stays exactly ``1. Pricing``, so the price stays in section 1.
    Synthetic words only.
    """

    note = "See the box."
    price = "The unit price for product NW-100 is USD 9.50 per unit."

    def paragraph(before: str) -> str:
        return f"""<w:p>
      {before}
      <w:r>
        <w:drawing>
          <w:txbxContent><w:p><w:r><w:t>{note}</w:t></w:r></w:p></w:txbxContent>
        </w:drawing>
      </w:r>
      <w:r><w:t>1. Pricing</w:t></w:r>
    </w:p>
    <w:p><w:r><w:t>{price}</w:t></w:r></w:p>"""

    cases = (
        '<w:r><w:t xml:space="preserve"> </w:t></w:r>',
        "<w:r><w:tab/></w:r>",
        "<w:r><w:br/></w:r>",
    )
    for before in cases:
        document = f"""<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    {paragraph(before)}
  </w:body>
</w:document>
"""
        buffer = BytesIO()
        with ZipFile(buffer, "w") as package:
            package.writestr("word/document.xml", document)
        payload = buffer.getvalue()
        extracted = extract_upload("synthetic-leading-box.docx", payload)
        assert "1. Pricing" in extracted.text.splitlines(), extracted.text
        assert " 1. Pricing" not in extracted.text.splitlines()
        assert "\t1. Pricing" not in extracted.text
        response = client.post(
            "/v1/agreements/files",
            data={"manifest": '{"base": {"name": "Synthetic Leading Box", "role": "base", "filename": "synthetic-leading-box.docx"}}'},
            files=[("files", ("synthetic-leading-box.docx", payload, "application/vnd.openxmlformats-officedocument.wordprocessingml.document"))],
        )
        assert response.status_code == 200, response.text
        fact = next(item for item in response.json()["facts"] if item["attributes"].get("unit_price") == "9.50")
        assert fact["section"] == "1"
        assert fact["citations"][0]["quote"] == price


def test_a_text_box_in_the_first_table_cell_does_not_cover_the_later_cell() -> None:
    """A late-fee text box in the first cell stays in that cell.

    The unit price in a later cell keeps the section locator. The two quotes
    do not share a line. Synthetic words only.
    """

    box = "Customer shall pay a late fee of one percent (1%) per month."
    price = "The unit price for product NW-100 is USD 12.40 per unit."
    document = f"""<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:r><w:t>1. Pricing</w:t></w:r></w:p>
    <w:tbl>
      <w:tr>
        <w:tc>
          <w:p>
            <w:r>
              <w:drawing>
                <w:txbxContent><w:p><w:r><w:t>{box}</w:t></w:r></w:p></w:txbxContent>
              </w:drawing>
            </w:r>
          </w:p>
        </w:tc>
        <w:tc><w:p><w:r><w:t>{price}</w:t></w:r></w:p></w:tc>
      </w:tr>
    </w:tbl>
  </w:body>
</w:document>
"""
    buffer = BytesIO()
    with ZipFile(buffer, "w") as package:
        package.writestr("word/document.xml", document)
    payload = buffer.getvalue()
    extracted = extract_upload("synthetic-table-box.docx", payload)
    assert extracted.text.splitlines() == [
        "1. Pricing",
        f"[text box] {box}",
        price,
    ]
    assert f"[text box] {box} | {price}" not in extracted.text

    response = client.post(
        "/v1/agreements/files",
        data={"manifest": '{"base": {"name": "Synthetic Table Notes", "role": "base", "filename": "synthetic-table-box.docx"}}'},
        files=[("files", ("synthetic-table-box.docx", payload, "application/vnd.openxmlformats-officedocument.wordprocessingml.document"))],
    )
    assert response.status_code == 200, response.text
    facts = response.json()["facts"]
    price_fact = next(fact for fact in facts if fact["attributes"].get("unit_price") == "12.40")
    price_citation = price_fact["citations"][0]
    assert price_fact["section"] == "1"
    assert price_citation["section"] == "1"
    assert price_citation["quote"] == price
    assert box not in price_citation["quote"]
    fee_fact = next(fact for fact in facts if fact["attributes"].get("late_fee_percent") == "1")
    fee_citation = fee_fact["citations"][0]
    assert fee_fact["section"] == "1"
    assert fee_citation["section"] == "Text box in section 1"
    assert fee_citation["quote"] == box
    assert price not in fee_citation["quote"]
    for fact in facts:
        for citation in fact["citations"]:
            assert not (box in citation["quote"] and price in citation["quote"])


def test_a_text_box_that_disagrees_with_its_section_is_still_a_conflict() -> None:
    body = "Customer shall pay each undisputed invoice within thirty (30) days after the invoice date."
    box = "Customer shall pay each undisputed invoice within sixty (60) days after the invoice date."
    document = f"""<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:r><w:t>1.1 Payment. {body}</w:t></w:r></w:p>
    <w:p>
      <w:r>
        <w:drawing>
          <w:txbxContent><w:p><w:r><w:t>{box}</w:t></w:r></w:p></w:txbxContent>
        </w:drawing>
      </w:r>
    </w:p>
  </w:body>
</w:document>
"""
    buffer = BytesIO()
    with ZipFile(buffer, "w") as package:
        package.writestr("word/document.xml", document)
    payload = buffer.getvalue()
    response = client.post(
        "/v1/agreements/files",
        data={"manifest": '{"base": {"name": "Harborline Notes", "role": "base", "filename": "conflict.docx"}}'},
        files=[("files", ("conflict.docx", payload, "application/vnd.openxmlformats-officedocument.wordprocessingml.document"))],
    )
    assert response.status_code == 200, response.text
    body_json = response.json()
    nets = [fact for fact in body_json["facts"] if "net_days" in fact["attributes"]]
    assert {fact["attributes"]["net_days"] for fact in nets} == {30, 60}
    assert {fact["section"] for fact in nets} == {"1.1"}
    assert {fact["citations"][0]["section"] for fact in nets} == {"1.1", "Text box in section 1.1"}
    assert all(fact["attributes"].get("conflicting") is True for fact in nets)
    assert any("Section 1.1 states more than one net days" in warning for warning in body_json["warnings"])


def test_a_numbered_heading_inside_a_text_box_still_starts_a_section() -> None:
    heading = "1. Pricing"
    price = "The unit price for product NW-100 is USD 9.50 per unit."
    document = f"""<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p>
      <w:r>
        <w:drawing>
          <w:txbxContent>
            <w:p><w:r><w:t>{heading}</w:t></w:r></w:p>
            <w:p><w:r><w:t>{price}</w:t></w:r></w:p>
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
    payload = buffer.getvalue()
    extracted = extract_upload("pricing-box.docx", payload)
    assert extracted.text.splitlines() == [
        f"[text box] {heading}",
        f"[text box] {price}",
    ]
    response = client.post(
        "/v1/agreements/files",
        data={"manifest": '{"base": {"name": "Harborline Notes", "role": "base", "filename": "pricing-box.docx"}}'},
        files=[("files", ("pricing-box.docx", payload, "application/vnd.openxmlformats-officedocument.wordprocessingml.document"))],
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert any(section["section"] == "1" and section["title"] == "Pricing" for section in body["operative_sections"])
    fact = next(item for item in body["facts"] if item["attributes"].get("sku") == "NW-100")
    assert fact["operative"] is True
    assert fact["section"] == "1"
    assert fact["attributes"]["unit_price"] == "9.50"
    citation = fact["citations"][0]
    assert citation["section"] == "Text box in section 1"
    assert citation["quote"] == price
    assert citation["quote"] in extracted.text


def test_a_word_file_without_a_document_body_is_rejected() -> None:
    buffer = BytesIO()
    with ZipFile(buffer, "w") as package:
        package.writestr(
            "word/footnotes.xml",
            '<w:footnotes xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"/>',
        )
    try:
        extract_upload("incomplete.docx", buffer.getvalue())
    except IngestError as exc:
        message = str(exc)
    else:
        raise AssertionError("An incomplete Word file was read.")
    assert "no document body" in message


def test_a_textless_pdf_is_flagged_and_not_invented() -> None:
    response = client.post(
        "/v1/agreements/files",
        data={"manifest": '{"base": {"name": "Scan", "role": "base", "filename": "scan.pdf"}}'},
        files=[("files", ("scan.pdf", _empty_pdf(), "application/pdf"))],
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert any("no machine-readable text" in warning and "No text was guessed" in warning for warning in body["warnings"])
    assert not any("net_days" in fact["attributes"] for fact in body["facts"])


def test_upload_limits_reject_the_wrong_type_the_wrong_bytes_and_a_missing_key() -> None:
    wrong_type = client.post(
        "/v1/agreements/files",
        data={"manifest": '{"base": {"name": "Sheet", "role": "base", "filename": "notes.xlsx"}}'},
        files=[("files", ("notes.xlsx", b"not a workbook", "application/vnd.ms-excel"))],
    )
    assert wrong_type.status_code == 400
    disguised = client.post(
        "/v1/agreements/files",
        data={"manifest": '{"base": {"name": "Fake", "role": "base", "filename": "fake.pdf"}}'},
        files=[("files", ("fake.pdf", b"this is not a pdf", "application/pdf"))],
    )
    assert disguised.status_code == 400
    assert "not a PDF" in disguised.json()["detail"]
    huge = b"A" * (2_000_001)
    oversized = client.post(
        "/v1/agreements/files",
        data={"manifest": '{"base": {"name": "Big", "role": "base", "filename": "big.txt"}}'},
        files=[("files", ("big.txt", huge, "text/plain"))],
    )
    assert oversized.status_code == 400
    open_client = TestClient(app)
    missing = open_client.post(
        "/v1/agreements",
        json={"base": {"name": "Short", "role": "base", "text": "1. Pricing\n\n1.1 Payment. Customer shall pay each undisputed invoice within ten (10) days after the invoice date.\n"}},
    )
    assert missing.status_code == 401
    assert open_client.get("/health").status_code == 200


def _docx_with_redline_and_table() -> bytes:
    document = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p>
      <w:r><w:t xml:space="preserve">1.1 Payment. Customer shall pay each undisputed invoice within </w:t></w:r>
      <w:del><w:r><w:delText>forty-five (45)</w:delText></w:r></w:del>
      <w:ins><w:r><w:t>sixty (60)</w:t></w:r></w:ins>
      <w:r><w:t> days after the invoice date (Net 60).</w:t></w:r>
    </w:p>
    <w:tbl>
      <w:tr>
        <w:tc><w:p><w:r><w:t>NW-100</w:t></w:r></w:p></w:tc>
        <w:tc><w:p><w:r><w:t>USD 12.40</w:t></w:r></w:p></w:tc>
      </w:tr>
    </w:tbl>
  </w:body>
</w:document>
"""
    buffer = BytesIO()
    with ZipFile(buffer, "w") as package:
        package.writestr("word/document.xml", document)
    return buffer.getvalue()


def _docx_with_notes() -> bytes:
    document = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p>
      <w:commentRangeStart w:id="1"/>
      <w:r><w:t>1.1 Price. See the footnote.</w:t></w:r>
      <w:r><w:footnoteReference w:id="1"/></w:r>
      <w:commentRangeEnd w:id="1"/>
      <w:r><w:commentReference w:id="1"/></w:r>
    </w:p>
    <w:p>
      <w:r>
        <w:drawing>
          <w:txbxContent>
            <w:p><w:r><w:t>The text box states a late fee of one percent (1%) per month.</w:t></w:r></w:p>
          </w:txbxContent>
        </w:drawing>
      </w:r>
    </w:p>
  </w:body>
</w:document>
"""
    footnotes = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:footnotes xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:footnote w:type="separator" w:id="-1"><w:p><w:r><w:t> </w:t></w:r></w:p></w:footnote>
  <w:footnote w:id="1"><w:p><w:r><w:t>The unit price in the footnote is USD 9.50 per unit.</w:t></w:r></w:p></w:footnote>
</w:footnotes>
"""
    comments = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:comment w:id="1" w:author="Ada Reviewer" w:date="2025-03-01T00:00:00Z">
    <w:p><w:r><w:t>This comment is not contract text.</w:t></w:r></w:p>
  </w:comment>
</w:comments>
"""
    buffer = BytesIO()
    with ZipFile(buffer, "w") as package:
        package.writestr("word/document.xml", document)
        package.writestr("word/footnotes.xml", footnotes)
        package.writestr("word/comments.xml", comments)
    return buffer.getvalue()


def _cited_footnote_facts(payload: bytes):
    text, _revisions, _annotations, _warnings = read_docx(payload, "synthetic-footnote.docx")
    document = PreparedDocument(
        document_id="doc",
        name="Synthetic Footnote",
        role="base",
        text=text,
        manifest_effective_date=None,
        filename="synthetic-footnote.docx",
    )
    ledger = build_ledger(document, [])
    candidates, _rule_warnings = extract_rules(ledger, [])
    accepted, rejected = review_candidates(candidates, {"doc": ("Synthetic Footnote", text)})
    return text, accepted, rejected


def _docx_with_displayed_footnote(
    notes: list[tuple[str, str]],
    *,
    section_footnote_pr: str = "",
    settings_footnote_pr: str = "",
    sect_pr_xml: str = "",
    header_reference: bool = False,
    custom_mark: bool = False,
    reference_xml: str = "",
) -> bytes:
    """Build a synthetic Word file. ``notes`` is (XML id, words) in reference order."""

    custom = ' w:customMarkFollows="1"' if custom_mark else ""
    references = reference_xml or "".join(
        f'<w:r><w:footnoteReference w:id="{note_id}"{custom}/></w:r>' for note_id, _words in notes
    )
    if sect_pr_xml:
        sect_pr = sect_pr_xml
    elif section_footnote_pr:
        sect_pr = f"<w:sectPr><w:footnotePr>{section_footnote_pr}</w:footnotePr></w:sectPr>"
    else:
        sect_pr = ""
    document = f"""<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:r><w:t>1. Pricing</w:t></w:r></w:p>
    <w:p>
      <w:r><w:t>1.1 Price. See the footnote.</w:t></w:r>
      {references}
    </w:p>
    {sect_pr}
  </w:body>
</w:document>
"""
    stored = "".join(
        f'<w:footnote w:id="{note_id}"><w:p><w:r><w:t>{words}</w:t></w:r></w:p></w:footnote>'
        for note_id, words in reversed(notes)
    )
    footnotes = f"""<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:footnotes xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:footnote w:type="separator" w:id="-1"><w:p><w:r><w:t> </w:t></w:r></w:p></w:footnote>
  {stored}
</w:footnotes>
"""
    buffer = BytesIO()
    with ZipFile(buffer, "w") as package:
        package.writestr("word/document.xml", document)
        package.writestr("word/footnotes.xml", footnotes)
        if settings_footnote_pr:
            package.writestr(
                "word/settings.xml",
                f"""<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:footnotePr>{settings_footnote_pr}</w:footnotePr>
</w:settings>
""",
            )
            package.writestr(
                "word/_rels/document.xml.rels",
                """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings" Target="settings.xml"/>
</Relationships>
""",
            )
        if header_reference:
            package.writestr(
                "word/header1.xml",
                """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:p><w:r><w:footnoteReference w:id="99"/></w:r></w:p>
</w:hdr>
""",
            )
    return buffer.getvalue()


def _docx_with_cited_notes(footnote: str, box: str, deleted: str, comment: str) -> bytes:
    document = f"""<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:r><w:t>1. Pricing</w:t></w:r></w:p>
    <w:p>
      <w:commentRangeStart w:id="1"/>
      <w:r><w:t>1.1 Price. See the footnote.</w:t></w:r>
      <w:r><w:footnoteReference w:id="1"/></w:r>
      <w:commentRangeEnd w:id="1"/>
      <w:r><w:commentReference w:id="1"/></w:r>
    </w:p>
    <w:p><w:r><w:drawing/></w:r></w:p>
    <w:p>
      <w:r>
        <w:drawing>
          <w:txbxContent>
            <w:p><w:r><w:t>{box}</w:t></w:r></w:p>
          </w:txbxContent>
        </w:drawing>
      </w:r>
    </w:p>
    <w:p><w:del><w:r><w:delText>{deleted}</w:delText></w:r></w:del></w:p>
  </w:body>
</w:document>
"""
    footnotes = f"""<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:footnotes xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:footnote w:type="separator" w:id="-1"><w:p><w:r><w:t> </w:t></w:r></w:p></w:footnote>
  <w:footnote w:id="1"><w:p><w:r><w:t>{footnote}</w:t></w:r></w:p></w:footnote>
</w:footnotes>
"""
    comments = f"""<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:comment w:id="1" w:author="Ada Reviewer" w:date="2025-03-01T00:00:00Z">
    <w:p><w:r><w:t>{comment}</w:t></w:r></w:p>
  </w:comment>
</w:comments>
"""
    buffer = BytesIO()
    with ZipFile(buffer, "w") as package:
        package.writestr("word/document.xml", document)
        package.writestr("word/footnotes.xml", footnotes)
        package.writestr("word/comments.xml", comments)
    return buffer.getvalue()


def _pdf_table() -> bytes:
    content = b"""0.5 w
72 700 m 360 700 l S
72 680 m 360 680 l S
72 660 m 360 660 l S
72 700 m 72 660 l S
200 700 m 200 660 l S
360 700 m 360 660 l S
BT /F1 10 Tf 80 686 Td (NW-100) Tj ET
BT /F1 10 Tf 210 686 Td (USD 12.40) Tj ET
"""
    objects = [
        b"1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n",
        b"2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n",
        b"3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >> endobj\n",
        b"4 0 obj << /Length " + str(len(content)).encode("ascii") + b" >> stream\n" + content + b"endstream\nendobj\n",
        b"5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj\n",
    ]
    return _assemble_pdf(objects)


def _empty_pdf() -> bytes:
    objects = [
        b"1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n",
        b"2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n",
        b"3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >> endobj\n",
        b"4 0 obj << /Length 0 >> stream\n\nendstream\nendobj\n",
    ]
    return _assemble_pdf(objects)


def _assemble_pdf(objects: list[bytes]) -> bytes:
    header = b"%PDF-1.4\n"
    body = b""
    offsets = [0]
    cursor = len(header)
    for item in objects:
        offsets.append(cursor)
        body += item
        cursor += len(item)
    xref = [b"xref\n", f"0 {len(offsets)}\n".encode("ascii"), b"0000000000 65535 f \n"]
    for offset in offsets[1:]:
        xref.append(f"{offset:010d} 00000 n \n".encode("ascii"))
    trailer = f"trailer << /Size {len(offsets)} /Root 1 0 R >>\nstartxref\n{cursor}\n%%EOF\n".encode("ascii")
    return header + body + b"".join(xref) + trailer
