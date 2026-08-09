# ADR-0003: Separate package lock, legal approval, business authority and execution

- Status: Accepted target architecture; partial UI relabeling delivered; schema/data migration pending
- Date: 2026-08-08
- Scope: Agreement-version lifecycle and execution evidence

## Context

The current `WORKING -> APPROVED -> EXECUTED -> SUPERSEDED` lifecycle overloads `APPROVED`. Today that transition proves a clean, hash-verified source set, but the complete analysis, counsel-attestation, economics and decision gates are deferred to `EXECUTED`. An uploaded document can also be self-labelled `EXECUTED` without an immutable signature or manual-verification record.

The word “approved” therefore implies more authority and completeness than the state proves.

## Decision

The target lifecycle separates orthogonal evidence:

1. `WORKING` — mutable package composition.
2. `PACKAGE_LOCKED` — immutable source membership and ordering, with verified source integrity; no legal or business conclusion implied.
3. `LEGAL_REVIEWED` — structure/full-package coverage complete, current engine evidence bound, all legal objects disposed, and counsel completion attested.
4. `BUSINESS_APPROVED` — required finance, business, quality, operations and executive approval instances complete for the exact package/economics state.
5. `EXECUTION_READY` — accepted-state clean artifact frozen, conditions resolved, signing packet approved and segregation-of-duties checks satisfied.
6. `EXECUTED` — signed artifact and signature/envelope or approved manual-verification evidence recorded with parties, signature pages, dates and independent confirmer.
7. `SUPERSEDED` — a later executed package is operative, without erasing prior state.

Each transition has its own actor, rationale, state hash and immutable receipt. No single status field substitutes for the underlying evidence records. The clean agreement is derived only from accepted negotiation states and receives its own artifact hash before execution.

## Consequences

- Existing `APPROVED` is treated as a legacy package-lock state until a forward migration and UI/API transition are delivered.
- UI labels must not call that legacy state legal approval or execution readiness.
- Snapshot and execution workflows must name the exact lifecycle/evidence state they consume.
- Package preparer, legal reviewer, business approver and execution confirmer cannot collapse into one actor where policy requires independence.
