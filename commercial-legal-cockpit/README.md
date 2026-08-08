# ContractTwin / EMS Commercial Legal Cockpit

Production-oriented legal engineering application that treats EMS contracts as commercial-operational systems. It converts an authorized agreement source set into source-grounded legal/operational objects, dependency and precedence graphs, deterministic economics, governed negotiation positions, human-reviewed findings, approval decisions, explicitly generated executive snapshots, and an immutable audit record.

> **Readiness boundary:** a feature-complete or code-complete release candidate is not a production-activated legal system. Confidential use still depends on approved private infrastructure, production identity and data-handling controls, migration and recovery verification, current-model legal validation, approved company standards, live end-to-end acceptance testing, and formal owner approval. This repository and its documentation do not themselves attest that those external gates have passed.

> **Repository boundary:** this GitHub repository is currently public. Keep it code/synthetic-data only. Do not commit confidential contracts, company negotiation standards, credentials, customer data, privileged analysis, or internal production configuration. Move production development to an approved private repository before adding proprietary content.

## Product surfaces

- `/` — production-backed executive portfolio cockpit; synthetic demo data only when the server explicitly returns demo mode.
- `/matters/:id` — counsel matter workspace: source set, secure upload, records governance, durable processing, atomic contract twin, precedence, findings, economics, decisions, agreement versions, snapshots, and audit.
- `/matters/:id/executive-summary` — frozen print-ready executive decision brief tied to a source-state hash.
- `/admin` — legal engineering control plane: readiness, frozen validation, negotiation standards, user roles, and controlled source-purge administration.

## Architecture

### Application and identity

- Next.js 16 / React 19 / TypeScript.
- Better Auth using Microsoft Entra ID as the production identity provider.
- PostgreSQL-backed Better Auth schema plus ContractTwin application schema.
- Server-enforced `VIEWER`, `LAWYER`, `APPROVER`, and `ADMIN` roles.
- Restricted matters require explicit matter membership; role alone does not bypass a restricted matter except Admin.
- One-time first-Admin bootstrap is restricted to `BOOTSTRAP_ADMIN_EMAIL`, only when zero active Admins exist, and must be removed after use.

### Source documents and evidence chain

- Private Vercel Blob object storage.
- New uploads are registered with malware status `PENDING`; source retrieval and parsing are blocked until the governed pipeline receives a `CLEAN` result from the configured ClamAV service.
- A detection changes the source to `QUARANTINED` and stops the pipeline. Scanner or transport failures change it to `FAILED`; neither state is treated as clean.
- SHA-256 is computed in the browser before upload and independently recomputed server-side before extraction.
- Source blobs are never rewritten by analysis.
- PDF text extraction preserves page provenance where machine-readable.
- DOCX and TXT are normalized into hashed source chunks.
- Scanned PDFs and XLSX/Office layout extraction are delegated to Azure Document Intelligence Layout; polling is durable and source provenance is retained.
- Purged source objects return HTTP 410 while database tombstone/audit metadata remains.

### Durable processing

Vercel Workflow DevKit persists long-running contract processing across function timeouts and deployments. A full document pipeline performs:

1. malware scanning and quarantine enforcement;
2. independent source-integrity verification;
3. text/layout extraction or asynchronous OCR;
4. source-grounded clause-risk analysis;
5. atomic contract-term extraction;
6. term-dependency graph analysis; and
7. matter-wide document precedence/lineage analysis.

Each stage has database idempotency keys, retry state, and durable continuation. External OCR polling does not consume failure retries merely because the external service is still processing.

The document pipeline deliberately does **not** generate an executive snapshot. An authorized user must request a snapshot separately after approving an agreement version, completing human disposition of current source-derived objects, deliberately saving an economics scenario, and satisfying the source/run provenance checks. This prevents processing a document from silently freezing an incomplete executive state.

### ContractTwin graph

PostgreSQL stores first-class objects for:

- agreement package versions and their document membership;
- document relationships (`AMENDS`, `SUPERSEDES`, `CONTROLS`, `CONFLICTS_WITH`, etc.);
- atomic contract terms (`OBLIGATION`, `RIGHT`, `CONDITION`, `REMEDY`, `ALLOCATION`, etc.);
- term dependencies (`TRIGGERS`, `LIMITS`, `PRICES`, `ALLOCATES_RISK`, etc.);
- findings, economics, decisions, processing jobs, analysis-run provenance, validation evidence, and executive snapshots.

AI-generated graph objects remain `UNREVIEWED` until counsel validates or rejects them with a substantive review note. Superseded unreviewed results remain distinguishable from current analysis. Counsel may directly record a validated document relationship with a stated legal rationale.

### AI boundary

- OpenAI Responses API uses strict structured outputs.
- Source excerpts must be verbatim contiguous text present in the supplied source; ungrounded model output is discarded.
- The model identifies contract facts, legal/operational consequences, uncertainty, and potential financial variables.
- **The model does not invent company negotiation policy.** Primary position, fallback, no-go, and approval authority come from separately governed negotiation standards.
- If no approved standard exists, production output says it is missing; illustrative demo positions cannot masquerade as approved policy.

