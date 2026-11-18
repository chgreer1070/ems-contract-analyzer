"""Read a Word file, including tables, footnotes, text boxes, and tracked changes.

The words a reader would see after accepting the changes are the operative
text. Insertions are kept. Deletions are left out of that text and listed in
the redline history. Each footnote paragraph is marked ``[footnote N]``. N is
the number on the page when decimal notes can be counted in order. When that
number cannot be counted, the marker says ``[footnote XML id N]`` so the XML
id is not shown as the page number. Each text-box paragraph is marked
``[text box]``. That label stays off to the side
when a numbered heading is recognized, and when the next amendment instruction
is recognized, so a heading or instruction inside a box is still found. The
label stays on the stored line. Inside a table, that line stays on its own
line: other cells in the row are not joined onto it. A box anchored between
two parts of one sentence stays on its own line, and those parts stay one
sentence. Comments stay notes. The quote checker uses only the operative text.
"""

from __future__ import annotations

import os
import posixpath
import re
from dataclasses import dataclass
from io import BytesIO
from urllib.parse import unquote
from xml.etree import ElementTree
from zipfile import BadZipFile, ZipFile

from contracttwin.models import Annotation, Revision

WORD_NAMESPACE = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
_REL_NAMESPACE = "{http://schemas.openxmlformats.org/package/2006/relationships}"
_OFFICE_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
_MC_NAMESPACE = "{http://schemas.openxmlformats.org/markup-compatibility/2006}"
_TEXT_BOX_LABEL = "[text box] "
_UNSET = object()
_UNRESOLVED = object()
_FOOTNOTE_START = re.compile(r"^[0-9]{1,9}$")
_COMMENT_TAGS = {
    f"{WORD_NAMESPACE}commentRangeStart",
    f"{WORD_NAMESPACE}commentRangeEnd",
    f"{WORD_NAMESPACE}commentReference",
}


class DocxReadError(ValueError):
    """The Word file could not be read."""


def read_docx(data: bytes, filename: str) -> tuple[str, list[Revision], list[Annotation], list[str]]:
    if not data.startswith(b"PK"):
        raise DocxReadError(f"{os.path.basename(filename)} is not a Word file.")
    try:
        with ZipFile(BytesIO(data)) as package:
            try:
                xml = package.read("word/document.xml")
            except KeyError as exc:
                raise DocxReadError(f"{os.path.basename(filename)} has no document body.") from exc
            footnotes_xml = _optional_zip(package, "word/footnotes.xml")
            comments_xml = _optional_zip(package, "word/comments.xml")
            try:
                root = ElementTree.fromstring(xml)
            except ElementTree.ParseError as exc:
                raise DocxReadError(
                    f"{os.path.basename(filename)} has a document body that could not be read."
                ) from exc
            body = _word_child(root, "body")
            if body is None:
                raise DocxReadError(f"{os.path.basename(filename)} has no document body.")
            footnote_labels = _displayed_footnote_labels(package, root) if footnotes_xml is not None else None
    except BadZipFile as exc:
        raise DocxReadError(f"{os.path.basename(filename)} could not be read as a Word file.") from exc
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
    if footnotes_xml is not None:
        lines.extend(_footnotes(footnotes_xml, footnote_labels))
    annotations = _comments(comments_xml) if comments_xml is not None else []
    return "\n".join(lines), revisions, annotations, []


