# Negotiated DOCX ingestion

Engineering candidate, October 9, 2026. This adapter fixes the loss of revisions and comments in the former Mammoth raw-text path. It supports a bounded OOXML subset and deliberately blocks unsupported or incomplete documents. Passing synthetic tests does not establish production legal reliability, party identity, acceptance of a redline, or execution.

## Evidence retained

| Evidence | Representation |
| --- | --- |
| Original source | Immutable uploaded bytes; independently verified source SHA-256 |
| Package provenance | Every ZIP part's name, byte size and SHA-256; relationship IDs, types, targets and external status |
| XML structure | Namespace-aware element/attribute/text trees with part and XML element paths, including paragraph/run/table/row/cell properties, styles, numbering and section metadata |
| Revisions | Insertions/deletions and exact language; author, date and revision ID as supplied; source paths; property/move revisions retained and blocked where interpretation is unsupported |
| Comments | Body, author, initials, date; start/end/reference paths; UTF-16 offsets in the combined negotiation story and paragraph; per-run membership in overlapping/cross-paragraph ranges |
| Stories and references | Main body, headers, footers, footnotes and endnotes; note references link to their source nodes |
| Tables | Row/cell ancestry, grid positions/spans, vertical merge status, current-row values, first-row context and explicitly marked header rows; raw table properties remain in the evidence tree |
| Text hypotheses | Original excludes inserted language; proposed excludes deleted language; both retain exact decoded text and whitespace. Neither proves operative terms. |
| Analysis provenance | Complete paragraph envelopes with hashes and source paths; immutable exact-generation EXTRACT job receipt contains the structure, warnings and paragraph/chunk manifest |

XML decoding follows XML normalization rules; the original part hash binds the source bytes. XML paths use the source's namespace prefixes; the retained tree includes namespace URIs/declarations. Story offsets count both inserted and deleted text in document order, with one newline per paragraph, and are **not** offsets in either text hypothesis. Pagination and physical layout are not inferred from Word XML.

Comment text is supplied as context inside the paragraph envelope. It cannot ground a contract quotation. Clause findings may quote either original or proposed contract language and must describe the relevant view. Candidate terms are deterministically restricted to proposed text and labeled `Unapproved proposed text:`. All existing human review/authority controls remain in effect. Metadata must never be treated as instructions, negotiation policy, a party's identity or approval.

## Blocking features

The original binary remains preserved. For unsupported features, the receipt retains available structure and diagnostics, the document becomes `FAILED`, no analysis chunks are published, and no OCR fallback is allowed. Severe package/size failures may retain only partial structured diagnostic evidence and part hashes; such a receipt explicitly remains blocked.

| Feature | Current disposition |
| --- | --- |
| Automatic numbering, including a used/default/inherited numbering style | Definitions/references retained; unresolved labels block analysis |
| Paragraph-mark, formatting, table-cell/grid and section revisions; tracked moves | Raw source and metadata retained; before/after semantics block analysis |
| Modern threaded/extended comments, revisions within comment bodies or unsupported revision extensions | Parts preserved; unsupported semantics block analysis |
| Fields/formulas, cached field values, content controls/data bindings and custom XML | Preserved; evaluation/binding is unsupported and blocks analysis |
| Images, drawings, text boxes, embedded objects, signature parts and linked content | Preserved by source/part hashes and available XML; requires another validated visual/authenticity adapter |
| Hidden/bidirectional text and unknown story elements/extension attributes | Blocked; never silently skipped under an ignorable namespace declaration |
| Strict OOXML, macro-enabled files, templates, alternative chunks and unsupported package XML | Blocked |
| Missing/duplicate parts, dangling relationships/notes, unmatched or orphan comments, conflicting revision identity, inconsistent table grids/merge continuations | Blocked |
| Nested tables or unresolved legacy horizontal merges | Blocked |
| ZIP64, multi-disk/encrypted archives, exotic non-UTF-8 part names, unsupported compression, malformed XML, DTDs/entities | Blocked |
| External hyperlinks | Target retained, never fetched; nonblocking warning. This does not prove the linked document's contents. |
| Page coordinates, rendered layout, fonts, signature authenticity, full referenced agreement package | Not established; existing legal-reliance blockers remain active |

Supported archives are classic ZIP with stored/deflated entries. Limits: 75 MiB source bytes, 2,048 entries, 8 MiB per expanded part, 32 MiB total expansion, 100,000 XML nodes across the package, depth 128, names up to 256 characters, at most 512 attributes per element, XML paths up to 8,192 characters, a 100,000-character complete paragraph envelope, 4 MiB each of table context and revision-property metadata, and a 24 MiB structured receipt. Exceeding a limit blocks rather than truncates an eligible result. Files near these limits still need staging memory/latency testing. The adapter is not a complete ECMA-376 schema validator or a Word layout engine.

## Publication and review

No database schema change is required. The existing immutable successful processing-job output stores complete receipts. Failed jobs are retryable, so each blocked receipt is additionally archived in full in its append-only, matter-scoped audit event before the failed job output can be reset. `documents.extraction_job_id` binds the current generation; `document_chunks` stores the complete evidence envelopes and hashes. Receipt validation requires the exact successful same-document/matter EXTRACT job, source SHA, current extractor version, no blocking issues, full paragraph coverage, reconstructed envelope equality and all chunk hashes. Worker publication retains existing malware, integrity and lease-fencing controls.

Supported extraction uses `DOCX_OOXML_EVIDENCE`. Legacy `DOCX_RAW_TEXT` is historical evidence only and is denied in clause/term and graph processing until re-extraction. Missing, unfinished or altered receipts also block processing. An extraction worker interrupted after publishing chunks but before sealing its receipt cannot authorize DOCX analysis. A failed or incomplete DOCX cannot be repaired by manually enqueueing OCR.

Authorized matter users can open `/api/documents/{id}/evidence` from the source panel to inspect the current successful or blocked receipt. Access precedes reads; malware/deletion controls and no-store responses protect evidence. The preserved original remains available through the existing governed source route.

Changed clause/term prompt IDs and the pipeline ID invalidate old engine/validation matches. This change does not activate new engine policies, overwrite old reviews, select governing text or change any production switch. The existing platform-level legal-reliance blockers remain active.

## Validation and activation

`npm run test:docx` executes synthetic OOXML fixtures plus actual worker/adapter/API modules with explicitly doubled database, storage and inference boundaries. It is included in `test:controls`, so existing CI and release preflight invoke it. Fixtures are generated in memory and contain synthetic data only.

Local validation evidence and remaining release blockers are recorded in [`DOCX_VALIDATION.md`](DOCX_VALIDATION.md). No real customer agreement was processed in this change.

Before production deployment, the human release owner must approve the exact reviewed source/artifact under the existing protected release process. Required independent work includes representative Word-generated fixtures and authorized agreements checked against Word's revision/comment views; target PostgreSQL receipt immutability and interrupted/stale-generation publication tests; resource-limit/load tests; current clause/term engine policies and artifact-bound legal validation; dependency security remediation; and the remaining platform readiness gates. Counsel must separately establish author-to-party mapping and the operative agreement state. Approval cannot convert a blocked extraction into complete evidence.
