# ContractTwin Security and Legal-Engineering Boundary

## Scope

This document applies to the `commercial-legal-cockpit` application. The code in this repository is suitable for synthetic/demo development and production deployment **only after** the external controls described below are configured and approved.

The current GitHub repository is public. Never commit contracts, customer data, privileged analysis, company negotiation standards, credentials, tenant identifiers, production URLs, retention schedules, malware samples, or other proprietary configuration.

The implemented source code is an engineering control set, not evidence that a production environment has been activated or accredited. Controls that depend on external services must be verified in the exact target environment before confidential use.

## Security properties the system is designed to preserve

1. **Source quarantine and integrity.** Original agreement files are private objects. Every upload starts `PENDING`; retrieval and parsing require a `CLEAN` ClamAV result. Client and server SHA-256 fingerprints must then agree before extracted source is marked verified. Analysis does not rewrite source files.
2. **Source grounding.** AI findings and normalized terms require verbatim source text. Ungrounded findings are discarded rather than repaired by inference.
3. **Human authority.** AI findings, lawyer validation, company standards, and executive approvals are distinct states. AI cannot approve terms or make commitments.
4. **Matter and demo isolation.** Restricted matters require explicit membership. Application roles do not grant broad access to restricted matters except Admin. Demo principals are Viewer-only and cannot use persistent matter, source, analysis, economics, decision, standard, or snapshot operations.
5. **Least authority.** VIEWER, LAWYER, APPROVER and ADMIN are server-enforced. The first Admin has a single-use environment-gated bootstrap path. The production application database identity is distinct from the privileged migrator and is denied schema-changing and migration-history authority.
6. **Policy provenance.** Negotiation positions come only from separately governed standards. New standards are inactive until explicit Admin activation.
7. **Deterministic economics.** Contract economics are versioned software calculations using explicit user inputs, not language-model arithmetic.
8. **Audit immutability.** Audit events are append-only at the PostgreSQL layer; updates/deletes are rejected by a database trigger.
9. **Records governance.** Legal holds, privilege/confidentiality classifications and retention dates are first-class application data. Source purge is a two-person process, uses a durable pending marker around external deletion, and is separately disabled by default.
10. **Explicit freeze, receipt and authority.** Document processing does not create an executive snapshot. Snapshot generation, agreement status changes, decision dispositions, and hold releases require separate authorized human actions; a decision requester cannot approve their own request. A reliance-capable snapshot must have an immutable successful generator receipt binding the authorized requester and exact version/economics/reliance/state preimage; receipt-less legacy rows are displayed only as non-reliance evidence.
11. **Fail-closed reliance.** `LEGAL_RELIANCE_ENABLED=true` cannot override missing infrastructure (including the malware scanner), failed exact current-model validation, or incomplete/illustrative standards.

## Trust boundaries

### Browser

Untrusted for authorization and integrity decisions. The browser may compute a preliminary SHA-256 and render role-aware UI, but the server independently validates access and source integrity.

### Next.js application / Vercel Functions

Trusted application boundary for session validation, matter authorization, workflow submission, source delivery, policy lookup and persistence. Secrets must exist only in encrypted environment configuration.

### PostgreSQL

Authoritative state store for access, matters, graph objects, findings, decisions, standards, economics, processing state, validation evidence, records governance and audit history. Production uses two certificate-verifying TLS identities whose URLs specify `sslmode=verify-full`; the release gate also verifies live encrypted sessions. Vercel `DATABASE_URL` is the least-privilege application runtime identity and must not perform DDL or mutate migration history; `MIGRATION_DATABASE_URL` is the privileged migrator, stored only as a protected GitHub `contracttwin-production` environment secret and exposed only to the production schema-gate step. The migrator must never be configured in Vercel or written into application/runtime environment files. The runtime identity necessarily retains approved business-data DML privileges; separating identities prevents schema-control bypass but does not make runtime credential compromise harmless. Suspected runtime credential exposure remains a security incident requiring immediate revocation, evidence preservation and review of all affected legal state.

### Private Blob storage

Authoritative binary source store. Objects must be private. Retrieval occurs through authenticated application routes. Purged objects retain database tombstones and audit evidence.

### ClamAV service

External file-security boundary reached by the runtime through the ClamAV INSTREAM protocol. The current integration opens raw TCP and does not add TLS or application-level scanner authentication, so the endpoint must not be exposed to a public or untrusted network; use an approved private network path and restrictive network policy. The scanner must be monitored, patched, configured with current signatures, and sized to accept the application's 75 MiB maximum upload (or the application limit must be reduced). A scanner result is untrusted until parsed into an allowed state; an unrecognized response or transport failure never produces `CLEAN`.

### Microsoft Entra ID / Better Auth

Authentication provider and session layer. Authentication is not authorization; every protected operation still performs server-side role/matter checks.

### OpenAI

External inference boundary. Send only content approved for the configured enterprise/API environment. Model output is untrusted until schema validation, source verification and required human review complete.

### Azure Document Intelligence

External document-layout/OCR boundary for scanned PDFs and Office/spreadsheet layout extraction. Operation URLs are accepted only when they resolve to the configured trusted endpoint.

### Vercel Workflow

Durable processing boundary for malware scanning, extraction/OCR, analysis, graph, precedence, and separately requested snapshot work. Database idempotency keys and processing states remain the source of truth for business-level work. The full document pipeline ends after precedence analysis and never auto-freezes a snapshot.

