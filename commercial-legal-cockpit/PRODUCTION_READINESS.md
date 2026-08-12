# Production Readiness Gates

ContractTwin / EMS Commercial Legal Cockpit must satisfy these gates before confidential or privileged production use.

These are acceptance gates, not assertions of completion. Source-code implementation, a passing local/CI build, a preview deployment, and production activation are separate states. Every environment-dependent item requires dated evidence from the exact target environment and approval by its named control owner.

**Current enforced disposition: engineering pilot only.** `lib/readiness.ts` contains seven explicit implemented-capability blockers: structure-preserving/full-package evidence; representative validation of every relied-on analysis stage; authentic execution certification; finance lineage plus delegated multi-function authority; source-scoped provider-processing authorization; governed validation of the approved 41-section EMS taxonomy, financial-risk methods and Top-10 cascades; and completion of the mixed-bundle decision/economics/snapshot evidence rollout's drain and contract-enforcement phase. While any blocker remains, `legalRelianceReady` is false even if infrastructure, standards, engine-policy labels, and the synthetic clause-risk corpus otherwise pass. Agreement approval/execution and frozen executive-snapshot generation therefore fail closed when legal reliance is requested.

## 1. Identity and access — BLOCKING

- Microsoft Entra application registration approved.
- MFA / conditional access applied by corporate identity policy.
- `AUTH_REQUIRED=true` in production.
- Default role is Viewer; Lawyer/Approver/Admin roles are explicitly granted.
- Restricted matters tested against unauthorized users.
- Production sets `ALLOW_DEMO_ACCESS=false`; demo principals are confirmed Viewer-only and unable to query or mutate persistent legal state.
- Server-side authorization tests cover every protected API, not only UI visibility.
- Break-glass/admin process documented and reviewed.

## 2. Source-document security — BLOCKING

- Private Blob store configured; no public contract URLs.
- Matter authorization required before upload token issuance and source retrieval.
- Upload MIME/type and size limits validated.
- Client SHA-256 and server SHA-256 match before extraction.
- Integrity mismatch stops processing.
- Private ClamAV service configured through `CLAMAV_HOST`, with a trusted private network path (the current raw-TCP client adds no TLS/authentication), current signatures, monitoring and an owned failure-response process.
- Scanner stream-size limit, runtime memory and capacity are proven for the application's 75 MiB maximum upload, or the application limit is reduced through an approved change.
- Every upload defaults to `PENDING`; ordinary retrieval and extraction require `CLEAN`; detected sources become `QUARANTINED`; scanner/transport failures become `FAILED` and fail closed.
- Clean, detection/quarantine, timeout/unavailable and unrecognized-response behavior proven in the target environment with approved synthetic fixtures.
- Retention, legal hold and deletion behavior approved.

## 3. Contract extraction — BLOCKING

- Machine-readable PDF/DOCX/TXT test set achieves agreed extraction fidelity.
- Scanned PDF/OCR path is implemented and tested before relying on scanned agreements.
- Tables, schedules and pricing exhibits have a validated extraction path before relying on them.
- Oversized contracts use an asynchronous worker and never silently truncate.
- Page/chunk provenance is preserved through analysis.
- Every migration through `014_release_database_external_identity.sql` is applied; database controls prove quarantine-before-parser, exact extraction/OCR generation ownership, hash matching, counsel-authorized legal dispositions, durable decision rationale, fenced stale-worker publication denial, protocol-1 immutable authoritative-economics selection, authorized executive-snapshot job receipts, the immutable external-logical-to-physical database identity mapping, and append-only release-target receipts. Protocol 0 remains an expand-safe compatibility path until the separately blocked drain and contract-enforcement phase completes; it is not reliance evidence.

## 4. AI legal analysis — BLOCKING FOR LEGAL_RELIANCE_ENABLED

