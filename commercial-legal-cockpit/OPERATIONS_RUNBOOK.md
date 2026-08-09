# ContractTwin Production Operations Runbook

This runbook governs activation and operation of the EMS Commercial Legal Cockpit. It does not replace corporate information-security, records-management, privilege, change-management or business-continuity policies.

## 1. Production activation

This is a future-state activation procedure, not current authorization to activate. The present release deliberately reports `evidenceKernelReady=false`; step 16 cannot succeed until all seven source-controlled `EVIDENCE_KERNEL_BLOCKERS` items are removed by approved implementations and the exact release/environment completes all gates below. The seventh blocker is completion of the mixed-bundle decision/economics/snapshot evidence rollout's drain and contract-enforcement phase; migration `013` is only its expand-safe compatibility phase.

1. Place the application in an approved private repository.
2. Create the production Vercel project with root directory `commercial-legal-cockpit`.
3. Provision private PostgreSQL, private Vercel Blob, Microsoft Entra application registration, a private ClamAV service reachable from the application runtime, Azure Document Intelligence and the approved OpenAI API/enterprise configuration.
4. Configure encrypted Vercel runtime variables from `.env.example`. Use a certificate-verifying, least-privilege `DATABASE_URL` with `sslmode=verify-full` that cannot perform DDL or mutate migration history. Set `AUTH_REQUIRED=true` and `ALLOW_DEMO_ACCESS=false`; keep `LEGAL_RELIANCE_ENABLED=false` and `ALLOW_SOURCE_PURGE=false`.
5. Run `npm ci` from the committed lockfile.
6. Generate and independently record a random 256-bit target token, a production database UUID, and the SHA-256 of the normalized approved database host/port/name. Configure these only in the two protected GitHub environments documented below.
7. Configure the separate `contracttwin-production-bootstrap` environment with `PRODUCTION_DATABASE_BOOTSTRAP_URL`, `MIGRATION_DATABASE_URL`, the three target values, and Vercel access. Approve and run `ContractTwin Production Target Bootstrap` once from current `main`. Confirm it creates only the separately owned target marker and performs no application/auth migration or deployment; then revoke/remove the bootstrap credential.
8. Configure `MIGRATION_DATABASE_URL` plus the same three target values on `contracttwin-production`, approve and dispatch the production release workflow, and let its schema gate prove the distinct migrator/runtime credentials currently reach the same externally anchored database at the approved logical endpoint before applying every checksum-verified ContractTwin migration through `014_release_database_external_identity.sql`, followed by the Better Auth schema. Migration `014` must map the approved external logical identity to migration `010`'s preserved physical identity without rewriting prior migration or release receipts. Never add protected database or anchor credentials to Vercel or any application/runtime env file.
9. Verify `/api/health` and `/api/readiness` without exposing secrets. Readiness must identify authentication, database, private Blob, ClamAV, OpenAI and OCR configuration; demo readiness is intentionally sanitized and is not activation evidence.
10. Sign in as the identity configured in `BOOTSTRAP_ADMIN_EMAIL`, open `/bootstrap-admin`, explicitly bootstrap the first Admin, verify `/admin`, then remove `BOOTSTRAP_ADMIN_EMAIL` from production.
11. Grant user roles through `/admin`; separately grant `LEGAL_COUNSEL_ATTEST` only to active, qualified Lawyer/Approver/Admin users under the documented counsel-authority process; configure restricted-matter memberships through each matter workspace.
12. Load formally approved negotiation standards. New standards remain inactive until a separate Admin activation action.
13. Run the frozen production validation suite from `/admin` against the exact configured model, prompt, corpus and validation-gate versions. Review every failed, missing, duplicate, unexpected, unsafe, normalized source-containment, or rejected-ungrounded result; do not lower thresholds merely to obtain a pass. The legacy `exact_quote_failure_count` field is not byte-exact because the current evaluator normalizes case and whitespace.
14. Execute the live target-environment acceptance procedure in section 12 using approved synthetic sources.
15. Complete security/privacy/privilege/records-management review, backup/restore testing and penetration or risk-based security testing.
16. Confirm `/api/readiness` reports the production infrastructure, exact current validation evidence, complete required standard coverage, and an empty approved evidence-kernel blocker list as ready. Only then consider setting `LEGAL_RELIANCE_ENABLED=true` through approved change management.

## 2. Safe model or prompt upgrade

Any change to a production OpenAI model, analysis prompt, output schema, graph version or economics formula invalidates prior reliance evidence for the changed engine manifest.

