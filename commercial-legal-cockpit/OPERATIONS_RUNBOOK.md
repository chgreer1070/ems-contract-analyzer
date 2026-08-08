# ContractTwin Production Operations Runbook

This runbook governs activation and operation of the EMS Commercial Legal Cockpit. It does not replace corporate information-security, records-management, privilege, change-management or business-continuity policies.

## 1. Production activation

1. Place the application in an approved private repository.
2. Create the production Vercel project with root directory `commercial-legal-cockpit`.
3. Provision private PostgreSQL, private Vercel Blob, Microsoft Entra application registration, a private ClamAV service reachable from the application runtime, Azure Document Intelligence and the approved OpenAI API/enterprise configuration.
4. Configure encrypted Vercel runtime variables from `.env.example`. Use a certificate-verifying, least-privilege `DATABASE_URL` with `sslmode=verify-full` that cannot perform DDL or mutate migration history. Set `AUTH_REQUIRED=true` and `ALLOW_DEMO_ACCESS=false`; keep `LEGAL_RELIANCE_ENABLED=false` and `ALLOW_SOURCE_PURGE=false`.
5. Run `npm ci` from the committed lockfile.
6. Configure `MIGRATION_DATABASE_URL` only as a secret on the protected GitHub `contracttwin-production` environment, approve and dispatch the production release workflow, and let its schema gate apply the Better Auth schema and every checksum-verified ContractTwin migration through `010_release_target_binding.sql`. Never add this credential to Vercel or any application/runtime env file.
7. Verify `/api/health` and `/api/readiness` without exposing secrets. Readiness must identify authentication, database, private Blob, ClamAV, OpenAI and OCR configuration; demo readiness is intentionally sanitized and is not activation evidence.
8. Sign in as the identity configured in `BOOTSTRAP_ADMIN_EMAIL`, open `/bootstrap-admin`, explicitly bootstrap the first Admin, verify `/admin`, then remove `BOOTSTRAP_ADMIN_EMAIL` from production.
9. Grant user roles through `/admin`; separately grant `LEGAL_COUNSEL_ATTEST` only to active, qualified Lawyer/Approver/Admin users under the documented counsel-authority process; configure restricted-matter memberships through each matter workspace.
10. Load formally approved negotiation standards. New standards remain inactive until a separate Admin activation action.
11. Run the frozen production validation suite from `/admin` against the exact configured model, prompt, corpus and validation-gate versions. Review every failed, missing, duplicate, unexpected, unsafe, exact-quote, or rejected-ungrounded result; do not lower thresholds merely to obtain a pass.
12. Execute the live target-environment acceptance procedure in section 12 using approved synthetic sources.
13. Complete security/privacy/privilege/records-management review, backup/restore testing and penetration or risk-based security testing.
14. Confirm `/api/readiness` reports the production infrastructure, exact current validation evidence and complete required standard coverage as ready.
15. Only then consider setting `LEGAL_RELIANCE_ENABLED=true` through approved change management.

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

### Decide

- Create authority requests separately from legal recommendations.
- Authorized Approvers/Admins disposition pending decisions according to the stored authority level; the requester cannot disposition the same request.
- An authorized Approver explicitly generates a new frozen executive snapshot after material review/economic/decision changes. The server requires an approved/executed agreement version, active clean/hash-verified/extracted source set, current successful analysis runs, no current unreviewed objects, documented validated reviews, and a deliberately saved economics scenario. Finance/Operations review of the saved scenario remains an operator approval responsibility.
- Use the snapshot-specific executive-summary link for historical review. A requested snapshot ID must resolve exactly; operators must not assume a missing historical snapshot silently falls back to the latest state.

### Close/supersede

- Mark agreement versions approved/executed/superseded through authorized human actions.
- Apply retention category/date under approved company policy.
- Preserve legal holds until formally released by authorized personnel.

## 5. Scanned/large-document processing

