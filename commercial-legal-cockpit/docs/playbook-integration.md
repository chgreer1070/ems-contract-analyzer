# ContractTwin playbook integration 0.2.0

This increment adds a server API and host review registry to the standalone playbook trial. It is implemented in an isolated checkout and has not been pushed or deployed. It does not approve a Flex position, calculate entitlement, send a notice, or authorize invoicing.

## Implemented

- `POST /api/matters/{matterId}/playbooks` supports create, review, revoke, evaluate, and export.
- Authenticated identity comes from existing ContractTwin access controls. The service rechecks role, matter membership, and legal-counsel capability inside the transaction.
- Creation requires LAWYER or higher and matter EDIT. Review/revocation require APPROVER or ADMIN, matter APPROVE, and active LEGAL_COUNSEL_ATTEST. Export requires matter APPROVE; evaluation requires VIEW. Explicit lower membership overrides broader global legal access, consistent with access.ts.
- Drafts, reviews, revocations, and exports are stored as new append-only audit events. No database migration is introduced. The existing audit table's mutation-blocking trigger remains responsible for database-level immutability.
- A transaction advisory lock serializes the registry for each matter. Source and authority rows are held with shared locks. These SQL paths are implemented but real PostgreSQL concurrency has not been tested in this environment.
- Original file identity/hash, source version, derived text hash, extraction method, and exact quote offsets are bound to the review candidate. Source changes block reuse.
- Every export reevaluates expiry, revocation, current reviewer authority, applicability, missing facts, conflicts, and dependencies. Audit insertion must succeed before the service returns an export.

## Source limits

Only clean, active, SERVER_VERIFIED, EXECUTED documents with explicit version labels and PLAIN_TEXT extraction are supported by this integration. DOCX_RAW_TEXT and PDF_TEXT are deliberately ineligible here. Support for negotiated DOCX requires the structured intake acceptance work before enabling it.

The adapter reconstructs text by joining ordered database chunks with newlines. Existing chunks may contain overlap or normalization. In the kernel, `documentSha256` hashes this derived text, not the original uploaded file; `originalSha256` pins the original file hash, verified against the database's server integrity receipt. Export `hostEvidence` identifies both hashes, the extraction method, and contributing chunk IDs. This proves correspondence with stored evidence, not complete original-file fidelity, signature validity, legal applicability, or clause coverage. UTF-16 offsets address the reconstructed string. Plain-text chunk indices must be unique and contiguous from zero.

## API workflow

All requests use JSON. The route limits the body to 128 KiB; the service limits books to 64 options, 32 references, and derived source text to 1 MiB per document. Unknown request fields are rejected. There is no browser UI in this increment.

1. Create: `{ "operation": "create", "book": BOOK }`. BOOK follows the trial schema, with a fresh UUID as its ID, scope `live`, and every option marked `draft`. Every source additionally pins `originalSha256` and `extractionMethod: "PLAIN_TEXT"`. Its `documentId` is the existing document UUID in this matter. The API validates against database evidence before recording the immutable draft.
2. The creation receipt returns `draftDigest` and `candidateDigest`. The latter hashes an otherwise identical candidate with option statuses normalized to `reviewed`. Normalization is internal preparation for review; it never supplies authority. Every option still requires an active, server-recorded legal review. The stored original draft remains unchanged.
3. Review: `{ "operation": "review", "bookId": UUID, "candidateDigest": DIGEST, "optionId": ID, "expiresAt": UTC_TIMESTAMP, "note": SUBSTANTIVE_NOTE }`. Review must expire within the option's applicability period. The reviewer and event time are assigned by the server/database. Client claims of approval, reviewer identity, or current time are rejected.
4. Evaluate: `{ "operation": "evaluate", "bookId": UUID, "business": BUSINESS, "jurisdiction": JURISDICTION }`. The response shows blocked or ready-for-host-review outcomes and source provenance. It conveys no customer-action authority.
5. Export uses the same fields with `operation: "export"`. Every option and dependency must pass. The receipt includes export and active review event IDs. The result remains a time-bound snapshot and must be reevaluated before later use.
6. Revoke: `{ "operation": "revoke", "bookId": UUID, "reviewEventId": EVENT_ID_STRING, "note": SUBSTANTIVE_NOTE }`. Revocation creates a new audit event. A new review may be recorded after revocation; old events remain intact. Editing language requires a new book UUID/version and new reviews.

The synthetically seeded `live` request labels in tests exercise host behavior; they do not constitute live evidence or approved Flex language.

## Run and verification

From `commercial-legal-cockpit`:

```sh
node --test scripts/playbook-kernel-check.mjs scripts/playbook-integration-check.mjs
npm run typecheck
npm run build
npm run test:controls
```

The combined suite contains 42 passing checks. Integration persistence/authorization checks use an explicitly identified in-memory SQL double. The full application typecheck, build, and existing control suite pass. A local built-server check returns 503 for this route without a configured database and 405 for unsupported GET. Independent adversarial review covers access precedence and a dense 64-option dependency graph.

These results do not establish actual SSO, real PostgreSQL grants, row/advisory locking, concurrent transactions, durable audit writes, rollback, backup/restore, or authenticated business UAT. No such evidence was available here. This is not a production or full ContractTwin release.

## Required before live enablement

| Work | Proposed owner | Timing | Risk if missing | Mitigation / owner |
| --- | --- | --- | --- | --- |
| Run PostgreSQL integration tests with target runtime grants, actual rollback and concurrent revocation | ContractTwin engineering owner | Before pilot enablement | Registry enforcement differs from the double | Keep endpoint out of deployment / engineering owner |
| Test actual SSO identity, matter membership, and legal capability revocation | Identity owner + Flex legal | Before real review records | Approval attributed to an unauthorized principal | Block pilot / identity owner |
| Admit reviewed Flex precedents and confirm position authority | Flex legal lead | Before approved-playbook use | Illustrative language mistaken for policy | Keep options unapproved / legal lead |
| Complete structured negotiated-DOCX intake gates | Intake engineering + Flex counsel | Before DOCX use | Lost changes, comments, or applicability evidence | Continue DOCX_RAW_TEXT denial / intake owner |

No calendar deadline or named human owner was agreed in this task. All timings are prerequisites, not commitments.

## Restore and rollback

The patch adds new files only. Apply it to the exact base revision using `git apply --check` before `git apply`. Use a separate branch. A local overlay copy is included for inspection. No migrations or live writes were executed. Before any future deployment, remove or disable the route to withdraw the capability; preserve existing audit records. Source rollback uses `git apply -R` for the delivered patch on a matching isolated branch, after checking for later changes. Do not delete review records as a rollback mechanism.