- Frozen regression corpus versioned and approved.
- Exactly one active engine policy per analysis stage matches the source-controlled clause, term, dependency and precedence model/prompt/schema manifest.
- Latest validation evidence matches the exact current engine manifest, frozen corpus and validation-gate versions, and its terminal result set is immutable and bound by the recorded result-manifest hash/count.
- Expected case set is exact: no missing, duplicate or unexpected cases; every expected case passes; rejected ungrounded finding count is zero.
- Source-excerpt grounding precision meets acceptance threshold.
- Material clause-family recall meets acceptance threshold on representative EMS agreements.
- False positive / false negative review completed by experienced commercial counsel.
- Missing definitions, precedence conflicts, referenced documents and uncertainty are retained rather than repaired by the model.
- Exact error/unsafe-language preservation regressions pass.
- Model/prompt/schema version, exact input lineage and publication receipt are recorded for every persisted source-derived object; invalid, duplicate or ungrounded output fails closed for legal reliance.
- AI cannot generate approved company negotiation policy or approval authority.
- `LEGAL_RELIANCE_ENABLED=true` only after validation sign-off; when enabled, AI failure fails closed.

## 5. Negotiation standards — BLOCKING

- Illustrative standards remain inactive.
- Each production clause standard has a recorded creator, version, effective date, business rationale, primary position, fallback, no-go threshold, provenance source and explicit `APPROVER` or `ADMIN` authority. The accountable policy owner must be identifiable in the cited governance source because the current schema records creator/provenance rather than a separate owner field.
- Active standards are complete, effective, governed and non-illustrative; demo/seed provenance cannot satisfy reliance readiness.
- Admin activation requires explicit confirmation.
- Only one active standard exists per clause family.
- Standard changes and activation are auditable.

## 6. Financial engine — BLOCKING FOR EXECUTIVE RELIANCE

- Formula definitions approved by Finance/Business stakeholders.
- Every input records its source, accountable owner, as-of date, unit, currency where applicable, confidence and scenario/assumption status.
- Units, signs, percentage conventions and rounding documented.
- Persisted or reconciled monetary arithmetic is decimal-safe and carries explicit currency, unit and rounding semantics.
- Boundary cases tested (zero revenue, negative inputs, >100% percentages, zero gross profit).
- Point estimates are used only when evidence supports them; otherwise approved ranges or scenarios retain their evidence and assumptions.
- The full EMS financial-risk register and cross-clause cascades reconcile to defined exposure boundaries without double counting.
- Formula version stored on every matter-scoped run.
- Model-generated facts never directly replace financial inputs without human validation.
- Under evidence protocol 1, a governed agreement version explicitly selects one exact validated economics run using the single active current formula; the run belongs to that same matter/version and becomes its immutable `authoritative_economics_run_id`. A different relied-on scenario requires a new agreement version.
- The final reliance contract requires approved decisions, production execution and reliance-capable snapshots to bind the exact selected authoritative run. Protocol-0 legacy rows remain readable history but are non-reliance evidence and must not be used to authorize production execution; the expand-safe bridge remains technically available until the blocked drain and contract-enforcement phase completes.

## 7. Human review / authority — BLOCKING