def _paragraph(paragraph, location: str) -> tuple[str, list[Revision]]:
    body: list[str] = []
    pending_space: list[str] = []
    leading_boxes: list[str] = []
    trailing_boxes: list[str] = []
    revisions: list[Revision] = []
    body_started = False

    def add_body(text: str) -> None:
        nonlocal body_started
        if not text.strip():
            pending_space.append(text)
            return
        if body_started:
            body.extend(pending_space)
        pending_space.clear()
        body.append(text)
        body_started = True

    def walk(node) -> None:
        for child in list(node):
            if child.tag == f"{WORD_NAMESPACE}ins":
                inserted = _visible_text(child, deleted=False)
                if inserted:
                    revisions.append(Revision(kind="insertion", text=inserted, location=location))
                    add_body(inserted)
            elif child.tag == f"{WORD_NAMESPACE}del":
                deleted = _visible_text(child, deleted=True)
                if deleted:
                    revisions.append(Revision(kind="deletion", text=deleted, location=location))
            elif child.tag == f"{WORD_NAMESPACE}txbxContent" or child.tag.endswith("}textbox"):
                box_text, box_revisions = _paragraphs_in(child, "text box")
                revisions.extend(box_revisions)
                labeled = "\n".join(
                    f"{_TEXT_BOX_LABEL}{part.strip()}" for part in box_text.split("\n") if part.strip()
                )
                if labeled:
                    # A box before any body words stays in front. A box after
                    # body words have started is kept after the joined sentence.
                    (trailing_boxes if body_started else leading_boxes).append(labeled)
            elif child.tag in _COMMENT_TAGS:
                continue
            elif child.tag == f"{WORD_NAMESPACE}t":
                add_body(child.text or "")
            elif child.tag == f"{WORD_NAMESPACE}tab":
                add_body("\t")
            elif child.tag in {f"{WORD_NAMESPACE}br", f"{WORD_NAMESPACE}cr"}:
                add_body("\n")
            else:
                walk(child)

    walk(paragraph)
    if body_started:
        body.extend(pending_space)
    pieces: list[str] = []
    if leading_boxes:
        pieces.append("\n".join(leading_boxes))
    body_text = "".join(body)
    if body_text.strip():
        if pieces:
            pieces.append("\n")
        pieces.append(body_text)
    if trailing_boxes:
        if pieces:
            pieces.append("\n")
        pieces.append("\n".join(trailing_boxes))
    return "".join(pieces), revisions


def _paragraphs_in(node, location: str) -> tuple[str, list[Revision]]:
    chunks: list[str] = []
    revisions: list[Revision] = []
    for paragraph in node.findall(f"{WORD_NAMESPACE}p"):
        text, found = _paragraph(paragraph, location)
        revisions.extend(found)
        if text.strip():
            chunks.append(text.strip())
    return "\n".join(chunks), revisions


def _optional_zip(package: ZipFile, name: str) -> bytes | None:
    try:
        return package.read(name)
    except KeyError:
        return None


@dataclass(frozen=True)
class _FootnoteFields:
    fmt: object
    start: object
    restart: object


def _footnotes(xml: bytes, labels: dict[str, str] | None) -> list[str]:
    root = ElementTree.fromstring(xml)
    lines: list[str] = []
    for note in list(root):
        if note.tag != f"{WORD_NAMESPACE}footnote":
            continue
        if note.attrib.get(f"{WORD_NAMESPACE}type") in {"separator", "continuationSeparator"}:
            continue
        note_id = note.attrib.get(f"{WORD_NAMESPACE}id", "")
        text, _revisions = _paragraphs_in(note, f"footnote {note_id}")
        marker = _footnote_marker(note_id, labels)
        for paragraph in text.split("\n"):
            if paragraph.strip():
                lines.append(f"[footnote {marker}] {paragraph.strip()}")
    return lines


def _footnote_marker(note_id: str, labels: dict[str, str] | None) -> str:
    if labels is not None and note_id in labels:
        return labels[note_id]
    if note_id:
        return f"XML id {note_id}"
    return note_id


def _displayed_footnote_labels(package: ZipFile, document: ElementTree.Element) -> dict[str, str] | None:
    """Map each footnote XML id to the number on the page.

    ``w:id`` only locates the note. It is not the number Word shows. The count
    follows decimal numbering from the document settings and each section.
    When that number cannot be counted, None tells the caller to say the XML
    id outright instead of sending a reader to the wrong note.
    """

    defaults = _document_footnote_defaults(package)
    if defaults is None or _outside_footnote_reference(package):
        return None
    body = _word_child(document, "body")
    if body is None:
        return None
    labels: dict[str, str] = {}
    used: set[str] = set()
    next_number: int | None = None
    for nodes, sect_pr in _body_sections(body):
        mode = _section_footnote_mode(defaults, sect_pr)
        if mode is None:
            return None
        start, restart, explicit_start = mode
        if next_number is None or restart == "eachSect":
            next_number = start
        elif explicit_start and start != next_number:
            return None
        references = _footnote_references(nodes)
        if references is None:
            return None
        ids: list[str] = []
        for reference in references:
            note_id = _word_attr(reference, "id")
            custom = _word_attr(reference, "customMarkFollows")
            if (
                note_id is None
                or note_id in labels
                or note_id in ids
                or (custom is not None and custom not in {"0", "false", "off"})
            ):
                return None
            ids.append(note_id)
        for note_id in ids:
            label = str(next_number)
            if label in used:
                return None
            used.add(label)
            labels[note_id] = label
            next_number += 1
    return labels


