# Repository guidance

## Canonical product

The production-oriented application is `commercial-legal-cockpit/`. Read its `ARCHITECTURE.md`, `README.md`, `SECURITY.md`, `PRODUCTION_READINESS.md`, and `OPERATIONS_RUNBOOK.md` before changing it.

The root Python/Flask files are a historical stateless regex prototype. Preserve their tests while they remain in the repository, but do not extend them as the ContractTwin platform, do not present their results as legal-reliance output, and do not let them define production architecture.

## Non-negotiable engineering boundaries

- Preserve exact source provenance, immutable review/decision history, and explicit human authorization.
- Do not treat model output as governing text, policy, financial fact, or an authorized decision.
- Keep synthetic/demo data visibly isolated from persistent reliance state.
- Do not claim that code, a preview deployment, or synthetic tests are production evidence.
- Use the migration manifest and production-target controls for database changes; do not bypass the schema gate.
- Keep provider-specific services behind adapters so the authoritative source/evidence/negotiation ledger remains portable and enterprise-controlled.

## Canonical commands

```bash
cd commercial-legal-cockpit
npm ci
npm run test:controls
npm run typecheck
npm run build
```

Follow `commercial-legal-cockpit/OPERATIONS_RUNBOOK.md` for database-backed checks and release handling.
