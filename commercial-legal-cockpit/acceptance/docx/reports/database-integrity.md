# DOCX PostgreSQL acceptance report

Date: October 9, 2026. Reviewed release candidate: `0d446203d670e086aa50ef8d65755cbc653ae6be`. Gate: **OPEN; two reproduced release defects.** No production or approved target database was accessed or migrated.

The repository has sufficient controls to preserve successful receipts and archived blocked receipts in the narrow SQL scenarios tested. It does not yet satisfy safe re-extraction. A second defect rejects genuine proposed quotations containing double quotation marks at the database grounding boundary.

## Completed evidence and limits

The execution environment has no `psql`, `postgres`, `initdb` or Docker. Only UID/GID 0 is mapped, and a legitimate nested user namespace fails with `Operation not permitted`. I did not circumvent PostgreSQL's nonroot server requirement. A disposable multi-connection server could not safely be run here.

I therefore ran a narrower diagnostic using **PGlite 0.4.1, embedded WASM PostgreSQL 17.5**, with all 14 unchanged canonical application migrations and synthetic DOCX data. This is actual PostgreSQL SQL/trigger behavior in an embedded engine, not a PostgreSQL server, least-privilege role test, transaction-concurrency proof or approved-target acceptance. The final rerun used a detached worktree at the exact candidate, so concurrent edits in other agents' working directories did not affect these results. The package lives only in scratch; it was not added to the application's dependencies.

| Scenario | Observed result | Acceptance implication |
| --- | --- | --- |
| Successful EXTRACT output update and receipt deletion | Both denied with `P0001`: successful processing-job receipts are immutable | Narrow sequential SQL control passed |
| Complete blocked receipt archived in audit; actual `enqueueJob` retry resets failed output | Job resets to QUEUED/empty output; archived receipt remains identical; audit update/delete both denied | Narrow sequential SQL control passed; worker transaction atomicity still needs server proof |
| Delete old chunks with unreviewed term | Denied: published term requires a RUNNING extraction run and source chunk | DB-01 reproduced |
| Delete old chunks with human-reviewed term | Same denial; old term and chunk link survive rollback | DB-01 reproduced; preservation alone does not establish safe re-extraction |
| Actual worker re-extracts a source containing a reviewed term | New job fails; current document becomes PENDING/new failed generation; prior successful receipt and reviewed chunk link survive | DB-01 reproduced through actual worker and SQL; external storage/model/OCR/readiness boundaries doubled |
| Insert term whose exact proposed quotation contains `"approved price"` | Denied although decoded proposed text is identical | DB-02 reproduced |
| Server publication/extraction races; expired lease; interrupted seal | Not executed on a server | Guarded local harness supplied; gate open |
| Approved target and least-privilege runtime role | Not executed | Requires separately authorized environment/access |

The diagnostic's six PASS entries mean its expected observations were reproduced, **including defects**. They do not mean release acceptance passed. An initial worker diagnostic failed because its expected sanitized error wording differed from the real jobs module's wording. The assertion was corrected to inspect the failure and persisted state; both initial and final logs are retained.

## DB-01: re-extraction invalidates a usable source generation

`lib/jobProcessor.ts` first commits `documents.extraction_job_id=newJob` and `extraction_status='PENDING'`. Later `persistChunks` deletes every chunk for that document. `contract_terms.chunk_id` has `ON DELETE SET NULL`, while `enforce_term_lineage` requires a non-null chunk and its same-source RUNNING term run. PostgreSQL's foreign-key action triggers that rejection. The deletion transaction rolls back; the earlier generation-binding transaction does not.

In the actual worker diagnostic, the document was left PENDING and bound to the FAILED new EXTRACT job. The old source chunks, reviewed term and immutable successful receipt remained. Current receipt validation correctly refuses that unusable generation. This prevents unsafe reliance, but it breaks the requested safe re-extraction workflow.

Owner: technical/database release owner. Required before production release. Risk if unresolved: an ordinary re-extraction strands reviewed sources and blocks further analysis. Mitigation owner: same owner. Short-term mitigation: deny incompatible re-extraction **before** changing the current usable generation; retain the original source/version and all review evidence. Durable repair: use immutable, generation-scoped source chunks or safely reuse exact unchanged chunks without retargeting reviewed evidence. Do not delete reviewed terms, clear their source linkage or disable the trigger to make the operation succeed. The architecture decision and any migration require normal reviewed release controls; no target migration is authorized here.

## DB-02: raw JSON grounding rejects genuine quotations

The new DOCX chunks are prefixed JSON envelopes. The TypeScript grounding helper searches decoded original/proposed views. Existing SQL `enforce_term_lineage` and `enforce_finding_lineage` instead search the raw chunk string. JSON serializes an actual quotation mark as `\"`. A legitimate proposed term such as `Customer shall pay the "approved price" within 60 days.` passes decoded grounding but is not found verbatim in the raw serialized envelope, so term insertion raises `P0001`.