1. Set or keep `LEGAL_RELIANCE_ENABLED=false` during the change window.
2. Deploy the proposed model/prompt to preview/staging.
3. Add a new migration/policy version; never rewrite an applied engine policy or historical receipt. Run the frozen validation suite against the exact proposed engine manifest and corpus version.
4. Compare failure modes, grounding, expected-family recall and unsafe-conclusion metrics against the approved baseline.
5. Have Legal Engineering review material behavioral changes.
6. Promote only after validation passes and required human approval is recorded.
7. Confirm readiness resolves the new active engine policies and exact engine-manifest/corpus validation record.
8. Re-enable reliance only under approved change management.

Do not reuse a passing validation record, counsel receipt, graph receipt or economics run from a different engine manifest, input generation, agreement version or formula version.

## 3. Negotiation standard change

1. Admin creates the proposed standard in `/admin`. It is inactive by design.
2. Legal/Finance/BU stakeholders review the standard, fallback, no-go, authority and business rationale outside the activation action as required by company governance.
3. Admin activates the approved version explicitly.
4. Activation automatically retires the prior active standard for that clause family.
5. Audit history preserves the activation event and version.
6. If a standard materially changes risk decisions, rerun appropriate regression/acceptance testing before reliance.

AI must never be used as the source of company policy.

## 4. Contract matter lifecycle

### Open matter

- Create the customer/agreement matter.
- Apply confidentiality/privilege classification.
- Mark restricted matters when access should be membership-controlled.
- Add permitted matter members.

### Load source set

- Upload source documents through the matter workspace.
- The registered source begins in `PENDING` malware-scan state. It is not available for normal retrieval or extraction in this state.
- Start the governed document pipeline. ClamAV scanning is the first stage; only `CLEAN` proceeds. `QUARANTINED` is a terminal content block, while `FAILED` requires investigation and an authorized retry after the scanner/service issue is corrected.
- After a clean scan, the browser's preliminary SHA-256 is independently recomputed by the server before verified extraction. A mismatch stops processing.
- Verify document type/version label and source-set completeness.
- Create/freeze an agreement version when the operative document package is known.

### Process

- Run the full ContractTwin pipeline on relevant source documents.
- Resolve OCR/extraction failures before relying on downstream analysis.
- Review atomic terms, dependency edges and document precedence relationships.
- Validate/reject current graph objects and findings with a substantive review note; do not treat `UNREVIEWED` objects as approved legal conclusions. `SUPERSEDED` objects remain historical and are not current outputs.
- The full document pipeline stops after precedence analysis. It does not generate or refresh an executive snapshot.

### Quantify

- Enter explicit financial/operational assumptions in the deterministic economics panel.
- Validate assumptions with Finance/Operations as appropriate.
- Treat economics runs as scenarios, not accounting books and records.
- For evidence protocol 1, lock the governed agreement version only while explicitly selecting one exact validated run that belongs to that same matter/version and uses the single active current formula. The resulting `authoritative_economics_run_id` cannot be replaced on that version; create a new agreement version to rely on a different scenario.
- Treat protocol-0 legacy rows as readable non-reliance history only; do not use them to authorize production execution. The expand-safe bridge remains technically available until the separately blocked mixed-bundle drain and contract-enforcement phase completes.

### Decide

- Create authority requests separately from legal recommendations.
- Authorized Approvers/Admins disposition pending decisions under the pilot's coarse stored role rule; the requester cannot disposition the same request. Do not treat this as a delegated Finance/Legal/Business/Quality/Operations authority matrix.
- An authorized Approver explicitly generates a new frozen executive snapshot after material review/economic/decision changes. Before production reliance is activated, the accepted contract must require an approved/executed protocol-1 agreement version, active clean/hash-verified/extracted source set, current successful analysis runs, no current unreviewed objects, documented validated reviews, and the version's exact immutable authoritative economics run. Approved decisions and the snapshot must bind that same run. Migration `013` alone does not complete snapshot-wide contract enforcement; Finance/Operations review of the selected scenario also remains an operator approval responsibility.
- Use the snapshot-specific executive-summary link for historical review. A requested snapshot ID must resolve exactly; operators must not assume a missing historical snapshot silently falls back to the latest state.

### Close/supersede

- Do not use `APPROVED` as legal/business approval or `EXECUTED` as authentic execution certification. Both production transitions remain fail-closed until the ADR-0003 lifecycle and authentic execution-evidence migration are delivered; `APPROVED` currently means only package lock. Protocol-0 rows are legacy non-reliance history and must not authorize production execution. Protocol 1 adds exact economics evidence binding but does not cure the missing legal/business approval, snapshot-contract or execution-proof capabilities.
- Supersede prior package states only through an authorized human action with the exact successor evidence preserved.
- Apply retention category/date under approved company policy.
- Preserve legal holds until formally released by authorized personnel.

