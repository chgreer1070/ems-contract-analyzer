# ContractTwin Release Candidate and Freeze Boundary

This file defines what a future ContractTwin release freeze must mean. Its presence does **not** itself prove that the current working tree is frozen, code-complete, tested, deployed, or approved for production.

## Intended release-candidate scope

The candidate is intended to include the production-oriented application, identity and authorization model, private source-document evidence chain, ClamAV quarantine gate, durable processing workflows, atomic source-grounded analysis publication, contract graph, deterministic economics, governed negotiation standards, documented human review, independently dispositioned approvals, agreement versioning, explicitly generated state-bound executive snapshots, records governance, legal holds, two-phase controlled purge, audit history, validation framework, security controls, CI, CodeQL and guarded Vercel release automation.

Every migration through `010_release_target_binding.sql` is part of this scope and must travel with the matching application and worker code. Migration `010` adds immutable database identity, append-only release-target receipts and pinned trigger-function search paths. The full document pipeline ends after precedence analysis; it does not automatically generate an executive snapshot. A separately requested snapshot is reliance-capable only when its immutable successful generator receipt binds the authorized requester, exact agreement/economics/reliance preimage and canonical state hash.

## Freeze evidence required

A release is frozen only when an attestation records all of the following for one immutable source commit:

- exact Git commit SHA and clean source state;
- locked dependency installation and production dependency audit;
- Better Auth and ContractTwin migrations through `010` against PostgreSQL 17, including exact ordered filename/hash receipts, idempotent rerun, immutable target identity/per-release binding, database-control checks and live critical-object drift detection;
- application access, validation/readiness and security-boundary control checks;
- frozen corpus and deterministic economics checks;
- TypeScript, production build and CodeQL results;
- artifact/deployment identity and required reviewer approvals; and
- no source changes after the recorded SHA.

The attestation is published as run-scoped workflow evidence with its artifact digest in the job summary. Release, failure and diagnostic workflows are read-only with respect to the repository: CI must never commit evidence back to the source branch, because doing so would advance the reviewed head to a new unvalidated commit.

This document does not claim that those checks have run. If any application source, migration, dependency, workflow, validation corpus or release-control file changes after attestation, create and approve a new release candidate.

## Production-activation boundary

Even a successfully attested code-complete release is **not** production activation and does not authorize confidential agreements. Activation separately requires an approved private repository and target infrastructure; production Entra, PostgreSQL, private Blob, ClamAV, OpenAI and OCR configuration; `AUTH_REQUIRED=true` and `ALLOW_DEMO_ACCESS=false`; company-approved negotiation standards and records policy; exact current-model validation; live target-environment acceptance and recovery testing; monitoring; security/privacy/privilege review; and formal approval by the named control owners.

`LEGAL_RELIANCE_ENABLED` must remain false until all applicable readiness and acceptance gates are approved. `ALLOW_SOURCE_PURGE` must remain false until records management separately authorizes destruction and the two-phase purge recovery path has been tested.