- AI findings default to `UNREVIEWED`.
- Lawyer validation/rejection of findings retains reviewer, timestamp and substantive note.
- Every current clause/term run and version-scoped dependency/precedence run has an immutable, explicit counsel attestation by a separately capability-authorized active Lawyer/Approver/Admin; valid zero-output runs require the same deliberate attestation and explanation.
- Recommendation is distinct from approval.
- Exception requests are distinct from approved dispositions.
- The pilot's coarse Approver/Admin role rule is derived and tested server-side, and a decision requester cannot disposition the same request; production remains blocked until a versioned delegated multi-function authority matrix is enforced.
- Agreement-version transitions, legal-hold release and executive-snapshot generation require explicit authorized human actions. Execution additionally requires current exact run/graph receipts and attestations, zero rejected model output, resolved structured decision conditions and the agreement version's exact selected authoritative economics run.
- The governed document pipeline is proven not to auto-create or refresh an executive snapshot.
- Before reliance activation, snapshot contract enforcement is proven to reject any selected agreement version that is not approved/executed under evidence protocol 1 with an immutable `authoritative_economics_run_id`; every source is active, clean, hash-verified and extracted; current analysis runs match source chunks; and current source-derived objects have human disposition and documented validated reviews. Every new reliance-capable snapshot and presented reliance brief must bind that exact authoritative economics run and have an exact successful `EXECUTIVE_SUMMARY` generator receipt binding requester authority, agreement version, reliance preimage and canonical state hash; protocol-0 and receipt-less legacy rows are non-reliance evidence.
- No automated redline transmission, signature, purchase commitment or customer communication.

## 8. Audit and records — BLOCKING

- Audit table is append-only at the database layer.
- Matter creation, upload, extraction, analysis, finding review, economics and decisions are recorded.
- Audit access is matter-scoped except for Admin portfolio access.
- Time source, retention and export approach approved.
- Backup/restore test completed.
- Two-phase purge recovery tested: durable `PENDING_PURGE` marker before external deletion, separately committed `PURGED` finalization, safe authorized retry, and preserved tombstone/audit history.

## 9. Application security — BLOCKING

- Dependency and secret scanning enabled in CI.
- SAST and production build checks enabled.
- OWASP-style authorization, injection, upload and session tests completed.
- CSP/security headers reviewed.
- Rate limits / abuse controls applied to AI and upload endpoints.
- Production environment separated from preview/test data.
- Production database roles are separated: Vercel `DATABASE_URL` has only approved runtime access and cannot perform DDL, write migration history, or alter the target anchor; the privileged migrator is absent from application runtime. Both URLs require `sslmode=verify-full`. A third, single-use bootstrap identity must create only the separately owned marker on the independently approved pristine endpoint and then be revoked. Every normal release must match its protected token hash, database UUID, and endpoint hash before two held read-only transaction-lock challenges prove the distinct routine credentials currently reach the same anchored writable database. Each mutator rechecks the proof in its own transaction. Target switching fails the affected transaction before it changes the unproved target; earlier valid phases may have committed. A copied/in-place-restored database behind that same approved endpoint is outside this database-resident proof and requires provider control-plane/restore approval; stronger incarnation detection requires an external non-database attestation and monotonic ledger.
- ClamAV connectivity is private and restricted; scanner signature/patch/availability monitoring is operational.
- Penetration test or risk-based security assessment completed.

## 10. Operational acceptance — BLOCKING

- Vercel Git integration uses the intended repository/root directory.
- Preview deployments cannot access production secrets/data unless explicitly approved.
- `vercel.json` disables automatic Git deployments for every branch and that setting remains disabled in the connected project. Production deploys require an explicit manual dispatch from `main` and approval through `contracttwin-production`; a merge or push alone cannot deploy production. A separate protected `contracttwin-production-bootstrap` workflow may create only the external target marker and must stop. Release preflight and CodeQL must pass for the exact dispatch SHA. Migration/bootstrap URLs and target material remain protected GitHub secrets and are never written to Vercel/runtime env files, builds, functions, workers, previews, or post-deployment checks. The release validates the pulled runtime environment, proves both routine sessions reach the exact anchored database before mutation, applies and checksum-verifies migrations twice, proves the runtime role cannot perform DDL, alter migration history, or alter the anchor, stages without production domains, passes the protected live source/schema/readiness/economics proof, and only then promotes.
- Monitoring and alerting defined for 5xx errors, auth failures, extraction failures and AI failures.
- Worker dashboards and alerts expose lease generation, heartbeat/expiry, stale-takeover and repeated retry evidence; the current matter job list is insufficient for this production requirement.
- `JOB_LEASE_RECOVERY_ENABLED` remains unset or `false` while the fencing-capable worker is first deployed. Every pre-fencing worker is drained and proven unable to resume before recovery is enabled in a separately approved change; rollback disables recovery and drains fenced workers before an older bundle can run.
- The decision/economics/snapshot evidence rollout is a separate expand-contract migration: protocol-0 compatibility remains non-reliance while old application/worker bundles are drained; only a later, acceptance-tested contract-enforcement phase may reject protocol-0 writes and clear the seventh source-controlled blocker.
- Incident response and credential rotation procedure documented.
- Named product owner, legal control owner and technical owner assigned.
- Named Security, Records and Finance/Business control owners assigned for their respective gates.