def _document_footnote_defaults(package: ZipFile) -> _FootnoteFields | None:
    implicit = _FootnoteFields("decimal", 1, "continuous")
    try:
        rels = package.read("word/_rels/document.xml.rels")
    except KeyError:
        return implicit
    except BadZipFile:
        return None
    try:
        root = ElementTree.fromstring(rels)
    except ElementTree.ParseError:
        return None
    links = []
    for item in list(root):
        if item.tag != f"{_REL_NAMESPACE}Relationship":
            continue
        if item.attrib.get("TargetMode") == "External":
            continue
        if item.attrib.get("Type") == f"{_OFFICE_REL}/settings":
            links.append(item)
    if not links:
        return implicit
    if len(links) != 1:
        return None
    target = _resolve_part("word/document.xml", links[0].attrib.get("Target", ""))
    if target is None:
        return None
    try:
        settings_xml = package.read(target)
    except (KeyError, BadZipFile):
        return None
    try:
        settings = ElementTree.fromstring(settings_xml)
    except ElementTree.ParseError:
        return None
    if settings.tag != f"{WORD_NAMESPACE}settings":
        return None
    props = _word_children(settings, "footnotePr")
    if len(props) > 1:
        return None
    if not props:
        return implicit
    return _merge_footnote_fields(implicit, _read_footnote_fields(props[0]))


def _section_footnote_mode(defaults: _FootnoteFields, sect_pr):
    props = _word_children(sect_pr, "footnotePr")
    if len(props) > 1:
        return None
    if not props:
        return _footnote_mode(defaults, False)
    section_fields = _read_footnote_fields(props[0])
    explicit_start = isinstance(section_fields.start, int)
    return _footnote_mode(_merge_footnote_fields(defaults, section_fields), explicit_start)


def _read_footnote_fields(props) -> _FootnoteFields:
    fmt: object = _UNSET
    start: object = _UNSET
    restart: object = _UNSET
    for item in list(props):
        if not isinstance(item.tag, str):
            continue
        if not item.tag.startswith(WORD_NAMESPACE):
            return _FootnoteFields(_UNRESOLVED, _UNRESOLVED, _UNRESOLVED)
        name = item.tag[len(WORD_NAMESPACE) :]
        value = _word_attr(item, "val")
        # pos places the note. A footnote child names the separator. Neither one changes the number on the page.
        if name in {"pos", "footnote"}:
            continue
        if name == "numFmt":
            fmt = _assign_footnote_field(fmt, "decimal" if value == "decimal" else None)
            continue
        if name == "numStart":
            accepted = int(value) if value is not None and _FOOTNOTE_START.fullmatch(value) else None
            start = _assign_footnote_field(start, accepted)
            continue
        if name == "numRestart":
            restart = _assign_footnote_field(restart, value if value in {"continuous", "eachSect"} else None)
            continue
        return _FootnoteFields(_UNRESOLVED, _UNRESOLVED, _UNRESOLVED)
    return _FootnoteFields(fmt, start, restart)


def _assign_footnote_field(current: object, accepted: object) -> object:
    if current is _UNRESOLVED or accepted is None:
        return _UNRESOLVED
    if current is not _UNSET:
        return current if current == accepted else _UNRESOLVED
    return accepted


def _merge_footnote_fields(base: _FootnoteFields, overlay: _FootnoteFields) -> _FootnoteFields:
    def pick(current: object, nxt: object) -> object:
        return current if nxt is _UNSET else nxt

    return _FootnoteFields(
        pick(base.fmt, overlay.fmt),
        pick(base.start, overlay.start),
        pick(base.restart, overlay.restart),
    )


