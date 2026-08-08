# Production Readiness Gates

ContractTwin / EMS Commercial Legal Cockpit must satisfy these gates before confidential or privileged production use.

These are acceptance gates, not assertions of completion. Source-code implementation, a passing local/CI build, a preview deployment, and production activation are separate states. Every environment-dependent item requires dated evidence from the exact target environment and approval by its named control owner.

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
- Every migration through `010_release_target_binding.sql` is applied; database controls prove quarantine-before-parser, exact extraction/OCR generation ownership, hash matching, stale-worker publication denial, authorized executive-snapshot job receipts, immutable database identity, and append-only release-target receipts.

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
- Units, signs, percentage conventions and rounding documented.
- Boundary cases tested (zero revenue, negative inputs, >100% percentages, zero gross profit).
- No double counting of exposures across modeled categories.
- Formula version stored on every matter-scoped run.
- Model-generated facts never directly replace financial inputs without human validation.

## 7. Human review / authority — BLOCKING

- AI findings default to `UNREVIEWED`.
- Lawyer validation/rejection of findings retains reviewer, timestamp and substantive note.
- Every current clause/term run and version-scoped dependency/precedence run has an immutable, explicit counsel attestation by a separately capability-authorized active Lawyer/Approver/Admin; valid zero-output runs require the same deliberate attestation and explanation.
- Recommendation is distinct from approval.
- Exception requests are distinct from approved dispositions.
- Approver/Admin authority is derived and tested server-side; a decision requester cannot disposition the same request.
- Agreement-version transitions, legal-hold release and executive-snapshot generation require explicit authorized human actions. Execution additionally requires current exact run/graph receipts and attestations, zero rejected model output, resolved structured decision conditions and current-formula economics for that agreement version.
- The governed document pipeline is proven not to auto-create or refresh an executive snapshot.
- Snapshot creation is blocked unless the selected agreement version is approved/executed; every source is active, clean, hash-verified and extracted; current analysis runs match source chunks; current source-derived objects have human disposition and documented validated reviews; and a current-formula economics scenario was deliberately saved and validated. Every new snapshot and presented reliance brief must also have an exact successful `EXECUTIVE_SUMMARY` generator receipt binding requester authority, agreement version, economics run, reliance preimage and canonical state hash; receipt-less legacy rows are non-reliance evidence.
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
- Production database roles are separated: Vercel `DATABASE_URL` has only approved runtime access and cannot perform DDL or write migration history; the privileged migrator is not available to the application runtime. Both database URLs require `sslmode=verify-full`, and staged release evidence proves each live connection is encrypted.
- ClamAV connectivity is private and restricted; scanner signature/patch/availability monitoring is operational.
- Penetration test or risk-based security assessment completed.

## 10. Operational acceptance — BLOCKING

- Vercel Git integration uses the intended repository/root directory.
- Preview deployments cannot access production secrets/data unless explicitly approved.
- `vercel.json` disables automatic Git deployments for every branch and that setting remains disabled in the connected project. Production deploys require an explicit manual production dispatch from `main` and approval through the protected `contracttwin-production` GitHub environment; a merge or push alone cannot deploy production. Release preflight and CodeQL must pass for the exact dispatch SHA. `MIGRATION_DATABASE_URL` must exist only as a secret on that protected GitHub environment and be exposed only to the schema-gate step—never to Vercel, temporary runtime env files, builds, functions, workers, previews, or post-deployment checks. The workflow must validate the separately pulled runtime environment, apply and checksum-verify target migrations twice with the migrator, prove the runtime `DATABASE_URL` can use required controls but cannot perform DDL or mutate migration history, stage the exact prebuilt production artifact without assigning the production domain, pass a token-protected live proof of source SHA/schema/readiness/economics, and only then promote it.
- Monitoring and alerting defined for 5xx errors, auth failures, extraction failures and AI failures.
- Incident response and credential rotation procedure documented.
- Named product owner, legal control owner and technical owner assigned.
- Named Security, Records and Finance/Business control owners assigned for their respective gates.

## 11. Schema and release evidence — BLOCKING

- Better Auth and every ContractTwin migration through `010_release_target_binding.sql` applied from the exact release SHA.
- The compiled ordered filename/SHA-256 migration manifest has no missing, extra, reordered, or changed receipt; manifest v2 hashes and executes the same strict-UTF-8, canonical-LF source on every platform, and idempotent rerun is verified before approved production change.
- PostgreSQL 17 database-control tests prove quarantine-before-parser, exact extraction generation, matching source hashes, immutable run/receipt evidence, current engine policies, counsel-capability enforcement, cross-matter lineage rejection, agreement-version-scoped execution, independent decisions, governed standards, legal-hold purge blocking and append-only audit.
- Application access/readiness/security-boundary controls, frozen corpus, economics, TypeScript, dependency audit, production build and CodeQL pass for the exact release SHA.
- Deployment artifact/source SHA, environment configuration, approval record and rollback/recovery procedure are retained. Target verification also proves required live critical triggers, functions, constraints and indexes are present and enabled rather than trusting migration receipts alone; both database identities use certificate-verifying TLS 1.2/1.3; the migrator and least-privilege runtime reach the same immutable database identity; and the runtime can read but cannot forge the exact unpredictable per-release receipt. Evidence must not contain either database credential or the receipt nonce.

## 12. Live acceptance — BLOCKING

- End-to-end synthetic matter completed in the target environment: sign-in, restricted membership, upload, clean scan, hash verification, exact-generation extraction/OCR, analysis, explicit per-run counsel attestations (positive and zero-output), version-scoped graph receipts/attestations, current-formula economics, decision, approved/executed agreement version, receipt-bound explicit snapshot and historical retrieval.
- Negative paths observed and recorded: demo persistence denial, unauthorized matter access, quarantined/failed scan, hash mismatch, ungrounded analysis, incomplete review, self-approval, pending decision, legal hold and premature retention/purge.
- Durable retry/idempotency and no-partial-publication behavior verified across worker interruption or controlled failure.
- Monitoring detects auth, scanner, extraction/OCR, AI, workflow, database and 5xx failures without exposing confidential content.
- PostgreSQL restore drill and documented source-object recovery/retention procedure completed.
- Legal, Security, Privacy/Privilege, Records, Finance/Business and Technical owners approve the evidence applicable to their control areas.

## Current disposition

**Engineering release candidate / pilot validation only.** The repository may contain a code-complete candidate, but this checklist does not claim the exact release has passed CI, been deployed, completed live validation, or received production approval. Do not enable `LEGAL_RELIANCE_ENABLED` or use confidential production agreements until all applicable blocking gates above have dated evidence and formal acceptance. Keep `ALLOW_SOURCE_PURGE=false` until records-management authorization and purge recovery testing are separately complete.
