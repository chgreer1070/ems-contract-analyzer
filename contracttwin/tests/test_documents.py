"""Word tracked changes and PDF pages that have no readable text."""

from __future__ import annotations

from io import BytesIO
from zipfile import ZipFile

from fastapi.testclient import TestClient

from contracttwin.api import app
from contracttwin.ingest import extract_upload

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
