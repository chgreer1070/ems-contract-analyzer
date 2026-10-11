# Governed PDF preparation: review candidate

Base: 39716dfd22f4e01a3b1f891e28fb9a64149bf661.
Scope: SPLIT and MERGE, as preparation copies. Feature defaults off.

## Behavior

POST `/api/matters/{matterId}/pdf-preparations` requires matter EDIT access,
non-demo identity, database/private storage/scanner configuration, and
`PDF_PREPARATION_ENABLED=true`. Inputs are document UUIDs, never arbitrary URLs.
All sources must be active, malware-clean, server-hash verified PDFs in that
matter. Actual fetched bytes must match both the registered size and hash.
Inputs are bounded to 25 MiB total, 200 pages per PDF/output, and 20 merge sources.

```json
{"operation":"SPLIT","documentIds":["document-uuid"],"firstPage":1,"lastPage":3}
```

```json
{"operation":"MERGE","documentIds":["first-document-uuid","second-document-uuid"]}
```

The response contains preparationId, output hash, page count, an ordered page
lineage map, and an authenticated content URL. It does not disclose private
storage URLs. Output bytes undergo a new malware scan. Sources are rechecked
under DB row locks at intent recording and completion; matter access is rechecked
before both stages.

GET `/api/matters/{matterId}/pdf-preparations/{preparationId}/content` requires
current matter VIEW access, a completed receipt, active and still valid parents,
and correct output bytes/size. It returns an attachment with no-store headers.

## Evidence and authority

An append-only `PDF_PREPARATION_STARTED` audit event records intent, planned
object pathname, source hashes, parameters, output hash, size, page count, and page
lineage before storage is written. A `PDF_PREPARATION_COMPLETED` event records
successful completion after storage and source rechecks. The existing DB audit
trigger supplies append-only protection; no new migration or control override.

Private storage uses a generated UUID pathname, no overwrite, and no automatic
deletion. Prepared outputs are absent from `documents` and agreement-version
membership, so they cannot enter extraction, analysis, or agreement approval
through this API. They carry `PREPARATION_COPY_ONLY` status.

## Intentional refusals

Encrypted/invalid PDFs, forms/signature fields, annotations, bookmarks, named
objects/attachments, actions, portfolios, signed permissions, tagged structure,
and optional-content layers are rejected conservatively. This is not a universal
signature verifier. Stamps and watermarks are not exposed: hosted placement must
first have a validated page renderer and collision checks. Preserve originals
and continue negotiated clause revisions in the DOCX workflow.

## Validation

`npm run test:pdf-preparation` executes 26 checks. PDF parsing, splitting, merging,
and rendered fidelity comparisons are real. Access uses the actual access module
with mocked auth/database replies. Storage, ClamAV, and DB route calls are mocked.
Four representative page comparisons have identical rendered pixels and extracted
text, including table rules, an embedded image, crop boxes, and rotation.

Other checks cover default-disabled routes; invalid/oversized/encrypted input;
unauthenticated/viewer/restricted-matter denial; cross-matter IDs; quarantine;
purge; hash failures; malicious request size; output scanning failure; persistence
failure; parent/output provenance; no-store downloads; output tampering; and source
revocation during writes. Run `npm run typecheck`, `npm run test:controls`, and
`npm run build` for existing application regression/build validation.

Development fidelity tests also require Python and PyMuPDF 1.26.6. Production
runtime uses Node and pdf-lib 1.17.1 (MIT); no Python runtime is introduced.

## Release limits and next gate

This is a local review candidate, not a live integration or production approval.
No authenticated provider, live DB/storage, or real ClamAV session was exercised.
No UI or durable job queue was added. Runtime costs, real large/malformed PDFs,
representative customer samples, accessibility and complete metadata fidelity,
transactional access revocation races, and request timeouts remain unverified.

The two-stage intent/completion protocol makes interrupted object writes visible
but does not make DB/object storage atomic. Started events without completions
identify possible retained orphan objects for reconciliation. Request retries
create new preparation IDs; no idempotency guarantee is asserted. Download is
blocked after parent purge, but derivative-object retention and legal-hold/purge
handling still need an approved policy. Keep the feature disabled until these
limits and provider integration are accepted. The PDF parser runs in the request
process: a future bounded worker is required before exposing hostile/large files.

Proposed owners: ContractTwin engineering for provider tests, worker/retention
controls, and UI; legal for representative document-fidelity acceptance; Chris
for publication/deployment authorization. No due date was supplied. Do not
enable the flag on a live environment as part of code review.
