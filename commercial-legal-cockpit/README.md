# ContractTwin / EMS Commercial Legal Cockpit

Governed engineering pilot toward an EMS commercial-intelligence and negotiation system of record. The implemented vertical slice converts an authorized agreement source set into source-linked legal/operational objects, dependency and precedence proposals, baseline deterministic economics, governed negotiation positions, human-reviewed findings, approval decisions, explicitly generated snapshots, and append-only audit events.

The completion contract and target product are defined in [`ARCHITECTURE.md`](ARCHITECTURE.md). The finished platform is a private, human-authorized system with a portable enterprise-controlled source/evidence/negotiation ledger and replaceable hosting, storage, OCR, model, workflow and signing adapters. The current application is not that complete platform yet.

> **Readiness boundary:** a feature-complete or code-complete release candidate is not a production-activated legal system. Confidential use still depends on approved private infrastructure, production identity and data-handling controls, migration and recovery verification, current-model legal validation, approved company standards, live end-to-end acceptance testing, and formal owner approval. This repository and its documentation do not themselves attest that those external gates have passed.

> **Repository boundary:** this GitHub repository is currently public. Keep it code/synthetic-data only. Do not commit confidential contracts, company negotiation standards, credentials, customer data, privileged analysis, or internal production configuration. Move production development to an approved private repository before adding proprietary content.

## Product surfaces

- `/` — persistent database-backed executive portfolio cockpit when configured and authenticated; synthetic data only in explicit demo mode.
- `/matters/:id` — counsel matter workspace: source set, secure upload, records governance, durable processing, atomic contract twin, precedence, findings, economics, decisions, agreement versions, snapshots, and audit.
- `/matters/:id/executive-summary` — frozen print-ready executive decision brief; only receipt-verified snapshots are state-hash-bound reliance evidence, while legacy receipt-less rows remain non-reliance history.
- `/admin` — legal engineering control plane: readiness, frozen validation, negotiation standards, user roles, and controlled source-purge administration.

## Architecture

### Application and identity

- Next.js 16 / React 19 / TypeScript.
- Better Auth using Microsoft Entra ID as the production identity provider.
- PostgreSQL-backed Better Auth schema plus ContractTwin application schema.
- Server-enforced `VIEWER`, `LAWYER`, `APPROVER`, and `ADMIN` roles.
- Restricted matters require explicit matter membership for ordinary users. The current Admin bypass is a known pilot limitation; production privileged-content access requires explicit content authority and audited, time-bound break-glass rather than technical role inheritance.
- One-time first-Admin bootstrap is restricted to `BOOTSTRAP_ADMIN_EMAIL`, only when zero active Admins exist, and must be removed after use.

### Source documents and evidence chain

- Private Vercel Blob object storage.
- New uploads are registered with malware status `PENDING`; source retrieval and parsing are blocked until the governed pipeline receives a `CLEAN` result from the configured ClamAV service.
- A detection changes the source to `QUARANTINED` and stops the pipeline. Scanner or transport failures change it to `FAILED`; neither state is treated as clean.
- SHA-256 is computed in the browser before upload and independently recomputed server-side before extraction.
- Source blobs are never rewritten by analysis.
- PDF text extraction preserves page boundaries where the text layer is machine-readable, but does not yet prove layout/table/signature completeness.
- DOCX and TXT are normalized into hashed source chunks; the current DOCX path does not preserve tracked changes, comments, footnotes, headers or full table semantics.
- Scanned PDFs and XLSX/Office inputs can be delegated to Azure Document Intelligence Layout, but the current publisher flattens provider layout output and is not legal-grade structure preservation.
- Binary-purged source objects return HTTP 410. Extracted text, source excerpts and derived records currently remain in PostgreSQL under their separate records lifecycle; do not describe binary purge as complete content destruction.

### Durable processing

Vercel Workflow DevKit persists long-running contract processing across function timeouts and deployments. A full document pipeline performs:

1. malware scanning and quarantine enforcement;
2. independent source-integrity verification;
3. text/layout extraction or asynchronous OCR;
4. source-grounded clause-risk analysis;
5. atomic contract-term extraction;
6. term-dependency graph analysis; and
7. matter-wide document precedence/lineage analysis.

Each stage has database idempotency keys, retry state, and durable continuation. External OCR polling does not consume failure retries merely because the external service is still processing. Worker lease fencing and failed-child retry behavior are release-blocking controls and must pass their dedicated database/concurrency acceptance suite.