## 5. Scanned/large-document processing

- All sources must pass ClamAV before any extraction path. Machine-readable PDFs/DOCX/TXT then use local extraction and hashed source chunks.
- XLSX and scanned/otherwise non-machine-readable sources are routed to the configured Azure Document Intelligence Layout service.
- External processing enters a durable `WAITING_EXTERNAL` state instead of consuming retry attempts merely because the provider is still processing.
- `JOB_LEASE_SECONDS` defaults to 900 seconds and is clamped to 60–3600; worker heartbeats run at one third of the lease duration, capped to 5–30 seconds. An expired timestamp permits takeover only when the processor advisory lock is also available; takeover advances the monotonic generation and stale generations cannot publish.
- `JOB_LEASE_RECOVERY_ENABLED` is default-off and must remain unset or `false` during the first fencing-capable deployment. Stop routing new work to the pre-fencing bundle, drain every pre-fencing worker, and prove none can resume before enabling recovery in a separately approved change. Exercise one controlled expired-lease takeover and verify the stale generation cannot publish. On rollback, set recovery to `false` and drain fenced workers before any older bundle is allowed to run.
- Tune the lease only after measuring worst-case provider and database latency. Alert on expired RUNNING leases, repeated generation changes and heartbeat failures; the current matter job list does not yet expose generation/heartbeat/expiry fields, so operator-facing lease observability remains a production gap.
- If the external service fails, inspect the processing job and rerun only after the root cause is addressed.
- Do not manually copy extracted text into the database as a substitute for the provenance pipeline.

### Malware-scan operations

- Configure `CLAMAV_HOST`; optionally set `CLAMAV_PORT` (default `3310`) and `CLAMAV_TIMEOUT_MS` (default `60000`, accepted range 1000–300000).
- The current client uses raw TCP INSTREAM without TLS or scanner credentials. Expose it only through an approved private network path with restrictive network policy; do not point `CLAMAV_HOST` at a public or untrusted endpoint.
- Configure ClamAV's stream-size limit and runtime capacity to accept the application's 75 MiB maximum upload, or reduce the application upload limit in a reviewed code change. Exercise files near the approved maximum in staging and tune timeout/memory/capacity without bypassing the scan.
- Manage signature currency, patching, monitoring and capacity under the approved security process.
- `PENDING` means no completed result; `CLEAN` permits downstream retrieval/extraction; `QUARANTINED` means a signature was detected; `FAILED` means the scan could not be trusted or completed.
- Do not manually set a source to `CLEAN`. Investigate scanner responses and retry through the governed job path. Preserve the source and relevant evidence for incident handling; do not download a quarantined object through ordinary user workflows.
- Validate clean, detected and unavailable/unrecognized scanner paths in staging with approved synthetic fixtures before production activation. Do not commit malware test files to this repository.

## 6. Source purge / records destruction

`ALLOW_SOURCE_PURGE=false` is the normal safe state.

A source object may be destroyed only when all of the following are true:

- an authorized legal editor has created a documented purge request;
- a different Admin has approved it;
- no matter or document legal hold is active;
- a valid retention end date is recorded and has expired;
- records management has separately authorized production purge capability; and
- `ALLOW_SOURCE_PURGE=true` has been enabled through approved change management.

Execution is two-phase: the database first records `PENDING_PURGE`, then the private Blob is deleted, then a separate transaction records `PURGED`, the executed request, and audit evidence. If external deletion or finalization fails, leave the pending state in place and investigate/retry through the governed path; do not manually erase the database record. Blob-not-found may be treated as already deleted only during a properly authorized retry. After deletion, ContractTwin preserves the document tombstone and audit history. If there is any uncertainty, do not purge.

## 7. Access review

At the cadence required by company policy:

- review active Admin/Approver/Lawyer roles;
- remove roles for departed/transferred users;
- review restricted-matter memberships;
- verify the bootstrap variable remains absent after first use;
- review Entra conditional access/MFA configuration; and
- review production secrets/credential rotation.

## 8. Database migration