### Economics

Financial consequences are calculated by deterministic versioned software rather than model arithmetic. Current modeled categories include payment-term working capital, stranded inventory/NCNR, termination recovery, warranty reserve, liability-cap gap, gross profit, and modeled burden as a percentage of gross profit.

### Human authority

AI analysis, lawyer validation, approved company standards, and executive authority remain separate states. Decision authority is derived from the decision type and linked finding; a requester cannot disposition their own decision. Agreement-version approval/execution, hold release, and snapshot generation require explicit authorized human actions. ContractTwin does not autonomously approve terms, modify source agreements, send redlines, generate an executive snapshot, or make binding commitments.

## Legal-reliance gate

`LEGAL_RELIANCE_ENABLED=true` is **not** enough to make the application production-ready. When that switch is enabled, the runtime checks all of the following before the durable contract pipeline may start:

- production authentication is required and Microsoft Entra is configured;
- PostgreSQL is configured;
- private Blob storage is configured;
- a ClamAV service is configured through `CLAMAV_HOST`;
- OpenAI is configured;
- Azure Document Intelligence is configured;
- each analysis stage has exactly one active engine policy matching the source-controlled clause, term, dependency and precedence model/prompt/schema manifest;
- the latest completed validation run matches the **current engine manifest + current frozen corpus + current validation gate**, contains an immutable exact result manifest, has the exact expected case set, has no failed cases or rejected ungrounded findings, and passes the required metrics; and
- every required EMS clause family has a complete, governed, non-illustrative active standard with provenance and approval-role metadata.

Current validation thresholds are 95%+ expected-family recall, 100% grounding, zero unsafe prohibited conclusions, zero exact-quote failures, zero rejected ungrounded findings, and all expected cases passing with no missing, duplicate, or unexpected cases. The frozen corpus contains synthetic cases only and is versioned independently of production source data.

## Records governance

Matters support confidentiality and privilege classification, legal holds, retention category/date, and hold history. Destruction is intentionally separate from ordinary application deletion:

1. an authorized legal editor creates a purge request with a records-management reason;
2. an Admin may reject it, while approval requires an Admin different from the requester;
3. execution remains disabled unless `ALLOW_SOURCE_PURGE=true`;
4. execution is blocked by any matter/document legal hold;
5. execution is blocked until a retention end date exists and has expired; and
6. execution first records a durable `PENDING_PURGE` marker, then deletes the private Blob, and finally records `PURGED` in a separate database transaction; and
7. retries remain constrained by the same hold/retention/approval checks, while the document tombstone and audit history remain.

Retention periods are not invented by the application and must come from the approved corporate records policy.

## Database setup

```bash
npm run db:migrate
```

This command first uses Better Auth's programmatic migration API for its installed-version auth schema, then applies ContractTwin migrations transactionally with migration SHA-256 checksums and a PostgreSQL advisory lock. An applied migration that later changes is refused; schema changes require a new migration. The current application requires every migration through `010_release_target_binding.sql`: source/quarantine and run lineage (`006`), agreement-version-scoped lifecycle and graph controls (`007`), exact engine policies, extraction-generation ownership, immutable review attestations, graph provenance and counsel-capability controls (`008`), authorized executive-snapshot generator/terminal receipts (`009`), and immutable database identity plus append-only per-release target receipts and pinned trigger-function search paths (`010`).

CI also applies all migrations to a disposable PostgreSQL 17 instance, reruns them for idempotency, and proves key database invariants including legal-hold purge blocking, append-only audit history, one active standard per clause family, immutable run/receipt evidence, exact agreement-version execution prerequisites and cross-matter lineage rejection.

## Environment

Copy `.env.example`; never commit populated secrets. Production requires approved values for:

- `DATABASE_URL` (the certificate-verifying TLS, least-privilege application runtime role; production requires `sslmode=verify-full`, with no schema-changing or migration-history privileges)
- `BETTER_AUTH_SECRET`
- `BETTER_AUTH_URL`
- `MICROSOFT_CLIENT_ID`
- `MICROSOFT_CLIENT_SECRET`
- `MICROSOFT_TENANT_ID`
- `BLOB_READ_WRITE_TOKEN`
- `CLAMAV_HOST` (with optional `CLAMAV_PORT` and `CLAMAV_TIMEOUT_MS`)
- `OPENAI_API_KEY`
- `OPENAI_MODEL`
- `AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT`
- `AZURE_DOCUMENT_INTELLIGENCE_KEY`
- `RELEASE_ATTESTATION_TOKEN` (high-entropy token for the protected staged-deployment check)
- `VERCEL_AUTOMATION_BYPASS_SECRET` (deployment-protection bypass used only by that check)

One-time bootstrap: `BOOTSTRAP_ADMIN_EMAIL`.

Safety switches default off:

- `LEGAL_RELIANCE_ENABLED=false`
- `ALLOW_SOURCE_PURGE=false`

Production must also set `AUTH_REQUIRED=true` and `ALLOW_DEMO_ACCESS=false`. Demo mode is synthetic/read-only: it receives a Viewer principal, returns sanitized readiness, and must not persist matters, sources, analyses, economics, decisions, standards, or snapshots.

