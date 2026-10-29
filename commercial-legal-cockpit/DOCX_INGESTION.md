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
| Stories | Main body, headers, footers, footnotes, and endnotes stay separate. A header is not silently merged into governing body text. |
| Text hypotheses | Original text leaves out insertions. Proposed text leaves out deletions. Neither hypothesis is an accepted agreement. |

Analysis chunks are complete paragraph envelopes prefixed with `CONTRACTTWIN_DOCX_EVIDENCE_V1`. Quotations must match contiguous decoded contract text. Deleted-only wording and comment text are not operative terms. Candidate terms taken from a negotiated file are labeled `Unapproved proposed text:`.

## What still blocks

Unsupported or incomplete packages do not publish analysis chunks and are not sent to flattening OCR. The preserved file remains available. Blocking cases include numbering that is not resolved, tracked moves, fields, content controls, drawings, hidden text, strict OOXML, macro files, bad relationships, unmatched comments, and ZIP features outside the bounded reader (ZIP64, encryption, odd encodings).

External hyperlinks are recorded and never fetched. That warning does not prove what the link contains.

Limits, which block rather than truncate: 75 MiB package, 2,048 entries, 8 MiB per part, 32 MiB expanded, 100,000 XML nodes, depth 128, and a 24 MiB receipt.

Full-package layout, numbering labels, authentic Word comparison, and legal reliance remain open. The evidence-kernel blocker for full-package coverage stays in place.

## How this is checked

`node scripts/docx-extraction-check.mjs` builds synthetic OOXML in memory and fails if revisions, comments, headers, or quotes are flattened into governing text.

`node scripts/docx-pipeline-check.mjs` runs the current extraction worker with doubled database, storage, and model boundaries. It fails unless a complete receipt is stored, a blocked file publishes no chunks and no OCR job, legacy `DOCX_RAW_TEXT` cannot reach clause or term analysis, and proposed terms reject deleted-only wording.

No customer agreement is used. Old pull request 10 audit logs, build logs, and dependency-audit dumps were not copied. Today's `package.json` and `package-lock.json` dependency set is unchanged.
