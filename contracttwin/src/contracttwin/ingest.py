"""Read plain text, PDF, and Word files into the text the quote checker uses.

The quote checker compares citations with this extracted text, not with the
original bytes. If a reader changes a character, the citation fails instead of
being loosened. A scanned PDF page is flagged. Its words are not guessed.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from io import BytesIO

import pdfplumber

from contracttwin.docx_reader import DocxReadError, read_docx
from contracttwin.models import Revision
from contracttwin.textutil import MAX_DOCUMENT_CHARS, normalize_newlines

MAX_UPLOAD_BYTES = 2_000_000
MAX_DOCUMENTS = 12
ALLOWED_SUFFIXES = {".txt", ".text", ".md", ".pdf", ".docx"}


class IngestError(ValueError):
    """The file could not be read as contract text."""


@dataclass(frozen=True)
class Extraction:
    text: str
    revisions: list[Revision] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)


def suffix_of(filename: str | None) -> str:
    if not filename:
        return ""
    return os.path.splitext(os.path.basename(filename))[1].lower()


def extract_upload(filename: str, data: bytes) -> Extraction:
    if len(data) > MAX_UPLOAD_BYTES:
        raise IngestError(f"{os.path.basename(filename)} is larger than {MAX_UPLOAD_BYTES} bytes.")
    if not data:
        raise IngestError(f"{os.path.basename(filename)} is empty.")
    suffix = suffix_of(filename)
    if suffix not in ALLOWED_SUFFIXES:
        raise IngestError(f"{os.path.basename(filename)} is not a supported file. Use .txt, .pdf, or .docx.")
    if suffix in {".txt", ".text", ".md"}:
        return Extraction(text=decode_text(data, filename))
    if suffix == ".pdf":
        return extract_pdf(data, filename)
    return extract_docx(data, filename)


def decode_text(data: bytes, filename: str) -> str:
    if data.startswith(b"%PDF") or data.startswith(b"PK"):
        raise IngestError(f"{os.path.basename(filename)} is not plain text.")
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise IngestError(f"{os.path.basename(filename)} is not UTF-8 text.") from exc
    return guard_length(normalize_newlines(text), filename)


def extract_pdf(data: bytes, filename: str) -> Extraction:
    if not data.startswith(b"%PDF"):
        raise IngestError(f"{os.path.basename(filename)} is not a PDF.")
    warnings: list[str] = []
    parts: list[str] = []
    try:
        with pdfplumber.open(BytesIO(data)) as pdf:
            if not pdf.pages:
                raise IngestError(f"{os.path.basename(filename)} has no pages.")
            for index, page in enumerate(pdf.pages, start=1):
                text = page.extract_text() or ""
                table_lines = _table_lines(page.extract_tables() or [])
                if not text.strip() and not table_lines:
                    images = list(getattr(page, "images", []) or [])
                    if images:
                        message = (
                            f"Page {index} looks scanned ({len(images)} image, no machine-readable text). "
                            "No text was guessed."
                        )
                    else:
                        message = f"Page {index} has no machine-readable text. No text was guessed."
                    warnings.append(message)
                    parts.append(f"[page {index}: no machine-readable text]")
                    continue
                if text.strip():
                    parts.append(text.strip())
                for line in table_lines:
                    if line not in text:
                        parts.append(line)
    except IngestError:
        raise
    except Exception as exc:
        raise IngestError(f"{os.path.basename(filename)} could not be read as a PDF.") from exc
    return Extraction(text=guard_length(normalize_newlines("\n".join(parts)), filename), warnings=warnings)


def extract_docx(data: bytes, filename: str) -> Extraction:
    try:
        text, revisions, warnings = read_docx(data, filename)
    except DocxReadError as exc:
        raise IngestError(str(exc)) from exc
    return Extraction(text=guard_length(normalize_newlines(text), filename), revisions=revisions, warnings=warnings)


def guard_length(text: str, filename: str) -> str:
    if len(text) > MAX_DOCUMENT_CHARS:
        raise IngestError(f"{os.path.basename(filename)} has more than {MAX_DOCUMENT_CHARS} characters.")
    if not text.strip():
        raise IngestError(f"{os.path.basename(filename)} has no readable text.")
    return text


def _table_lines(tables: list) -> list[str]:
    lines: list[str] = []
    for table in tables:
        for row in table or []:
            cells = [_cell(cell) for cell in (row or [])]
            if any(cells):
                lines.append(" | ".join(cells))
    return lines


def _cell(value: object) -> str:
    if value is None:
        return ""
    return " ".join(str(value).split())