## Primary threats and controls

| Threat | Primary controls |
|---|---|
| Unauthorized contract access | Entra SSO, Better Auth session, server role checks, restricted-matter membership, private Blob |
| Malicious or unscanned upload reaches a parser/user | Upload defaults to `PENDING`; ClamAV scan precedes extraction; retrieval/extraction require `CLEAN`; detection becomes `QUARANTINED`; database trigger blocks unscanned extraction state |
| Cross-matter leakage | Matter IDs validated server-side; durable idempotency scoped by matter/document; source routes authorize matter |
| Demo data crosses into persistent legal state | Viewer-only demo principal, persistence-disabled endpoints, sanitized readiness, synthetic demo responses only |
| Hallucinated source citation | Strict structured output, exact-source containment verification, ungrounded-result rejection |
| AI invents negotiation policy | Standards engine separated from AI; missing approved policy reported as missing |
| Model output treated as approved | Findings/terms/edges start UNREVIEWED; validation/rejection requires reviewer, timestamp and substantive note; separate lawyer and approver workflows |
| Duplicate analysis corrupts reviewed state | Finding reuse and DB graph-idempotency triggers preserve reviewed objects |
| Contract file tampering | Browser + server SHA-256 comparison; source chunk hashes; audit history |
| Audit manipulation | Database append-only trigger |
| Runtime compromise obtains schema-owner authority | Separate database identities; runtime role denied DDL/migration-history writes; migrator secret scoped to the protected production schema-gate step and absent from Vercel/build/function/worker environments |
| Destruction during legal hold | Database purge trigger plus application hold checks |
| Unauthorized source destruction | Authorized legal-editor request + independent Admin approval + expired retention + no hold + `ALLOW_SOURCE_PURGE=true` |
| Abuse/cost exhaustion | PostgreSQL-backed authenticated rate limits for uploads, AI, pipelines, economics, validation and decision requests |
| Dependency drift | Committed npm lockfile, `npm ci`, dependency audit, CodeQL, pinned major application versions |
| Stale or partial model validation | Readiness matches evidence to the current model, prompt, frozen corpus and gate; requires the exact case set, all cases passing, and zero rejected ungrounded results |
| Silent long-job failure | Durable workflow state, retries, WAITING_EXTERNAL state and job/audit visibility |
| Incomplete or directly inserted state silently frozen for executives | No automatic snapshot; explicit Approver action; approved/executed source set, clean verified documents, current successful and counsel-attested runs, validated current-formula economics and an exact successful generator receipt are required; the receipt binds canonical source-state and reliance hashes |

## Explicit prohibited autonomous actions

ContractTwin must not autonomously:

- accept or approve contract terms;
- send a customer redline, email, notice or negotiation response;
- modify an original source agreement;
- activate a company negotiation standard;
- approve its own purge request;
- disposition its own decision request;
- destroy a source object without the separate purge gate;
- mark an agreement executed without authorized human action;
- generate an executive snapshot as a side effect of document processing;
- convert AI output into a binding commitment.

## External production requirements

Code completion does not create an approved production environment. Before real confidential work, the operator must separately provide and approve:

- a private production source repository;
- production PostgreSQL with separate runtime/migrator roles, runtime least-privilege tests, and backup/recovery policy;
- Microsoft Entra app registration and conditional-access/MFA requirements;
- private Vercel Blob store;
- private, monitored ClamAV service reachable from the application runtime;
- approved OpenAI API/enterprise configuration and data-handling assessment;
- Azure Document Intelligence resource and data-handling assessment;
- Vercel project/environment, deployment protection and production secrets;
- company-approved negotiation standards and authority matrix;
- company-approved records retention categories and dates;
- security/privacy/privilege review and penetration testing;
- incident response and access-review process.

Before production activation, live acceptance testing in the target environment must verify at least: Entra login and role/matter isolation; demo persistence denial; private Blob upload/retrieval; `PENDING` to `CLEAN`, `QUARANTINED`, and scanner-failure behavior; SHA-256 mismatch failure; OCR and durable retry behavior; independent approvals; snapshot preconditions, generator receipt and reproducible state binding; live critical-database-control drift detection; legal-hold/purge recovery; audit immutability; and database backup restoration. Use approved synthetic security fixtures and test contracts; do not place test malware or confidential sources in this public repository.

Every migration through `010_release_target_binding.sql` is required for these controls. Operators must apply them through `npm run db:migrate`, verify the exact ordered filename/SHA-256 manifest, and prove required live triggers/functions/constraints/indexes in a disposable or staging PostgreSQL instance before applying approved production change procedures. Manifest v2 receipts bind the strict-UTF-8, canonical-LF text that PostgreSQL executes; invalid encoding and legacy raw-line-ending receipts fail closed before any ContractTwin schema mutation. Migration `010` adds immutable per-database identity, append-only per-release source/nonce receipts, and fixed `pg_catalog, public, pg_temp` function search paths. Production promotion additionally requires both database credentials to reach the same identity, the restricted runtime to read but not forge the exact receipt, and a non-cacheable staged health proof without disclosing the nonce or database identity. Migration receipts alone do not prove that those controls remain present and enabled.

## Reporting a security issue

Do not place confidential vulnerability details in a public GitHub issue. Use the organization's approved private security-reporting channel for the production deployment.
