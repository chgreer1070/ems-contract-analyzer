"""Read a Word file, including tables and tracked changes.

The words a reader would see after accepting the changes are the operative
text. Insertions are kept. Deletions are left out of that text and listed in
the redline history. The quote checker uses only the operative text.
"""

from __future__ import annotations

import os
from io import BytesIO
from xml.etree import ElementTree
from zipfile import BadZipFile, ZipFile

from contracttwin.models import Revision

WORD_NAMESPACE = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"


class DocxReadError(ValueError):
    """The Word file could not be read."""


def read_docx(data: bytes, filename: str) -> tuple[str, list[Revision], list[str]]:
    if not data.startswith(b"PK"):
        raise DocxReadError(f"{os.path.basename(filename)} is not a Word file.")
    try:
        with ZipFile(BytesIO(data)) as package:
            try:
                xml = package.read("word/document.xml")
            except KeyError as exc:
                raise DocxReadError(f"{os.path.basename(filename)} has no document body.") from exc
    except BadZipFile as exc:
        raise DocxReadError(f"{os.path.basename(filename)} could not be read as a Word file.") from exc
    try:
        root = ElementTree.fromstring(xml)
    except ElementTree.ParseError as exc:
        raise DocxReadError(f"{os.path.basename(filename)} has a document body that could not be read.") from exc
    body = root.find(f"{WORD_NAMESPACE}body")
    if body is None:
        raise DocxReadError(f"{os.path.basename(filename)} has no document body.")
    lines: list[str] = []
    revisions: list[Revision] = []
    for child in list(body):
        if child.tag == f"{WORD_NAMESPACE}p":
            text, found = _paragraph(child, "paragraph")
            revisions.extend(found)
            if text.strip():
                lines.append(text.strip())
        elif child.tag == f"{WORD_NAMESPACE}tbl":
            table_lines, found = _table(child)
            lines.extend(table_lines)
            revisions.extend(found)
    return "\n".join(lines), revisions, []


def _paragraph(paragraph, location: str) -> tuple[str, list[Revision]]:
    chunks: list[str] = []
    revisions: list[Revision] = []

    def walk(node) -> None:
        for child in list(node):
            if child.tag == f"{WORD_NAMESPACE}ins":
                inserted = _visible_text(child, deleted=False)
                if inserted:
                    revisions.append(Revision(kind="insertion", text=inserted, location=location))
                    chunks.append(inserted)
            elif child.tag == f"{WORD_NAMESPACE}del":
                deleted = _visible_text(child, deleted=True)
                if deleted:
                    revisions.append(Revision(kind="deletion", text=deleted, location=location))
            elif child.tag == f"{WORD_NAMESPACE}t":
                chunks.append(child.text or "")
            elif child.tag == f"{WORD_NAMESPACE}tab":
                chunks.append("\t")
            elif child.tag in {f"{WORD_NAMESPACE}br", f"{WORD_NAMESPACE}cr"}:
                chunks.append("\n")
            else:
                walk(child)

    walk(paragraph)
    return "".join(chunks), revisions


def _visible_text(node, deleted: bool) -> str:
    chunks: list[str] = []
    wanted = f"{WORD_NAMESPACE}delText" if deleted else f"{WORD_NAMESPACE}t"
    for child in node.iter():
        if child.tag == wanted:
            chunks.append(child.text or "")
        elif child.tag == f"{WORD_NAMESPACE}tab":
            chunks.append("\t")
    return "".join(chunks)


def _table(table) -> tuple[list[str], list[Revision]]:
    lines: list[str] = []
    revisions: list[Revision] = []
    for row_number, row in enumerate(table.findall(f"{WORD_NAMESPACE}tr"), start=1):
        cells: list[str] = []
        location = f"table row {row_number}"
        for cell in row.findall(f"{WORD_NAMESPACE}tc"):
            parts: list[str] = []
            for paragraph in cell.findall(f"{WORD_NAMESPACE}p"):
                text, found = _paragraph(paragraph, location)
                revisions.extend(found)
                if text.strip():
                    parts.append(text.strip())
            cells.append(" ".join(parts))
        if any(cell.strip() for cell in cells):
            lines.append(" | ".join(cells))
    return lines, revisions
