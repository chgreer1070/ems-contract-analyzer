"""Read plain text, PDF, and Word files into the text the quote checker uses.

The quote checker compares citations with this extracted text, not with the
original bytes. If a PDF extractor changes a character, the citation fails
instead of being loosened to a fuzzy match.
"""

from __future__ import annotations

import os
from io import BytesIO
from zipfile import BadZipFile

from pypdf import PdfReader
from pypdf.errors import PdfReadError
from docx import Document
from docx.opc.exceptions import PackageNotFoundError

from contracttwin.textutil import MAX_DOCUMENT_CHARS, normalize_newlines

MAX_UPLOAD_BYTES = 2_000_000


class IngestError(ValueError):
    """The file could not be read as contract text."""


def suffix_of(filename: str | None) -> str:
    if not filename:
        return ""
    return os.path.splitext(os.path.basename(filename))[1].lower()


def extract_upload(filename: str, data: bytes) -> str:
    if len(data) > MAX_UPLOAD_BYTES:
        raise IngestError(f"{os.path.basename(filename)} is larger than {MAX_UPLOAD_BYTES} bytes.")
    if not data:
        raise IngestError(f"{os.path.basename(filename)} is empty.")
    suffix = suffix_of(filename)
    if suffix in {".txt", ".text", ".md"}:
        return decode_text(data, filename)
    if suffix == ".pdf":
        return extract_pdf(data, filename)
    if suffix == ".docx":
        return extract_docx(data, filename)
    raise IngestError(
        f"{os.path.basename(filename)} is not a supported file. Use .txt, .pdf, or .docx."
    )


def decode_text(data: bytes, filename: str) -> str:
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise IngestError(f"{os.path.basename(filename)} is not UTF-8 text.") from exc
    return guard_length(normalize_newlines(text), filename)


def extract_pdf(data: bytes, filename: str) -> str:
    try:
        reader = PdfReader(BytesIO(data))
        pages = [(page.extract_text() or "") for page in reader.pages]
    except (PdfReadError, ValueError, TypeError) as exc:
        raise IngestError(f"{os.path.basename(filename)} could not be read as a PDF.") from exc
    return guard_length(normalize_newlines("\n".join(pages)), filename)


def extract_docx(data: bytes, filename: str) -> str:
    try:
        document = Document(BytesIO(data))
    except (PackageNotFoundError, BadZipFile, ValueError, KeyError) as exc:
        raise IngestError(f"{os.path.basename(filename)} could not be read as a Word file.") from exc
    text = "\n".join(paragraph.text for paragraph in document.paragraphs)
    return guard_length(normalize_newlines(text), filename)


def guard_length(text: str, filename: str) -> str:
    if len(text) > MAX_DOCUMENT_CHARS:
        raise IngestError(f"{os.path.basename(filename)} has more than {MAX_DOCUMENT_CHARS} characters.")
    if not text.strip():
        raise IngestError(f"{os.path.basename(filename)} has no readable text.")
    return text