def _footnote_mode(fields: _FootnoteFields, explicit_start: bool):
    if fields.fmt != "decimal" or not isinstance(fields.start, int) or fields.restart not in {"continuous", "eachSect"}:
        return None
    return fields.start, fields.restart, explicit_start


def _body_sections(body) -> list[tuple[list, ElementTree.Element | None]]:
    sections: list[tuple[list, ElementTree.Element | None]] = []
    nodes: list = []
    for child in list(body):
        if child.tag == f"{WORD_NAMESPACE}sectPr":
            sections.append((nodes, child))
            nodes = []
            continue
        nodes.append(child)
        if child.tag == f"{WORD_NAMESPACE}p":
            properties = _word_child(child, "pPr")
            sect_pr = _word_child(properties, "sectPr")
            if sect_pr is not None:
                sections.append((nodes, sect_pr))
                nodes = []
    if nodes:
        sections.append((nodes, None))
    return sections


def _footnote_references(nodes: list) -> list | None:
    found: list = []
    for node in nodes:
        nested = _references_under(node)
        if nested is None:
            return None
        found.extend(nested)
    return found


def _references_under(node) -> list | None:
    found: list = []
    for child in list(node):
        if not isinstance(child.tag, str):
            continue
        # Accepted text leaves out a deletion and a move away, so those references are not on the page.
        if child.tag in {f"{WORD_NAMESPACE}del", f"{WORD_NAMESPACE}moveFrom"}:
            continue
        if child.tag == f"{_MC_NAMESPACE}AlternateContent":
            chosen = _references_in_alternate(child)
            if chosen is None:
                return None
            found.extend(chosen)
            continue
        if child.tag == f"{WORD_NAMESPACE}footnoteReference":
            found.append(child)
        nested = _references_under(child)
        if nested is None:
            return None
        found.extend(nested)
    return found


def _references_in_alternate(node) -> list | None:
    """Count one copy when every branch names the same notes.

    A compatibility copy repeats the same reference. Branches that name
    different notes are not counted, because this reader does not choose one.
    """

    branches = [
        child
        for child in list(node)
        if child.tag in {f"{_MC_NAMESPACE}Choice", f"{_MC_NAMESPACE}Fallback"}
    ]
    if not branches:
        return _references_under(node)
    sequences = []
    for branch in branches:
        refs = _references_under(branch)
        if refs is None:
            return None
        sequences.append(refs)
    keys = [tuple(_reference_key(ref) for ref in refs) for refs in sequences]
    if any(key != keys[0] for key in keys):
        return None
    return sequences[0]


def _reference_key(ref) -> tuple[str | None, str | None]:
    return (_word_attr(ref, "id"), _word_attr(ref, "customMarkFollows"))


def _outside_footnote_reference(package: ZipFile) -> bool:
    for name in package.namelist():
        if not name.endswith(".xml") or name == "word/document.xml":
            continue
        try:
            data = package.read(name)
        except KeyError:
            continue
        except BadZipFile:
            if _could_be_outside_story(name):
                return True
            continue
        try:
            root = ElementTree.fromstring(data)
        except ElementTree.ParseError:
            if _could_be_outside_story(name):
                return True
            continue
        if not isinstance(root.tag, str) or not root.tag.startswith(WORD_NAMESPACE):
            continue
        if root.tag[len(WORD_NAMESPACE) :] not in {"hdr", "ftr", "comments"}:
            continue
        if _contains_footnote_reference(root):
            return True
    return False


def _could_be_outside_story(name: str) -> bool:
    base = posixpath.basename(name).lower()
    return base.startswith("header") or base.startswith("footer") or base == "comments.xml"


def _contains_footnote_reference(node) -> bool:
    for item in node.iter():
        if item.tag == f"{WORD_NAMESPACE}footnoteReference":
            return True
    return False


def _resolve_part(owner: str, target: str) -> str | None:
    decoded = unquote(target)
    if any(ord(char) < 32 for char in decoded) or any(char in decoded for char in "\\?#"):
        return None
    if re.match(r"^[A-Za-z][A-Za-z0-9+.-]*:", decoded):
        return None
    joined = decoded[1:] if decoded.startswith("/") else posixpath.join(posixpath.dirname(owner), decoded)
    result = posixpath.normpath(joined)
    if result.startswith("../") or result in {"..", "", "."}:
        return None
    return result


