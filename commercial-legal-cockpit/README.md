# EMS Commercial Legal Cockpit

Production-oriented Next.js application for source-grounded EMS contract review, commercial risk triage, deterministic contract economics, negotiation governance, and executive decision support.

## Current architecture

- **UI:** Next.js 16 / React 19 / TypeScript.
- **Identity:** Better Auth with Microsoft Entra ID.
- **Authorization:** server-side roles plus matter ownership/membership; restricted matters require explicit access.
- **Legal state:** PostgreSQL.
- **Source documents:** private Vercel Blob storage.
- **Integrity:** client SHA-256 captured before upload and recomputed server-side before extraction.
- **Extraction:** page-preserving PDF text via `unpdf`, raw DOCX text via `mammoth`, and TXT extraction. Scanned/oversized documents fail to an explicit OCR/worker state rather than being silently truncated.
- **Analysis:** OpenAI Responses API structured output or deterministic demo triage. Model-generated source excerpts are verified against supplied source text before findings are persisted.
- **Negotiation policy:** separate approved standards table. The model does not create company primary/fallback/no-go positions or approval authority.
- **Financial logic:** deterministic, versioned contract-economics functions.
- **Human review:** AI findings are `UNREVIEWED` until a lawyer validates/rejects them; decisions remain separate approval records.
- **Audit:** append-only database event history.

## Modes

### Demo / preview

`AUTH_REQUIRED=false` and `ALLOW_DEMO_ACCESS=true` keeps the product usable with synthetic data. Real private document workflows remain disabled unless PostgreSQL, identity and Blob are configured.

### Production

Set `AUTH_REQUIRED=true` and configure the complete environment. Production authentication fails closed if required SSO configuration is missing.

`LEGAL_RELIANCE_ENABLED=false` must remain the default during validation. When switched to `true`, structured AI failure does **not** fall back to keyword rules.

## Environment

Copy `.env.example` and configure approved secrets outside source control.

Required for production legal work:

- `DATABASE_URL`
- `BETTER_AUTH_SECRET`
- `BETTER_AUTH_URL`
- `MICROSOFT_CLIENT_ID`
- `MICROSOFT_CLIENT_SECRET`
- `MICROSOFT_TENANT_ID`
- `BLOB_READ_WRITE_TOKEN`
- `OPENAI_API_KEY`
- `OPENAI_MODEL`

## Database setup

1. Create an approved PostgreSQL database.
2. Configure Better Auth's PostgreSQL tables using the Better Auth CLI or its approved migration workflow.
3. Apply `db/migrations/001_app.sql` for ContractTwin application tables.
4. Run `npm run db:check`.
5. Create initial `app_user_roles` records for authorized users.
6. Do **not** activate illustrative standards in `db/seeds/illustrative-standards.sql` as company policy. They are deliberately inserted inactive.

## Core APIs

- `GET /api/health` — uptime only; no configuration details.
- `GET /api/readiness` — authenticated control/readiness status.
- `GET|POST /api/matters` — authorization-scoped matter register.
- `GET /api/matters/:id/documents` — source register.
- `POST /api/documents/upload` — authenticated client-upload token exchange.
- `POST /api/documents/:id/extract` — server hash verification + extraction/chunking.
- `POST /api/documents/:id/analyze` — source-chunk analysis with page/chunk provenance.
- `GET /api/documents/:id/content` — authenticated private source streaming.
- `POST /api/analyze` — manual text issue spotting.
- `PATCH /api/findings/:id/review` — lawyer validation/rejection.
- `POST /api/economics` — deterministic scenario engine; persists runs when matter-scoped.
- `GET|POST /api/decisions` and `PATCH /api/decisions/:id` — request vs. authorized disposition.
- `GET|POST /api/standards` and `PATCH /api/standards/:id/activate` — controlled negotiation standards.
- `GET /api/audit?matterId=...` — append-only matter history.

## Vercel

Use this repository with project Root Directory:

`commercial-legal-cockpit`

Recommended deployment model:

- feature branch -> Preview
- `main` -> Production
- private Blob store
- Marketplace PostgreSQL integration
- encrypted environment variables

## Validation gates before real legal reliance

See `PRODUCTION_READINESS.md` and `validation/frozen-ems-regression.json`. The application is not considered approved for privileged/confidential production use until identity, matter authorization, source retention, security, privacy, privilege, records management, AI validation, economics validation, recovery testing, and approval-matrix governance are formally accepted.
