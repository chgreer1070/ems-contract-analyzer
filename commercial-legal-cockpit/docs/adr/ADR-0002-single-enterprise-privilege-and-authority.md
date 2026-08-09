# ADR-0002: Single-enterprise isolation and capability-based authority

- Status: Accepted target architecture; partial pilot enforcement in migrations `008` and `011`; full privilege/capability migration pending
- Date: 2026-08-08
- Scope: Tenancy, privileged-content access and professional authority

## Context

The current schema has global customers, matters and user roles without an organization identifier or PostgreSQL row-level security. Application authorization scopes opaque resources to their matter, but rank-ordered roles conflate legal, approval and technical-administration functions. In particular, the current Admin role can bypass restricted-matter membership, and Approver/Admin rank can inherit legal edit behavior.

That is incompatible with a shared SaaS claim and with least-privilege handling of attorney-client privileged or work-product material.

## Decision

ContractTwin is an internal single-enterprise product deployed in an isolated enterprise stack. A second enterprise may not be onboarded until organization identity, tenant-scoped encryption/storage, tenant-aware policy registries, database isolation and cross-tenant negative tests are designed and approved.

Professional authority is capability-based rather than inherited by rank. The target capabilities include legal-object review, counsel completion attestation, finance review, business/operations approval, executive exception approval, records administration and platform administration. A technical platform administrator has no ordinary right to read restricted matter content.

Restricted content requires explicit owner/member authorization. Emergency access is a time-limited break-glass grant with reason, approver, scope, expiry, prominent user notice and immutable audit. Requester, preparer, legal reviewer, financial reviewer, business approver and execution confirmer are independently recorded wherever policy requires segregation of duties.

## Consequences

- Current role checks remain a pilot compatibility layer, not the final authority model.
- New production-domain actions must bind an exact active capability and matter scope at write time, with database enforcement for irreversible states.
- Admin consoles must distinguish identity/platform administration from privileged-content administration.
- A future RLS or isolated-database defense-in-depth design must preserve opaque-resource non-disclosure semantics.
