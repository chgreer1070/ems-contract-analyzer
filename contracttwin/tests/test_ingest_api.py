"""File reading and the HTTP service."""

from __future__ import annotations

from io import BytesIO

from docx import Document
from fastapi.testclient import TestClient

from contracttwin.api import app
from contracttwin.ingest import IngestError, extract_upload

from .conftest import FIXTURES, read_fixture

client = TestClient(app)


def test_word_round_trip_keeps_the_amendment_result() -> None:
    base = _docx_bytes(read_fixture("harborline_msa.txt"))
    amendment = _docx_bytes(read_fixture("harborline_amendment_1.txt"))
    response = client.post(
        "/v1/agreements/files",
        data={
            "manifest": """{
              "base": {"name": "Harborline MSA", "role": "base", "filename": "harborline_msa.docx", "effective_date": "2024-01-15"},
              "amendments": [{"name": "Amendment No. 1", "role": "amendment", "filename": "harborline_amendment_1.docx", "effective_date": "2025-03-01"}]
            }"""
        },
        files=[
            ("files", ("harborline_msa.docx", base, "application/vnd.openxmlformats-officedocument.wordprocessingml.document")),
            ("files", ("harborline_amendment_1.docx", amendment, "application/vnd.openxmlformats-officedocument.wordprocessingml.document")),
        ],
    )
    assert response.status_code == 200, response.text
    body = response.json()
    nets = [fact["attributes"]["net_days"] for fact in body["facts"] if fact["operative"] and "net_days" in fact["attributes"]]
    assert nets == [60]
    assert body["rejected"] == []
    follow = client.get(f"/v1/agreements/{body['analysis_id']}")
    assert follow.status_code == 200
    assert follow.json()["analysis_id"] == body["analysis_id"]


def test_pdf_sentence_is_cited_verbatim() -> None:
    sentence = "2.1 Unit Prices. The unit price for product NW-100 is USD 12.40 per unit."
    payload = _pdf_bytes(sentence)
    extracted = extract_upload("prices.pdf", payload)
    assert sentence in extracted
    response = client.post(
        "/v1/agreements/files",
        data={"manifest": '{"base": {"name": "Price page", "role": "base", "filename": "prices.pdf"}}'},
        files=[("files", ("prices.pdf", payload, "application/pdf"))],
    )
    assert response.status_code == 200, response.text
    body = response.json()
    quotes = [citation["quote"] for fact in body["facts"] for citation in fact["citations"]]
    assert any(sentence in quote and sentence in extracted for quote in quotes)


def test_json_endpoint_reads_text_and_rejects_a_bad_date() -> None:
    response = client.post(
        "/v1/agreements",
        json={
            "base": {
                "name": "Short",
                "role": "base",
                "text": "1. Pricing\n\n1.1 Payment. Customer shall pay each undisputed invoice within ten (10) days after the invoice date (Net 10).\n",
            },
            "amendments": [],
        },
    )
    assert response.status_code == 200, response.text
    assert response.json()["facts"]
    bad = client.post(
        "/v1/agreements",
        json={"base": {"name": "Short", "role": "base", "text": "Hello agreement text that is long enough.", "effective_date": "March 1"}},
    )
    assert bad.status_code == 400
    missing = client.get("/v1/agreements/does-not-exist")
    assert missing.status_code == 404


def test_health_and_unsupported_file() -> None:
    health = client.get("/health")
    assert health.status_code == 200
    assert health.json()["status"] == "ok"
    schema = client.get("/openapi.json")
    assert schema.status_code == 200
    assert "/v1/agreements" in schema.json()["paths"]
    assert "/v1/agreements/files" in schema.json()["paths"]
    try:
        extract_upload("notes.xlsx", b"not a workbook")
    except IngestError as exc:
        assert "not a supported file" in str(exc)
    else:
        raise AssertionError("An unsupported file should be refused.")
    empty = client.post("/v1/agreements", json={"base": {"name": "Empty", "role": "base", "text": "   "}})
    assert empty.status_code == 400


def test_same_text_returns_the_same_id() -> None:
    payload = {
        "base": {"name": "Short", "role": "base", "text": (FIXTURES / "harborline_msa.txt").read_text(encoding="utf-8")},
        "amendments": [],
    }
    first = client.post("/v1/agreements", json=payload)
    second = client.post("/v1/agreements", json=payload)
    assert first.status_code == 200
    assert first.json()["analysis_id"] == second.json()["analysis_id"]


def _docx_bytes(text: str) -> bytes:
    document = Document()
    for line in text.split("\n"):
        document.add_paragraph(line)
    buffer = BytesIO()
    document.save(buffer)
    return buffer.getvalue()


def _pdf_bytes(text: str) -> bytes:
    safe = text.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")
    stream = f"BT /F1 12 Tf 72 720 Td ({safe}) Tj ET".encode("latin-1")
    objects = [
        b"1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n",
        b"2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n",
        b"3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >> endobj\n",
        b"4 0 obj << /Length " + str(len(stream)).encode("ascii") + b" >> stream\n" + stream + b"\nendstream\nendobj\n",
        b"5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj\n",
    ]
    header = b"%PDF-1.4\n"
    body = b""
    offsets = [0]
    cursor = len(header)
    for item in objects:
        offsets.append(cursor)
        body += item
        cursor += len(item)
    xref_start = cursor
    xref = [b"xref\n", f"0 {len(offsets)}\n".encode("ascii"), b"0000000000 65535 f \n"]
    for offset in offsets[1:]:
        xref.append(f"{offset:010d} 00000 n \n".encode("ascii"))
    trailer = (
        f"trailer << /Size {len(offsets)} /Root 1 0 R >>\nstartxref\n{xref_start}\n%%EOF\n".encode("ascii")
    )
    return header + body + b"".join(xref) + trailer