- Never edit an already-applied ContractTwin migration file.
- Create a new numbered migration.
- Save migration source as UTF-8 without a byte-order mark. The migrator canonicalizes CRLF or CR to LF and hashes and executes that same canonical text; `.gitattributes` also keeps committed migration checkouts on LF.
- Treat a manifest-v1 or other legacy raw-line-ending receipt mismatch as a blocked, incompatible target. No automatic receipt upgrade exists: do not rewrite `schema_migrations` to make it pass. Preserve the original evidence, provision a clean target from the canonical migrations, and move any retained data only under an independently approved and validated recovery plan.
- `npm run db:migrate` performs a read-only canonical-receipt target preflight, applies the atomic ContractTwin migration set, and only then changes the Better Auth schema; each phase rechecks under the ContractTwin advisory lock. This order makes a fresh bootstrap recoverable after either phase fails. Do not bypass that orchestration by invoking a library migration API directly.
- CI validates migrations against disposable PostgreSQL and re-applies them for idempotency.
- A normal production migration first requires the separately provisioned target marker to match the protected token hash, endpoint descriptor, and database UUID; it never auto-anchors an empty database. It then performs the non-persistent, two-challenge advisory-lock handshake across the distinct migrator/runtime sessions. Holder transactions remain open throughout schema work, and every mutating transaction must see the held locks and fingerprint before DDL. A later target switch rolls back the affected transaction before it mutates the unproved target, although an earlier valid phase may have committed. The first application migration permits only the separately owned anchor marker and rejects every other counted user schema/relation/routine/type or non-default extension.
- Maintain distinct production database roles: `DATABASE_URL` is the Vercel application runtime identity and must be denied DDL and migration-history writes; `MIGRATION_DATABASE_URL` is the privileged migrator identity. Both URLs must use `sslmode=verify-full`, and the production gate must prove each live backend session is encrypted before promotion.
- Store `MIGRATION_DATABASE_URL` only as a protected `contracttwin-production` GitHub environment secret. The workflow may expose it only to the schema-gate step; never configure it in Vercel, write it to the temporary pulled production env file, or expose it to builds, functions, workers, previews, or post-deployment checks.
- Store `EXPECTED_PRODUCTION_TARGET_TOKEN`, `EXPECTED_PRODUCTION_DATABASE_ID`, `EXPECTED_PRODUCTION_RUNTIME_DATABASE_ENDPOINT_SHA256`, and `EXPECTED_PRODUCTION_MIGRATION_DATABASE_ENDPOINT_SHA256` identically in the protected release and bootstrap environments, never in Vercel. Store `PRODUCTION_DATABASE_BOOTSTRAP_URL` and `EXPECTED_PRODUCTION_BOOTSTRAP_DATABASE_ENDPOINT_SHA256` only in `contracttwin-production-bootstrap`; remove/revoke the bootstrap credential after the marker is verified. The role-specific hashes may intentionally describe different approved pooler/direct endpoints. The normal release must fail when any target value or marker is absent or mismatched.
- Rotate the migration and runtime credentials independently and verify that the schema gate proves TLS 1.2/1.3 for each live session, completes the pre-mutation live-database challenge, both credentials reach the same post-migration database identity, the runtime can read but cannot forge the per-release receipt, and the runtime role retains no DDL, migration-history, or release-control write authority. Both roles must be able to read `pg_database` and execute `pg_control_system()`, `pg_postmaster_start_time()`, `pg_is_in_recovery()`, and transaction advisory-lock functions; if a provider revokes a stock function privilege, grant only the required function execution rather than a broad monitoring role. Treat an in-place restore, clone, or provider routing change behind the approved endpoint as a separately authorized production change: the database-resident marker is copied with the database and cannot by itself prove resource incarnation. Record provider control-plane evidence and restore approval outside the database before restoring legal reliance.
- Back up the production database according to approved policy before material schema changes.

Every migration through `014_release_database_external_identity.sql` is a blocking prerequisite for the current application. Together they add source quarantine and exact extraction-generation ownership, analysis-run lineage, agreement-version-scoped lifecycle/graph controls, engine policies, immutable publication/review receipts, separate counsel authority, independent decision disposition, governed-standard provenance, purge constraints, database-level execution gates, exact executive-snapshot generator/terminal receipts, a preserved physical database identity with append-only per-release target receipts, counsel-authorized legal-object disposition with durable decision rationale, monotonic worker leases with heartbeat/expiry evidence, an expand-safe protocol-1 decision/economics path whose authoritative agreement-version selection is immutable, and an immutable mapping from the approved external logical database identity to that physical identity. Migration `013` intentionally preserves protocol-0 behavior for mixed-bundle compatibility; those rows are non-reliance, and production stays source-gated until the drain and follow-on contract-enforcement phase retires the bridge. Before production activation:

1. apply all migrations in staging through `npm run db:migrate`;
2. rerun migration to verify idempotency and checksum history;
3. run the database-control integration checks against PostgreSQL 17 and verify the live critical-control manifest; deliberately disabling a required trigger with migration receipts intact must make release verification fail;
4. verify application and worker versions are deployed together with the schema change; and
5. apply production migration only under the approved backup/change/rollback procedure.

## 9. Incident response

For suspected unauthorized access, source leakage, AI data-handling issue, corrupted source integrity, or audit anomaly:

1. disable or restrict application access using the approved production control plane;
2. set `LEGAL_RELIANCE_ENABLED=false` if output trust is affected;
3. preserve logs, database/audit evidence and relevant source fingerprints;
4. do not purge implicated source records;
5. invoke the company's security/legal incident process;
6. identify affected matters/users/source objects;
7. remediate and rotate credentials where required;
8. revalidate model/prompt behavior if inference integrity is implicated; and
9. document the decision to restore service/reliance.

## 10. Backup and disaster recovery

Backup cadence, geographic replication, RPO/RTO and retention are environment/company decisions and are not invented by this repository. Production approval should require documented PostgreSQL backup/restore procedures and source-object recovery/retention procedures consistent with the chosen private Blob configuration and corporate policy.

Perform an actual restore drill before treating disaster recovery as operational.

## 11. Release procedure

A release candidate must use the committed `package-lock.json` and pass:

- Better Auth + ContractTwin migration application;
- migration idempotency;
- database legal-control invariants;
- application access/readiness/security-boundary controls;
- frozen corpus structural validation;
- deterministic economics tests;
- TypeScript;
- production dependency audit;
- full Next.js/Workflow production build; and
- CodeQL.

A release attestation is valid only if it binds the exact tested source SHA and records every required gate above, including application controls, target migration receipts, the live critical-database-control manifest, and runtime-role least-privilege proof. Retain the run-scoped attestation artifact and verify its digest from the workflow summary; the evidence workflow must not commit files back to or otherwise advance the tested source branch. The production workflow must expose the protected migration credential only to the schema-gate step, migrate and verify the target database, verify the separately pulled runtime credential without substituting it for the migrator, stage the exact prebuilt artifact without assigning the production domain, pass the token-protected live release proof, and only then promote that staged URL. Do not infer coverage from an attestation filename or workflow success; verify the gate list for the exact workflow revision and SHA. This runbook does not claim those checks have run. A code-complete attestation does **not** assert that external production infrastructure, company policy, live target-environment behavior, or real-contract legal validation has been approved.

## 12. Live target-environment acceptance

Before confidential production use, record dated evidence, source/deployment SHAs, environment, tester and approver for each of the following using approved synthetic content:

1. Entra sign-in, Viewer/Lawyer/Approver/Admin enforcement, restricted-matter membership, and denial of demo persistence.
2. Private Blob upload/retrieval and denial before `CLEAN` malware status.
3. ClamAV clean, detected/quarantine, unavailable, timeout and unrecognized-response paths.
4. Client/server SHA-256 match and deliberate mismatch failure before extraction.
5. Machine-readable extraction, exact-generation OCR submission/polling, provenance hashes, stale-worker rejection, retry/idempotency and terminal-failure visibility.
6. Atomic clause/term publication; version-scoped dependency/precedence publication; rejection of invalid, duplicate or ungrounded output; and immutable counsel attestation for both populated and valid zero-output runs.
7. Separate counsel-capability and application-role enforcement, authority derivation, independent decision disposition, agreement-status transitions, hold release and audit evidence.
8. After all pre-protocol-1 bundles are drained and contract enforcement is deployed, verify execution and explicit snapshot generation only after current engine/run/graph attestations, decision conditions and the protocol-1 agreement version's exact immutable authoritative economics run; verify that every approved decision and the snapshot bind that same run, rerunning the document pipeline does not auto-create a snapshot, and the snapshot's successful generator receipt binds the authorized requester plus the expected canonical source/analysis/graph/economics/reliance state hash. Confirm protocol-0 and direct receipt-less rows remain readable only as non-reliance history and are rejected from production execution/reliance.
9. Legal-hold and retention blocking, two-phase purge retry/recovery, and preservation of tombstone/audit history with purge disabled by default.
10. PostgreSQL backup restoration, operational monitoring/alerting and incident-response handoff.

A green `/api/readiness` result is necessary but not sufficient; named Legal, Security, Records, Business/Finance and Technical owners must accept the evidence applicable to their control areas before activation.