`JOB_LEASE_SECONDS` controls the durable worker lease (default 900 seconds; accepted range 60–3600). Heartbeats run at one third of the lease duration, capped to 5–30 seconds. A timestamp alone cannot displace a worker: takeover also requires the processor advisory lock, advances a monotonic generation, and prevents the prior generation from publishing. Stale-lease recovery is separately gated by `JOB_LEASE_RECOVERY_ENABLED` and is **off unless set exactly to `true`**. Deploy the fencing-capable worker first, keep recovery off, drain and prove termination of every pre-fencing worker, and only then enable recovery in a separately approved change. Tune this only with measured provider latency and interruption tests.

The document pipeline deliberately does **not** generate an executive snapshot. The protocol-1 reliance contract requires an authorized user to lock the agreement version with one explicitly selected, validated, current-formula economics run. That `authoritative_economics_run_id` is immutable for the version; changing the relied-on scenario requires a new agreement version. An authorized user must then request a snapshot separately after completing human disposition of current source-derived objects and satisfying the source/run provenance checks. This prevents processing a document from silently freezing an incomplete executive state. Migration `013` deliberately preserves protocol-0 writes during an expand-safe mixed-bundle rollout; those rows are readable compatibility history but are non-reliance evidence and must not authorize production execution. Production remains source-gated until the old bundle is drained and a follow-on contract-enforcement phase retires that bridge.

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
- Source excerpts must be contained in supplied source text after the current case/whitespace normalization; unsupported output is discarded. Byte-exact quotation and full-package omission assurance are not yet established.
- The model identifies contract facts, legal/operational consequences, uncertainty, and potential financial variables.
- **The model does not invent company negotiation policy.** Primary position, fallback, no-go, and approval authority come from separately governed negotiation standards.
- If no approved standard exists, production output says it is missing; illustrative demo positions cannot masquerade as approved policy.

### Economics

Financial consequences are calculated by deterministic versioned software rather than model arithmetic. Current modeled categories include payment-term working capital, stranded inventory/NCNR, termination recovery, warranty reserve, liability-cap gap, gross profit, and modeled burden as a percentage of gross profit. Under evidence protocol 1, locking a governed agreement version requires explicitly selecting one exact validated run that uses the single active current formula and belongs to that same matter/version. That authoritative selection cannot be replaced on the version; a different relied-on scenario requires a new agreement version. Approved decisions, execution gates, and reliance-capable snapshots must bind that same authoritative run. Protocol-0 legacy rows are historical, non-reliance evidence only.

### Human authority

AI analysis, lawyer validation, approved company standards, and executive authority remain separate states. The pilot derives a coarse required application role from the decision type and linked finding; this is not the target delegated, multi-function authority matrix. A requester cannot disposition their own decision. Agreement-version approval/execution, hold release, and snapshot generation require explicit authorized human actions. ContractTwin does not autonomously approve terms, modify source agreements, send redlines, generate an executive snapshot, or make binding commitments.

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
- every current pilot EMS clause family has a complete, governed, non-illustrative active standard with provenance and approval-role metadata.

In addition, the current code intentionally reports `evidenceKernelReady=false` while seven known implemented-capability gaps remain: structure-preserving/full-package coverage, representative validation for every relied-on stage, authentic execution certification, finance evidence/assumption lineage plus a delegated multi-function authority matrix, source-scoped provider-processing authorization manifests, governed validation of the approved 41-section EMS taxonomy/financial-risk methods/Top-10 cascades, and completion of the mixed-bundle decision/economics/snapshot evidence rollout's drain and contract-enforcement phase. As a result, legal-reliance operations fail closed even if the configuration and synthetic clause-risk gates above pass.

Current validation thresholds are 95%+ expected-family recall, 100% grounding, zero unsafe prohibited conclusions, zero normalized source-containment failures, zero rejected ungrounded findings, and all expected cases passing with no missing, duplicate, or unexpected cases. The compatibility database field remains named `exact_quote_failure_count`, but this test normalizes case and whitespace and does not establish byte-exact quotation fidelity. The frozen corpus contains synthetic cases only and is versioned independently of production source data. Production acceptance additionally requires the approved 41-section EMS key-term taxonomy, financial-risk identifiers and dollar-impact methods, and the Top-10 cross-clause cascade families to be loaded and validated as governed data.

## Records governance

Matters support confidentiality and privilege classification, legal holds, retention category/date, and hold history. Destruction is intentionally separate from ordinary application deletion:

1. an authorized legal editor creates a purge request with a records-management reason;
2. an Admin may reject it, while approval requires an Admin different from the requester;
3. execution remains disabled unless `ALLOW_SOURCE_PURGE=true`;
4. execution is blocked by any matter/document legal hold;
5. execution is blocked until a retention end date exists and has expired; and
6. execution first records a durable `PENDING_PURGE` marker, then deletes the private Blob, and finally records the **binary** source as `PURGED` in a separate database transaction; and
7. retries remain constrained by the same hold/retention/approval checks, while the document tombstone, audit history, extracted text and derived legal records remain until a separately approved derivative-content policy is implemented.

Retention periods are not invented by the application and must come from the approved corporate records policy.

## Database setup

```bash
npm run db:migrate
```

This command first applies ContractTwin migrations transactionally with migration SHA-256 checksums and a PostgreSQL advisory lock, then uses Better Auth's programmatic migration API for its installed-version auth schema. That order makes first bootstrap retryable: an application-migration failure rolls back to the pristine target, while an independently failed auth phase can be retried against the already verified ContractTwin receipt history. ContractTwin migration files are decoded as strict UTF-8, rejected if they contain a byte-order mark or NUL, and canonicalized to LF before both hashing and PostgreSQL execution. The manifest and any existing database receipts must match before a ContractTwin schema mutation begins, so Windows CRLF and Linux LF checkouts produce the same executed text and receipt without weakening history checks. An applied migration that later changes is refused; schema changes require a new migration. The current application requires every migration through `014_release_database_external_identity.sql`: source/quarantine and run lineage (`006`), agreement-version-scoped lifecycle and graph controls (`007`), exact engine policies, extraction-generation ownership, immutable review attestations, graph provenance and counsel-capability controls (`008`), authorized executive-snapshot generator/terminal receipts (`009`), immutable physical database identity plus append-only per-release target receipts and pinned trigger-function search paths (`010`), counsel-authorized legal dispositions and durable decision rationale (`011`), monotonic worker leases with heartbeat/expiry evidence (`012`), an expand-safe protocol-1 decision/economics evidence path with immutable agreement-version authoritative-economics selection while protocol 0 remains available only for mixed-bundle compatibility (`013`), and the immutable mapping from the externally approved logical database identity to the preserved physical identity (`014`).

CI also applies all migrations to a disposable PostgreSQL 17 instance, reruns them for idempotency, and proves key database invariants including legal-hold purge blocking, append-only audit history, one active standard per clause family, immutable run/receipt evidence, protocol-1 authoritative-economics selection, exact agreement-version execution prerequisites and cross-matter lineage rejection. Protocol-0 is an expand-only compatibility bridge, not reliance evidence; production remains blocked until the mixed-bundle drain and contract-enforcement acceptance phase removes it.

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

Production schema changes use a separate `MIGRATION_DATABASE_URL`, configured **only** as a secret on the protected GitHub `contracttwin-production` environment. The production workflow exposes it only to the migration/schema-gate step. Do not configure it in Vercel, include it in `.env` files, copy it into the pulled production environment file, or make it available to application builds/functions/workers.

An empty production database is never auto-accepted by a normal release. First run the separate, manually approved `ContractTwin Production Target Bootstrap` workflow from current `main`. Its distinct `contracttwin-production-bootstrap` environment holds a single-use bootstrap credential and the externally approved random target token, database UUID, and normalized endpoint hash. The workflow proves all three credentials reach the approved pristine target, creates only a separately owned, read-only `contracttwin_control.production_target_binding` marker, verifies the migrator/runtime ACLs, and stops without application/auth migrations or deployment. Remove or revoke the bootstrap credential after approval.

Every normal production release must match that external token hash, database UUID, and endpoint descriptor before any mutation. It then opens both routine credentials at once, requires distinct principals and matching live database evidence, and uses two unpredictable transaction-scoped advisory-lock challenges to prove they currently reach the same anchored writable PostgreSQL database. The holder transactions remain open during schema work, and each actual mutator must re-prove both held locks plus the live fingerprint in its own transaction. If routing changes later, the affected transaction fails before changing the unproved target; an earlier correctly proved migration phase may already have committed. The first application migration additionally requires the anchor to be the only permitted user object. The gate then uses Vercel's pulled `DATABASE_URL` independently to prove that the least-privilege runtime role can use required live controls but cannot perform DDL, mutate migration history, or alter the anchor.