Production schema changes use a separate `MIGRATION_DATABASE_URL`, configured **only** as a secret on the protected GitHub `contracttwin-production` environment. The production workflow exposes it only to the migration/schema-gate step. Do not configure it in Vercel, include it in `.env` files, copy it into the pulled production environment file, or make it available to application builds/functions/workers. The gate uses Vercel's pulled `DATABASE_URL` independently to prove that the least-privilege runtime role can use the required live controls but cannot perform DDL or mutate migration history.

## CI and deployment

`.github/workflows/commercial-legal-cockpit.yml` performs:

- dependency installation;
- static schema-control check;
- Better Auth + ContractTwin migrations against PostgreSQL;
- migration idempotency check;
- database legal-control invariant tests;
- application access, readiness, quarantine, authority, durable-analysis, purge, and snapshot-boundary control checks;
- frozen corpus structure validation;
- deterministic economics tests;
- TypeScript typecheck;
- production dependency vulnerability audit; and
- full Next.js production build.

`.github/workflows/commercial-legal-cockpit-codeql.yml` provides independent JavaScript/TypeScript CodeQL analysis.

`.github/workflows/commercial-legal-cockpit-vercel.yml` contains the separate production release gate. Production never deploys merely because `main` changes: `vercel.json` disables automatic Git deployments for every branch, and production requires an explicit manual dispatch on `main` plus approval through the protected `contracttwin-production` GitHub environment. Do not re-enable Git auto-deployments in repository or project settings. The exact dispatch SHA must pass release preflight and CodeQL and still equal current `main` after approval and immediately before promotion. The workflow downloads only the target Vercel **runtime** environment to a temporary runner file, verifies production-only controls and required services without printing values, builds the exact SHA before mutating the database, then exposes the protected migration credential only to the schema-gate process. That gate verifies TLS 1.2/1.3 for both identities, applies and checksum-verifies the exact ordered migration manifest twice, proves the runtime role's live-control access and denial of privileged operations, and creates an unpredictable append-only receipt tying the exact SHA to the database reached by both credentials. The prebuilt artifact is staged without assigning production domains. A token-protected, non-cacheable live check must prove the build-bound SHA, exact database receipt nonce, full migration manifest, live schema controls, runtime principal and encrypted session, reliance readiness, and deterministic financial control before promotion. Temporary runtime environment files are removed even after failure; the migration credential is never written into them. Deployment remains inert until the required secrets are configured.

Protected GitHub `contracttwin-production` environment secrets used by the deployment job include:

- `VERCEL_TOKEN`
- `VERCEL_ORG_ID`
- `VERCEL_PROJECT_ID`
- `MIGRATION_DATABASE_URL` (approved migration role; schema-gate step only, never Vercel)

The Vercel production runtime environment separately contains application variables from `.env.example`, including `DATABASE_URL`, `RELEASE_ATTESTATION_TOKEN`, and `VERCEL_AUTOMATION_BYPASS_SECRET`. `MIGRATION_DATABASE_URL` must be absent.

Vercel project root directory must be `commercial-legal-cockpit`.

## Production activation sequence

1. Move/replicate the application into an approved **private** GitHub repository.
2. Provision production PostgreSQL, private Blob storage, Microsoft Entra app registration, a private ClamAV service reachable from the runtime, Azure Document Intelligence, approved OpenAI credentials, and a Vercel project.
3. Configure Vercel runtime variables and deployment protection, including `AUTH_REQUIRED=true`, `ALLOW_DEMO_ACCESS=false`, and the least-privilege runtime `DATABASE_URL`.
4. Configure `MIGRATION_DATABASE_URL` only on the protected GitHub `contracttwin-production` environment, then use the approval-gated production workflow to migrate and verify the approved database. Never copy that credential into Vercel or an application/runtime environment file.
5. Sign in with the configured bootstrap identity and perform the one-time Admin bootstrap; then remove `BOOTSTRAP_ADMIN_EMAIL`.
6. Configure user roles and restricted-matter membership rules.
7. Load formally approved negotiation standards; new standards are inactive until separately activated by Admin.
8. Run the frozen legal validation suite against the exact configured production model/prompt/corpus/gate and independently review the results.
9. In the target environment, verify every migration through `010`, exact ordered migration receipts, immutable database identity and per-release target binding, scanner connectivity and clean/quarantine behavior, hash mismatch failure, exact OCR-generation ownership, authorization isolation, durable retries, per-run counsel receipts (including valid zero-output runs), version-scoped graph provenance, explicit approvals, current-formula economics, authorized snapshot job/terminal receipts and state hashes, purge recovery, and backup restoration using synthetic test sources.
10. Complete security/privacy/privilege/records-management review, penetration/risk testing, monitoring setup, and named-owner acceptance.
11. Only after the readiness API is green **and** the live acceptance evidence is approved should `LEGAL_RELIANCE_ENABLED=true` be considered.
12. Keep `ALLOW_SOURCE_PURGE=false` unless records-management leadership separately authorizes purge operations and a recovery-tested runbook is in place.

See `PRODUCTION_READINESS.md` for the acceptance checklist.
