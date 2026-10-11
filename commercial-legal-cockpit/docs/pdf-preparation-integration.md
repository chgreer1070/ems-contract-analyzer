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

GET `/api/matters/{matterId}/pdf-preparations` provides a read-only reconciliation
view to matter editors. It lists the latest 100 started preparations, marking
those without a completion receipt `PENDING_OR_INTERRUPTED`. This label does not
prove a request failed. The response omits storage locations. It never retries,
deletes, or changes retention automatically.

Private PDF reads bypass the provider cache, bound the initial fetch to 30 seconds,
and bound stream consumption to 30 seconds and the permitted byte limit. JSON
requests are bounded to 8 KiB and 10 seconds. Oversize, stalled, and failed streams
are canceled without waiting indefinitely for provider cancellation.

PDF parsing, page copying, and serialization run in a separate Node worker thread.
At most two PDF workers run concurrently per process; excess work gets HTTP 429
without queuing or retry. A 15-second processing deadline terminates a stalled
worker. The capacity slot is held until the thread stops. Workers receive copied
input buffers, preserving source bytes, and do not inherit environment variables
or Node preload arguments. Credentials, scanner calls, audit writes, and storage
writes remain in the parent after processing succeeds. The processing deadline
does not cover the entire HTTP request or provider calls.

Worker V8 limits are 128 MiB old heap, 32 MiB young heap, and a 4 MiB stack.
Node's resource limits do not cover ArrayBuffer/external memory or prevent a
process-wide out-of-memory failure. Threads are not a security sandbox and this
per-process cap is not a deployment-wide capacity limit.
See [Node worker limits](https://nodejs.org/docs/latest-v24.x/api/worker_threads.html)
and [Next file tracing](https://nextjs.org/docs/app/api-reference/config/next-config-js/output)
for the runtime and packaging constraints.

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

`npm run test:pdf-preparation-io` adds 13 checks for actual stream consumption,
overflow cancellation, stalled cancellation, private/no-cache read options,
and local TCP scanner framing, clean/threat/malformed/oversized responses,
timeouts and disconnections. It also checks reconciliation authorization and
read-only behavior. The TCP server emulates the ClamAV protocol; these tests do
not prove antivirus detection. Blob and DB provider calls remain mocked.

`npm run test:pdf-preparation-worker` adds 12 real-thread checks for PDF fidelity,
source immutability, CPU stalls, responsiveness, concurrency, crashes, malformed
results, omitted environment credentials, heap exhaustion, cleanup, and failure
before provider writes. The main PDF suite also renders output from real workers.

`lib/pdfPreparation.ts` remains the engine source. The committed worker engine is
generated with `node scripts/build-pdf-preparation-worker.mjs`; `--check` rejects
stale output and runs before the production build. Next file tracing explicitly
includes the worker files and PDF dependency closure. Before hosted enablement,
verify worker execution and deployment packaging on the target runtime as well
as the live provider checks below.

After `npm run build`, `npm run test:pdf-preparation-package` copies only the
worker and dependency files from the route's actual tracing manifest into an
isolated directory, then executes a real PDF operation there. This validates the
local dependency closure; it does not establish hosted packaging or runtime behavior.

## Release limits and next gate

The [nonproduction acceptance runbook](pdf-preparation-live-validation.md) includes
an unfilled environment template, a no-network configuration preflight, and an
optional bounded read-only database check. Neither preflight mode authorizes
feature enablement or claims live provider acceptance.

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
limits and provider integration are accepted. PDF parsing now uses bounded worker
threads; hosted execution, process memory behavior, and deployment-wide capacity
still need validation before exposing hostile/large files.

Proposed owners: ContractTwin engineering for provider tests, worker/retention
controls, and UI; legal for representative document-fidelity acceptance; Chris
for publication/deployment authorization. No due date was supplied. Do not
enable the flag on a live environment as part of code review.