Quoted proposed terms are reproduced. The same raw-string mechanism in finding grounding and other JSON escape characters remain additional cases for the server suite; they are not claimed as separately executed defect reproductions.

Owner: technical/database release owner. Required before production release. Risk if unresolved: valid quoted contract terms fail publication; source preservation alone cannot deliver usable negotiated-agreement analysis. Mitigation owner: same owner. Repair the database grounding boundary to interpret the verified DOCX projection and allowed contract views consistently with the TypeScript gate; preserve exact quote bytes/hash and exclude comments/metadata. Retain the existing text/PDF path. Do not strip quotation marks, weaken grounding or treat raw metadata matches as contractual evidence.

## Guarded disposable-server harness

`acceptance/docx/scripts/database-integrity-local.mjs` contains ten intended scenarios: receipt immutability/binary preservation; blocked archive/reset; interruption before receipt seal; competing EXTRACT workers; expired lease denial; unchanged re-extraction/history retention; re-extraction with unreviewed and reviewed terms; publication versus concurrent extraction; and genuine quoted proposed text grounding. It executes actual application worker/jobs/runtime SQL against real PostgreSQL. Only blob/model/OCR/malware/readiness boundaries are in-memory or deny-only doubles. It intentionally reports the two acceptance defects as failures.

The harness passed JavaScript syntax checking and an actual DOCX fixture/receipt input check. It also refused absent configuration and a non-loopback endpoint before any connection. Its server scenarios have **not** been executed. Before relying on it, the technical owner must run the harness on a supported disposable server and investigate any harness failure separately from an application defect.

Run from the application directory, using a fresh local PostgreSQL instance started by its normal nonroot owner:

```bash
createdb ct_docx_acceptance_20261009
LOCAL_DOCX_ACCEPTANCE_URL=postgresql://127.0.0.1/ct_docx_acceptance_20261009 \
LOCAL_DOCX_ACCEPTANCE_INIT=EMPTY_DISPOSABLE_DATABASE \
node acceptance/docx/scripts/database-integrity-local.mjs
```

The URL must be loopback, the database name must start with `ct_docx_acceptance_`, and public tables must be absent. The harness applies the existing canonical migrations only to that empty disposable database, leaves synthetic evidence for inspection, and refuses an existing/nonempty database. Do not substitute a target database URL. Do not put a password in a shared command log; use a local socket/trust setup or approved secret injection outside the retained log.

For the embedded diagnostic only, install the pinned package into a separate scratch directory and supply the absolute package folder via `DOCX_EMBEDDED_DIAGNOSTIC_PACKAGE`; run `database-integrity-embedded.mjs` from the candidate application directory. It opens no network connection and does not change application dependencies.

## Remaining approved-target requirements

The approved-target gate can only be closed after the technical/database owner supplies:

1. Named owner and explicit approval for a disposable acceptance environment containing synthetic data, with allowed mutations/cleanup stated. No acceptance execution against customer or production records is implied.
2. Exact proposed release SHA after remediation; target PostgreSQL version; independently confirmed logical/physical database identity and migration receipts matching the approved release; protected connection details delivered through the approved secret mechanism.
3. Separate restricted-runtime and control-owner access approved for the existing database-control acceptance suite. The test executor must prove it reached the intended environment, rather than merely use an available `DATABASE_URL`.
4. Approved parallel-client load and timeout limits. Exercise actual worker interruption, stale lease takeover, two simultaneous extraction generations, publication races, safe re-extraction with historical reviewed terms/findings, successful receipt mutation denial, blocked-receipt retry retention, and quoted/multiline grounding. Preserve before/after row manifests and full logs.
5. Human review of all failures, dependency/security release gates, counsel engine policy/model acceptance, and exact-release production authorization. None is supplied by this report.

No accountable person's name or production date has been supplied. The deadline for both defects and remaining proofs is **before release**, not an invented calendar commitment. Until then, production deployment and legal reliance remain blocked.

## Evidence files

- `database-integrity-command-record.json`: exact revision, input/syntax/guard commands, exit codes, runtime availability, source and harness hashes.
- `database-integrity-embedded.log`: final embedded SQL diagnostic, migration hashes, engine/package versions, source hash and observations.
- `database-integrity-embedded-initial-worker.log`: initial worker assertion wording failure, retained for traceability.
- `database-integrity-evidence-manifest.json`: commands/exit provenance and SHA-256 manifest for this lane's deliverables.

Next permitted increment: reviewed implementation repair for DB-01/DB-02, fresh exact-revision local server execution, then separately approved target proof. No merge, deployment, engine activation or confidential agreement processing occurred.