def _word_child(node, name: str):
    if node is None:
        return None
    wanted = f"{WORD_NAMESPACE}{name}"
    for child in list(node):
        if child.tag == wanted:
            return child
    return None


def _word_children(node, name: str) -> list:
    if node is None:
        return []
    wanted = f"{WORD_NAMESPACE}{name}"
    return [child for child in list(node) if child.tag == wanted]


def _word_attr(node, name: str) -> str | None:
    return node.attrib.get(f"{WORD_NAMESPACE}{name}")


def _comments(xml: bytes) -> list[Annotation]:
    root = ElementTree.fromstring(xml)
    notes: list[Annotation] = []
    for comment in root.findall(f"{WORD_NAMESPACE}comment"):
        comment_id = comment.attrib.get(f"{WORD_NAMESPACE}id", "")
        author = comment.attrib.get(f"{WORD_NAMESPACE}author")
        text, _revisions = _paragraphs_in(comment, f"comment {comment_id}")
        if not text.strip():
            continue
        notes.append(
            Annotation(
                kind="comment",
                text=text.strip(),
                author=author,
                location=f"comment {comment_id}",
                operative=False,
            )
        )
    return notes


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
        cell_parts: list[list[str]] = []
        location = f"table row {row_number}"
        for cell in row.findall(f"{WORD_NAMESPACE}tc"):
            parts: list[str] = []
            for paragraph in cell.findall(f"{WORD_NAMESPACE}p"):
                text, found = _paragraph(paragraph, location)
                revisions.extend(found)
                if text.strip():
                    parts.append(text.strip())
            cell_parts.append(parts)
        lines.extend(_flatten_row(cell_parts))
    return lines, revisions


def _flatten_row(cell_parts: list[list[str]]) -> list[str]:
    """Join ordinary cells with `` | ``. Keep each text-box line on its own line.

    A text-box label applies only to that box. Joining the next cell onto the
    same line would make the label cover words that are outside the box.
    A row with no text box stays one line, including empty cells.
    """

    plain_cells = [" ".join(parts) for parts in cell_parts]
    if not any(cell.strip() for cell in plain_cells):
        return []
    segments = [_cell_segments(parts) for parts in cell_parts]
    if not any(kind == "box" for cell_segments in segments for kind, _text in cell_segments):
        return [" | ".join(plain_cells)]
    lines: list[str] = []
    ordinary: list[str] = []

    def flush() -> None:
        if ordinary:
            lines.append(" | ".join(ordinary))
            ordinary.clear()

    for cell_segments in segments:
        for kind, text in cell_segments:
            if kind == "box":
                flush()
                lines.append(text)
            elif text.strip():
                ordinary.append(text)
    flush()
    return lines


def _cell_segments(parts: list[str]) -> list[tuple[str, str]]:
    """Split one cell into ordinary text and text-box lines, in reading order."""

    segments: list[tuple[str, str]] = []
    ordinary_parts: list[str] = []

    def flush_ordinary() -> None:
        if ordinary_parts:
            segments.append(("text", " ".join(ordinary_parts)))
            ordinary_parts.clear()

    for part in parts:
        lines = part.split("\n")
        if not any(_is_text_box_line(line.strip()) for line in lines):
            ordinary_parts.append(part)
            continue
        kept: list[str] = []
        for line in lines:
            stripped = line.strip()
            if _is_text_box_line(stripped):
                chunk = "\n".join(kept).strip()
                kept = []
                if chunk:
                    ordinary_parts.append(chunk)
                flush_ordinary()
                segments.append(("box", stripped))
            else:
                kept.append(line)
        chunk = "\n".join(kept).strip()
        if chunk:
            ordinary_parts.append(chunk)
    flush_ordinary()
    return segments


def _is_text_box_line(line: str) -> bool:
    body = line[len(_TEXT_BOX_LABEL) :] if line.startswith(_TEXT_BOX_LABEL) else ""
    return bool(body.strip())