This database-resident anchor is intentionally scoped to an approved **logical endpoint and database identity**. It detects crossed credentials, an unexpected endpoint, and a mismatched marker; it cannot distinguish an in-place restore or copied database routed behind the same approved endpoint because the marker is copied with the database. Production activation therefore also requires provider/control-plane change approval and a documented restore procedure. An organization that needs cryptographic restore-incarnation detection must add an external, non-database resource attestation and monotonic release/restore ledger before relying on that property.

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
- `EXPECTED_PRODUCTION_TARGET_TOKEN` (random 256-bit target secret; never Vercel)
- `EXPECTED_PRODUCTION_DATABASE_ID` (externally approved logical UUID mapped to migration `010`'s preserved physical database identity by migration `014`)
- `EXPECTED_PRODUCTION_RUNTIME_DATABASE_ENDPOINT_SHA256` (hash of the normalized approved runtime host, port, and database name)
- `EXPECTED_PRODUCTION_MIGRATION_DATABASE_ENDPOINT_SHA256` (hash of the normalized approved migrator host, port, and database name)

The separate `contracttwin-production-bootstrap` environment also contains `PRODUCTION_DATABASE_BOOTSTRAP_URL`, `EXPECTED_PRODUCTION_BOOTSTRAP_DATABASE_ENDPOINT_SHA256`, the same protected target material and migration credential, and the Vercel credentials needed to read the actual production runtime URL. Role-specific endpoint hashes allow approved pooler and direct endpoints to differ while still binding each credential. The bootstrap credential must not exist in the routine release environment or Vercel. The Vercel production runtime environment separately contains application variables from `.env.example`, including `DATABASE_URL`, `RELEASE_ATTESTATION_TOKEN`, and `VERCEL_AUTOMATION_BYPASS_SECRET`. Every bootstrap/migration/target-anchor secret listed above must be absent from Vercel.

Vercel project root directory must be `commercial-legal-cockpit`.

## Production activation sequence

1. Move/replicate the application into an approved **private** GitHub repository.
2. Provision production PostgreSQL, private Blob storage, Microsoft Entra app registration, a private ClamAV service reachable from the runtime, Azure Document Intelligence, approved OpenAI credentials, and a Vercel project.
3. Configure Vercel runtime variables and deployment protection, including `AUTH_REQUIRED=true`, `ALLOW_DEMO_ACCESS=false`, and the least-privilege runtime `DATABASE_URL`.
4. Create and independently approve the target token, database UUID, and normalized endpoint hash. Configure the dedicated bootstrap environment and run `ContractTwin Production Target Bootstrap` once; verify that it creates only the external marker and stops. Revoke the bootstrap credential.
5. Configure the same protected target material plus `MIGRATION_DATABASE_URL` on `contracttwin-production`, then use the approval-gated release workflow to prove the routine credentials reach that exact anchored target, migrate it, and verify its immutable identity and exact release receipt. Never copy protected database/anchor credentials into Vercel or an application/runtime environment file.
6. Sign in with the configured bootstrap identity and perform the one-time Admin bootstrap; then remove `BOOTSTRAP_ADMIN_EMAIL`.
7. Configure user roles and restricted-matter membership rules.
8. Load formally approved negotiation standards; new standards are inactive until separately activated by Admin.
9. Run the frozen legal validation suite against the exact configured production model/prompt/corpus/gate and independently review the results.
10. In the target environment, verify every migration through `014`, exact ordered migration receipts, the immutable external-logical-to-physical database identity mapping and per-release target binding, scanner connectivity and clean/quarantine behavior, hash mismatch failure, exact OCR-generation ownership, authorization isolation, fenced worker takeover/publication and durable retries, counsel-authorized object dispositions, persisted decision rationale, per-run counsel receipts (including valid zero-output runs), version-scoped graph provenance, explicit approvals, immutable protocol-1 authoritative-economics selection, authorized snapshot job/terminal receipts and state hashes, purge recovery, and backup restoration using synthetic test sources. Keep stale-lease recovery off during the fencing deployment; drain and prove termination of all pre-fencing workers before enabling it in a separate approved step. Separately drain every pre-protocol-1 application/worker bundle, prove decision/economics/snapshot contract enforcement, and retire protocol-0 writes before treating any resulting state as reliance evidence.
11. Complete security/privacy/privilege/records-management review, penetration/risk testing, monitoring setup, and named-owner acceptance.
12. Only after the readiness API is green **and** the live acceptance evidence is approved should `LEGAL_RELIANCE_ENABLED=true` be considered.
13. Keep `ALLOW_SOURCE_PURGE=false` unless records-management leadership separately authorizes purge operations and a recovery-tested runbook is in place.

See `PRODUCTION_READINESS.md` for the acceptance checklist.
