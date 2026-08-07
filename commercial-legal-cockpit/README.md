# ContractTwin / EMS Commercial Legal Cockpit

Production-oriented legal engineering application that treats EMS contracts as commercial-operational systems. It converts an authorized agreement source set into source-grounded legal/operational objects, dependency and precedence graphs, deterministic economics, governed negotiation positions, human-reviewed findings, approval decisions, frozen executive snapshots, and an immutable audit record.

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
- SHA-256 is computed in the browser before upload and independently recomputed server-side before extraction.
- Source blobs are never rewritten by analysis.
- PDF text extraction preserves page provenance where machine-readable.
- DOCX and TXT are normalized into hashed source chunks.
- Scanned PDFs and XLSX/Office layout extraction are delegated to Azure Document Intelligence Layout; polling is durable and source provenance is retained.
- Purged source objects return HTTP 410 while database tombstone/audit metadata remains.

### Durable processing

Vercel Workflow DevKit persists long-running contract processing across function timeouts and deployments. A full document pipeline performs:

1. source integrity verification;
2. text/layout extraction or asynchronous OCR;
3. source-grounded clause-risk analysis;
4. atomic contract-term extraction;
5. term-dependency graph analysis;
6. matter-wide document precedence/lineage analysis; and
7. frozen executive snapshot generation.

Each stage has database idempotency keys, retry state, and durable continuation. External OCR polling does not consume failure retries merely because the external service is still processing.

### ContractTwin graph

PostgreSQL stores first-class objects for:

- agreement package versions and their document membership;
- document relationships (`AMENDS`, `SUPERSEDES`, `CONTROLS`, `CONFLICTS_WITH`, etc.);
- atomic contract terms (`OBLIGATION`, `RIGHT`, `CONDITION`, `REMEDY`, `ALLOCATION`, etc.);
- term dependencies (`TRIGGERS`, `LIMITS`, `PRICES`, `ALLOCATES_RISK`, etc.);
- findings, economics, decisions, processing jobs, analysis-run provenance, validation evidence, and executive snapshots.

AI-generated graph objects remain `UNREVIEWED` until counsel validates or rejects them. Counsel may directly record a validated document relationship with a stated legal rationale.

### AI boundary

- OpenAI Responses API uses strict structured outputs.
- Source excerpts must be verbatim contiguous text present in the supplied source; ungrounded model output is discarded.
- The model identifies contract facts, legal/operational consequences, uncertainty, and potential financial variables.
- **The model does not invent company negotiation policy.** Primary position, fallback, no-go, and approval authority come from separately governed negotiation standards.
- If no approved standard exists, production output says it is missing; illustrative demo positions cannot masquerade as approved policy.

### Economics

Financial consequences are calculated by deterministic versioned software rather than model arithmetic. Current modeled categories include payment-term working capital, stranded inventory/NCNR, termination recovery, warranty reserve, liability-cap gap, gross profit, and modeled burden as a percentage of gross profit.

### Human authority

AI analysis, lawyer validation, approved company standards, and executive authority remain separate states. ContractTwin does not autonomously approve terms, modify source agreements, send redlines, or make binding commitments.

## Legal-reliance gate

`LEGAL_RELIANCE_ENABLED=true` is **not** enough to make the application production-ready. When that switch is enabled, the runtime checks all of the following before the durable contract pipeline may start:

- production authentication is required and Microsoft Entra is configured;
- PostgreSQL is configured;
- private Blob storage is configured;
- OpenAI is configured;
- Azure Document Intelligence is configured;
- the latest validation run matches the **current model + current analysis prompt + current frozen corpus** and passes the required metrics; and
- all required EMS clause-family negotiation standards are active.

Current validation thresholds are 95%+ expected-family recall, 100% grounding, zero unsafe prohibited conclusions, and zero exact-quote failures. The frozen corpus contains synthetic cases only and is versioned independently of production source data.

## Records governance

Matters support confidentiality and privilege classification, legal holds, retention category/date, and hold history. Destruction is intentionally separate from ordinary application deletion:

1. lawyer creates a purge request with a records-management reason;
2. a different Admin approves or rejects it;
3. execution remains disabled unless `ALLOW_SOURCE_PURGE=true`;
4. execution is blocked by any matter/document legal hold;
5. execution is blocked until a retention end date exists and has expired; and
6. private Blob deletion occurs only after all gates pass, while the document tombstone and audit history remain.

Retention periods are not invented by the application and must come from the approved corporate records policy.

## Database setup

```bash
npm run db:migrate
```

This command first uses Better Auth's programmatic migration API for its installed-version auth schema, then applies ContractTwin migrations transactionally with migration SHA-256 checksums and a PostgreSQL advisory lock. An applied migration that later changes is refused; schema changes require a new migration.

CI also applies all migrations to a disposable PostgreSQL 17 instance, reruns them for idempotency, and proves key database invariants including legal-hold purge blocking, append-only audit history, and one active standard per clause family.

## Environment

Copy `.env.example`; never commit populated secrets. Production requires approved values for:

- `DATABASE_URL`
- `BETTER_AUTH_SECRET`
- `BETTER_AUTH_URL`
- `MICROSOFT_CLIENT_ID`
- `MICROSOFT_CLIENT_SECRET`
- `MICROSOFT_TENANT_ID`
- `BLOB_READ_WRITE_TOKEN`
- `OPENAI_API_KEY`
- `OPENAI_MODEL`
- `AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT`
- `AZURE_DOCUMENT_INTELLIGENCE_KEY`

One-time bootstrap: `BOOTSTRAP_ADMIN_EMAIL`.

Safety switches default off:

- `LEGAL_RELIANCE_ENABLED=false`
- `ALLOW_SOURCE_PURGE=false`

## CI and deployment

`.github/workflows/commercial-legal-cockpit.yml` performs:

- dependency installation;
- static schema-control check;
- Better Auth + ContractTwin migrations against PostgreSQL;
- migration idempotency check;
- database legal-control invariant tests;
- frozen corpus structure validation;
- deterministic economics tests;
- TypeScript typecheck;
- production dependency vulnerability audit; and
- full Next.js production build.

`.github/workflows/commercial-legal-cockpit-codeql.yml` provides independent JavaScript/TypeScript CodeQL analysis.

`.github/workflows/commercial-legal-cockpit-vercel.yml` contains a separate release preflight before Vercel preview/production deployment. It remains inert until these repository secrets are configured:

- `VERCEL_TOKEN`
- `VERCEL_ORG_ID`
- `VERCEL_PROJECT_ID`

Vercel project root directory must be `commercial-legal-cockpit`.

## Production activation sequence

1. Move/replicate the application into an approved **private** GitHub repository.
2. Provision production PostgreSQL, private Blob storage, Microsoft Entra app registration, Azure Document Intelligence, approved OpenAI credentials, and a Vercel project.
3. Configure environment variables/secrets and deployment protection.
4. Run `npm run db:migrate` against the approved database.
5. Sign in with the configured bootstrap identity and perform the one-time Admin bootstrap; then remove `BOOTSTRAP_ADMIN_EMAIL`.
6. Configure user roles and restricted-matter membership rules.
7. Load formally approved negotiation standards; new standards are inactive until separately activated by Admin.
8. Run the frozen legal validation suite against the configured production model/prompt/corpus and review failures.
9. Complete security/privacy/privilege/records-management review and recovery testing.
10. Only after the readiness API is green should `LEGAL_RELIANCE_ENABLED=true` be considered.
11. Keep `ALLOW_SOURCE_PURGE=false` unless records-management leadership separately authorizes purge operations.

See `PRODUCTION_READINESS.md` for the acceptance checklist.
