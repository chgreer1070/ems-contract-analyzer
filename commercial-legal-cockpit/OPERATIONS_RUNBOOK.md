# ContractTwin Production Operations Runbook

This runbook governs activation and operation of the EMS Commercial Legal Cockpit. It does not replace corporate information-security, records-management, privilege, change-management or business-continuity policies.

## 1. Production activation

1. Place the application in an approved private repository.
2. Create the production Vercel project with root directory `commercial-legal-cockpit`.
3. Provision private PostgreSQL, private Vercel Blob, Microsoft Entra application registration, Azure Document Intelligence and the approved OpenAI API/enterprise configuration.
4. Configure encrypted production environment variables from `.env.example`. Keep `LEGAL_RELIANCE_ENABLED=false` and `ALLOW_SOURCE_PURGE=false`.
5. Run `npm ci` from the committed lockfile.
6. Run `npm run db:migrate`. This applies the Better Auth schema and checksum-verified ContractTwin migrations.
7. Verify `/api/health` and `/api/readiness` without exposing secrets.
8. Sign in as the identity configured in `BOOTSTRAP_ADMIN_EMAIL`, open `/bootstrap-admin`, explicitly bootstrap the first Admin, verify `/admin`, then remove `BOOTSTRAP_ADMIN_EMAIL` from production.
9. Grant user roles through `/admin`; configure restricted-matter memberships through each matter workspace.
10. Load formally approved negotiation standards. New standards remain inactive until a separate Admin activation action.
11. Run the frozen production validation suite from `/admin`. Review every failed case; do not lower thresholds merely to obtain a pass.
12. Complete security/privacy/privilege/records-management review, backup/restore testing and penetration testing.
13. Confirm `/api/readiness` reports the production infrastructure, current validation and required standard coverage as ready.
14. Only then consider setting `LEGAL_RELIANCE_ENABLED=true` through approved change management.

## 2. Safe model or prompt upgrade

Any change to the production OpenAI model or source-grounded analysis prompt invalidates prior reliance evidence for the new combination.

1. Set or keep `LEGAL_RELIANCE_ENABLED=false` during the change window.
2. Deploy the proposed model/prompt to preview/staging.
3. Run the frozen validation suite against the exact model, prompt and corpus versions.
4. Compare failure modes, grounding, expected-family recall and unsafe-conclusion metrics against the approved baseline.
5. Have Legal Engineering review material behavioral changes.
6. Promote only after validation passes and required human approval is recorded.
7. Confirm readiness resolves the new current model/prompt/corpus validation record.
8. Re-enable reliance only under approved change management.

Do not reuse a passing validation record from a different model or prompt version.

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
- The browser creates a preliminary SHA-256; the server independently verifies it before extraction.
- Verify document type/version label and source-set completeness.
- Create/freeze an agreement version when the operative document package is known.

### Process

- Run the full ContractTwin pipeline on relevant source documents.
- Resolve OCR/extraction failures before relying on downstream analysis.
- Review atomic terms, dependency edges and document precedence relationships.
- Validate/reject material graph objects and findings; do not treat UNREVIEWED objects as approved legal conclusions.

### Quantify

- Enter explicit financial/operational assumptions in the deterministic economics panel.
- Validate assumptions with Finance/Operations as appropriate.
- Treat economics runs as scenarios, not accounting books and records.

### Decide

- Create authority requests separately from legal recommendations.
- Authorized Approvers/Admins disposition pending decisions.
- Generate a new frozen executive snapshot after material review/economic/decision changes.

### Close/supersede

- Mark agreement versions approved/executed/superseded through authorized human actions.
- Apply retention category/date under approved company policy.
- Preserve legal holds until formally released by authorized personnel.

## 5. Scanned/large-document processing

- Machine-readable PDFs/DOCX/TXT use local extraction and hashed source chunks.
- XLSX and scanned/otherwise non-machine-readable sources are routed to the configured Azure Document Intelligence Layout service.
- External processing enters a durable `WAITING_EXTERNAL` state instead of consuming retry attempts merely because the provider is still processing.
- If the external service fails, inspect the processing job and rerun only after the root cause is addressed.
- Do not manually copy extracted text into the database as a substitute for the provenance pipeline.

## 6. Source purge / records destruction

`ALLOW_SOURCE_PURGE=false` is the normal safe state.

A source object may be destroyed only when all of the following are true:

- a lawyer has created a documented purge request;
- a different Admin has approved it;
- no matter or document legal hold is active;
- a valid retention end date is recorded and has expired;
- records management has separately authorized production purge capability; and
- `ALLOW_SOURCE_PURGE=true` has been enabled through approved change management.

After deletion, ContractTwin preserves the document tombstone and audit history. If there is any uncertainty, do not purge.

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
- Production migration uses advisory locking and SHA-256 history checks.
- Back up the production database according to approved policy before material schema changes.

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
- frozen corpus structural validation;
- deterministic economics tests;
- TypeScript;
- production dependency audit;
- full Next.js/Workflow production build; and
- CodeQL.

The release-attestation workflow records the exact tested source SHA only after all required gates pass. A code-complete attestation does **not** assert that external production infrastructure, company policy, or real-contract legal validation has been approved.