- All sources must pass ClamAV before any extraction path. Machine-readable PDFs/DOCX/TXT then use local extraction and hashed source chunks.
- XLSX and scanned/otherwise non-machine-readable sources are routed to the configured Azure Document Intelligence Layout service.
- External processing enters a durable `WAITING_EXTERNAL` state instead of consuming retry attempts merely because the provider is still processing.
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
- CI validates migrations against disposable PostgreSQL and re-applies them for idempotency.
- Production migration uses advisory locking and SHA-256 history checks through the approval-gated schema step.
- Maintain distinct production database roles: `DATABASE_URL` is the Vercel application runtime identity and must be denied DDL and migration-history writes; `MIGRATION_DATABASE_URL` is the privileged migrator identity. Both URLs must use `sslmode=verify-full`, and the production gate must prove each live backend session is encrypted before promotion.
- Store `MIGRATION_DATABASE_URL` only as a protected `contracttwin-production` GitHub environment secret. The workflow may expose it only to the schema-gate step; never configure it in Vercel, write it to the temporary pulled production env file, or expose it to builds, functions, workers, previews, or post-deployment checks.
- Rotate the migration and runtime credentials independently and verify that the schema gate proves TLS 1.2/1.3 for each live session, both credentials reach the same immutable database identity, the runtime can read but cannot forge the per-release receipt, and the runtime role retains no DDL, migration-history, or release-control write authority.
- Back up the production database according to approved policy before material schema changes.

Every migration through `010_release_target_binding.sql` is a blocking prerequisite for the current application. Together they add source quarantine and exact extraction-generation ownership, analysis-run lineage, agreement-version-scoped lifecycle/graph controls, engine policies, immutable publication/review receipts, separate counsel authority, independent decision disposition, governed-standard provenance, purge constraints, database-level execution gates, exact executive-snapshot generator/terminal receipts, and immutable database identity with append-only per-release target receipts. Before production activation:

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

A release attestation is valid only if it binds the exact tested source SHA and records every required gate above, including application controls, target migration receipts, the live critical-database-control manifest, and runtime-role least-privilege proof. The production workflow must expose the protected migration credential only to the schema-gate step, migrate and verify the target database, verify the separately pulled runtime credential without substituting it for the migrator, stage the exact prebuilt artifact without assigning the production domain, pass the token-protected live release proof, and only then promote that staged URL. Do not infer coverage from an attestation filename or workflow success; verify the gate list for the exact workflow revision and SHA. This runbook does not claim those checks have run. A code-complete attestation does **not** assert that external production infrastructure, company policy, live target-environment behavior, or real-contract legal validation has been approved.

## 12. Live target-environment acceptance

Before confidential production use, record dated evidence, source/deployment SHAs, environment, tester and approver for each of the following using approved synthetic content:

1. Entra sign-in, Viewer/Lawyer/Approver/Admin enforcement, restricted-matter membership, and denial of demo persistence.
2. Private Blob upload/retrieval and denial before `CLEAN` malware status.
3. ClamAV clean, detected/quarantine, unavailable, timeout and unrecognized-response paths.
4. Client/server SHA-256 match and deliberate mismatch failure before extraction.
5. Machine-readable extraction, exact-generation OCR submission/polling, provenance hashes, stale-worker rejection, retry/idempotency and terminal-failure visibility.
6. Atomic clause/term publication; version-scoped dependency/precedence publication; rejection of invalid, duplicate or ungrounded output; and immutable counsel attestation for both populated and valid zero-output runs.
7. Separate counsel-capability and application-role enforcement, authority derivation, independent decision disposition, agreement-status transitions, hold release and audit evidence.
8. Execution and explicit snapshot generation only after current engine/run/graph attestations, decision conditions and current-formula economics; verify that rerunning the document pipeline does not auto-create a snapshot and that the snapshot's successful generator receipt binds the authorized requester plus the expected canonical source/analysis/graph/economics/reliance state hash. Confirm a direct receipt-less insert remains non-reliance or is rejected.
9. Legal-hold and retention blocking, two-phase purge retry/recovery, and preservation of tombstone/audit history with purge disabled by default.
10. PostgreSQL backup restoration, operational monitoring/alerting and incident-response handoff.

A green `/api/readiness` result is necessary but not sufficient; named Legal, Security, Records, Business/Finance and Technical owners must accept the evidence applicable to their control areas before activation.