## 11. Schema and release evidence — BLOCKING

- Better Auth and every ContractTwin migration through `014_release_database_external_identity.sql` applied from the exact release SHA.
- The compiled ordered filename/SHA-256 migration manifest has no missing, extra, reordered, or changed receipt; manifest v2 hashes and executes the same strict-UTF-8, canonical-LF source on every platform, and idempotent rerun is verified before approved production change.
- PostgreSQL 17 database-control tests prove quarantine-before-parser, exact extraction generation, matching source hashes, immutable run/receipt evidence, current engine policies, counsel-capability enforcement, cross-matter lineage rejection, protocol-1 immutable agreement-version authoritative-economics selection, agreement-version-scoped execution, independent decisions, governed standards, legal-hold purge blocking and append-only audit. Release evidence separately proves the mixed-bundle drain, protocol-0 rejection after contract enforcement, and protocol-0 historical non-reliance.
- Application access/readiness/security-boundary controls, frozen corpus, economics, TypeScript, dependency audit, production build and CodeQL pass for the exact release SHA.
- Deployment artifact/source SHA, environment configuration, approval record and rollback/recovery procedure are retained. Target verification also proves required live critical triggers, functions, constraints and indexes are present and enabled rather than trusting migration receipts alone; both database identities use certificate-verifying TLS 1.2/1.3; the migrator and least-privilege runtime reach the same immutable database identity; and the runtime can read but cannot forge the exact unpredictable per-release receipt. Evidence must not contain either database credential or the receipt nonce.

## 12. Live acceptance — BLOCKING

- End-to-end synthetic matter completed in the target environment after the mixed-bundle drain and contract-enforcement phase: sign-in, restricted membership, upload, clean scan, hash verification, exact-generation extraction/OCR, analysis, explicit per-run counsel attestations (positive and zero-output), version-scoped graph receipts/attestations, explicit immutable selection of the version's validated current-formula authoritative economics, same-run decision binding, approved/executed agreement version, receipt-bound explicit snapshot and historical retrieval. A protocol-0 negative case remains readable as history but is rejected from production execution and reliance.
- Negative paths observed and recorded: demo persistence denial, unauthorized matter access, quarantined/failed scan, hash mismatch, ungrounded analysis, incomplete review, self-approval, pending decision, legal hold and premature retention/purge.
- Durable retry/idempotency and no-partial-publication behavior verified across worker interruption or controlled failure.
- Monitoring detects auth, scanner, extraction/OCR, AI, workflow, database and 5xx failures without exposing confidential content.
- PostgreSQL restore drill and documented source-object recovery/retention procedure completed.
- Legal, Security, Privacy/Privilege, Records, Finance/Business and Technical owners approve the evidence applicable to their control areas.

## Current disposition

**Engineering release candidate / pilot validation only.** The repository may contain a code-complete candidate, but this checklist does not claim the exact release has passed CI, been deployed, completed live validation, or received production approval. Do not enable `LEGAL_RELIANCE_ENABLED` or use confidential production agreements until all applicable blocking gates above have dated evidence and formal acceptance. Keep `ALLOW_SOURCE_PURGE=false` until records-management authorization and purge recovery testing are separately complete.
