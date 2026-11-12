# Negotiated DOCX ingestion

This is an engineering check on today's `main`, rebuilt from the useful behavior in closed draft pull request 10. It is not a legal approval, not production evidence, and not a claim that an old machine's audit or CI log still describes these dependencies.

The adapter keeps negotiated Word material as evidence and keeps it out of operative terms. Passing the synthetic checks does not establish production legal reliability, party identity, acceptance of a redline, or execution. `LEGAL_RELIANCE_ENABLED` stays off.

## What is preserved

| Evidence | How it is kept |
| --- | --- |
| Original file | Uploaded bytes are not rewritten. The receipt binds their SHA-256. |
| Package | Every ZIP part name, size, and SHA-256, plus relationship ids, types, and targets. |
| Revisions | Inserted and deleted wording, with the author, date, and revision id as supplied. Author display names are not party identity. |
| Comments | Comment body, author, initials, date, and start/end/reference anchors. Comment text is context. It cannot ground a contract quote. |
| Stories | Main body, headers, footers, footnotes, and endnotes stay separate. A header or endnote is not silently merged into governing body text. |
| Footnotes and text boxes | Footnote words and plain text in a `w:txbxContent` text box are contract-source text. A citation names the document, a structural locator such as "Footnote 2" or "Text box in section 1.1", and a verbatim quote of the words that remain. "Footnote 2" is the number a reader sees when this reader can count decimal notes in order. When the displayed number depends on page layout, a custom mark, or a format this reader does not count, the label says "Footnote XML id" plus the XML id. A text box whose shape is hidden, or whose visibility this reader cannot resolve, is treated like vanished text and is not published. |
| Text hypotheses | Original text leaves out insertions. Proposed text leaves out deletions. Neither hypothesis is an accepted agreement or governing text. |

Analysis chunks are complete paragraph envelopes prefixed with `CONTRACTTWIN_DOCX_EVIDENCE_V1`. Quotations of footnote and text-box words must match that contract-source text exactly. Deleted-only wording and comment text are not governing text. Candidate terms taken from a negotiated file are labeled `Unapproved proposed text:`. A negotiated Word file is still not an accepted agreement.

## What still blocks

Unsupported or incomplete packages do not publish analysis chunks and are not sent to flattening OCR. The preserved file remains available. Blocking cases include numbering that is not resolved, tracked moves, fields, content controls, drawings or images that have no plain text-box words, a text box whose two versions do not say the same words when neither version can be chosen, hidden or vanished text, a text box whose shape is hidden or whose visibility cannot be resolved, strict OOXML, macro files, bad relationships, unmatched comments, and ZIP features outside the bounded reader (ZIP64, encryption, odd encodings).

External hyperlinks are recorded and never fetched. That warning does not prove what the link contains.

Limits, which block rather than truncate: 75 MiB package, 2,048 entries, 8 MiB per part, 32 MiB expanded, 100,000 XML nodes, depth 128, and a 24 MiB receipt.

Full-package layout, list numbering labels, page-restart footnote numbers, authentic Word comparison, and legal reliance remain open. The evidence-kernel blocker for full-package coverage stays in place.

## How this is checked

`node scripts/docx-extraction-check.mjs` builds synthetic OOXML in memory and fails if revisions, comments, headers, or deleted-only wording are flattened into governing text. It also fails unless a footnote and a plain text box keep their exact words with a document, a section or structural locator, and a verbatim quote.

`node scripts/docx-pipeline-check.mjs` runs the current extraction worker with doubled database, storage, and model boundaries. It fails unless a complete receipt is stored, a blocked file publishes no chunks and no OCR job, legacy `DOCX_RAW_TEXT` cannot reach clause or term analysis, and proposed terms reject deleted-only wording.

No customer agreement is used. Old pull request 10 audit logs, build logs, and dependency-audit dumps were not copied. Today's `package.json` and `package-lock.json` dependency set is unchanged.
