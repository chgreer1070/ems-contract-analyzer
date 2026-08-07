# EMS Commercial Legal Cockpit

GitHub + Vercel-ready Next.js application for executive commercial-contract decision support in an EMS / contract-manufacturing environment.

## Implemented

- Executive portfolio dashboard
- Matter register with browser-local persistence
- Contract intake metadata workflow
- Clause risk triage with deterministic rules
- Optional OpenAI Responses API analysis with strict Structured Outputs
- Source-excerpt verification before AI findings are returned
- Deterministic contract-economics API
- Negotiation / escalation queue
- Responsive executive UI
- Health endpoint for deployment checks

## Important boundary

This is an MVP application shell using synthetic data and browser-local matter persistence. Do not use confidential or privileged agreements until authentication, encrypted document storage, a database, matter-level authorization, audit logging, retention controls, and enterprise security review are configured.

## Vercel deployment

Use `commercial-legal-cockpit` as the Vercel project Root Directory. Track `main` as production after the build is approved; feature branches receive preview deployments.

Optional environment variables:

```text
OPENAI_API_KEY=...
OPENAI_MODEL=gpt-5
```

Never commit API keys to GitHub.

## API endpoints

- `GET /api/health`
- `POST /api/economics`
- `POST /api/analyze`

## Production hardening next

1. SSO/MFA.
2. PostgreSQL-backed customers, matters, findings, approvals and audit events.
3. Private encrypted object storage for original agreements.
4. PDF/DOCX extraction and document versioning.
5. Matter-level authorization.
6. Approved negotiation standards and approval matrix.
7. Immutable audit history and model/prompt version tracking.
8. Security, privacy, privilege and records-management review.
9. Frozen validation corpus before legal reliance.
