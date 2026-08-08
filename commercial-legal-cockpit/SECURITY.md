# ContractTwin Security and Legal-Engineering Boundary

## Scope

This document applies to the `commercial-legal-cockpit` application. The code in this repository is suitable for synthetic/demo development and production deployment **only after** the external controls described below are configured and approved.

The current GitHub repository is public. Never commit contracts, customer data, privileged analysis, company negotiation standards, credentials, tenant identifiers, production URLs, retention schedules, or other proprietary configuration.

## Security properties the system is designed to preserve

1. **Source integrity.** Original agreement files are private objects. Client and server SHA-256 fingerprints must agree before extraction. Analysis does not rewrite source files.
2. **Source grounding.** AI findings and normalized terms require verbatim source text. Ungrounded findings are discarded rather than repaired by inference.
3. **Human authority.** AI findings, lawyer validation, company standards, and executive approvals are distinct states. AI cannot approve terms or make commitments.
4. **Matter isolation.** Restricted matters require explicit membership. Application roles do not grant broad access to restricted matters except Admin.
5. **Least authority.** VIEWER, LAWYER, APPROVER and ADMIN are server-enforced. The first Admin has a single-use environment-gated bootstrap path.
6. **Policy provenance.** Negotiation positions come only from separately governed standards. New standards are inactive until explicit Admin activation.
7. **Deterministic economics.** Contract economics are versioned software calculations using explicit user inputs, not language-model arithmetic.
8. **Audit immutability.** Audit events are append-only at the PostgreSQL layer; updates/deletes are rejected by a database trigger.
9. **Records governance.** Legal holds, privilege/confidentiality classifications and retention dates are first-class application data. Source purge is a two-person process and separately disabled by default.
10. **Fail-closed reliance.** `LEGAL_RELIANCE_ENABLED=true` cannot override missing infrastructure, failed current-model validation, or missing approved standards.

## Trust boundaries

### Browser

Untrusted for authorization and integrity decisions. The browser may compute a preliminary SHA-256 and render role-aware UI, but the server independently validates access and source integrity.

### Next.js application / Vercel Functions

Trusted application boundary for session validation, matter authorization, workflow submission, source delivery, policy lookup and persistence. Secrets must exist only in encrypted environment configuration.

### PostgreSQL

Authoritative state store for access, matters, graph objects, findings, decisions, standards, economics, processing state, validation evidence, records governance and audit history. Production credentials should use TLS and least privilege.

### Private Blob storage

Authoritative binary source store. Objects must be private. Retrieval occurs through authenticated application routes. Purged objects retain database tombstones and audit evidence.

### Microsoft Entra ID / Better Auth

Authentication provider and session layer. Authentication is not authorization; every protected operation still performs server-side role/matter checks.

### OpenAI

External inference boundary. Send only content approved for the configured enterprise/API environment. Model output is untrusted until schema validation, source verification and required human review complete.

### Azure Document Intelligence

External document-layout/OCR boundary for scanned PDFs and Office/spreadsheet layout extraction. Operation URLs are accepted only when they resolve to the configured trusted endpoint.

### Vercel Workflow

Durable processing boundary for extraction/OCR/analysis/graph/precedence/snapshot workflows. Database idempotency keys and processing states remain the source of truth for business-level work.

## Primary threats and controls

| Threat | Primary controls |
|---|---|
| Unauthorized contract access | Entra SSO, Better Auth session, server role checks, restricted-matter membership, private Blob |
| Cross-matter leakage | Matter IDs validated server-side; durable idempotency scoped by matter/document; source routes authorize matter |
| Hallucinated source citation | Strict structured output, exact-source containment verification, ungrounded-result rejection |
| AI invents negotiation policy | Standards engine separated from AI; missing approved policy reported as missing |
| Model output treated as approved | Findings/terms/edges start UNREVIEWED; separate lawyer and approver workflows |
| Duplicate analysis corrupts reviewed state | Finding reuse and DB graph-idempotency triggers preserve reviewed objects |
| Contract file tampering | Browser + server SHA-256 comparison; source chunk hashes; audit history |
| Audit manipulation | Database append-only trigger |
| Destruction during legal hold | Database purge trigger plus application hold checks |
| Unauthorized source destruction | Lawyer request + independent Admin approval + expired retention + no hold + `ALLOW_SOURCE_PURGE=true` |
| Abuse/cost exhaustion | PostgreSQL-backed authenticated rate limits for uploads, AI, pipelines, economics, validation and decision requests |
| Dependency drift | Committed npm lockfile, `npm ci`, dependency audit, CodeQL, pinned major application versions |
| Stale model validation | Readiness matches validation evidence to current model + current prompt + current frozen corpus |
| Silent long-job failure | Durable workflow state, retries, WAITING_EXTERNAL state and job/audit visibility |

## Explicit prohibited autonomous actions

ContractTwin must not autonomously:

- accept or approve contract terms;
- send a customer redline, email, notice or negotiation response;
- modify an original source agreement;
- activate a company negotiation standard;
- approve its own purge request;
- destroy a source object without the separate purge gate;
- mark an agreement executed without authorized human action;
- convert AI output into a binding commitment.

## External production requirements

Code completion does not create an approved production environment. Before real confidential work, the operator must separately provide and approve:

- a private production source repository;
- production PostgreSQL and backup/recovery policy;
- Microsoft Entra app registration and conditional-access/MFA requirements;
- private Vercel Blob store;
- approved OpenAI API/enterprise configuration and data-handling assessment;
- Azure Document Intelligence resource and data-handling assessment;
- Vercel project/environment, deployment protection and production secrets;
- company-approved negotiation standards and authority matrix;
- company-approved records retention categories and dates;
- security/privacy/privilege review and penetration testing;
- incident response and access-review process.

## Reporting a security issue

Do not place confidential vulnerability details in a public GitHub issue. Use the organization's approved private security-reporting channel for the production deployment.
