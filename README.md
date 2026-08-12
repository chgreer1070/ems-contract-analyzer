# ContractTwin / EMS Commercial Legal Cockpit

The canonical product target in this repository is the governed ContractTwin platform under [`commercial-legal-cockpit/`](commercial-legal-cockpit/README.md). The current code is an engineering pilot toward a private, human-authorized EMS commercial intelligence and negotiation system of record; the immutable negotiation ledger and accepted-state agreement pipeline are not implemented yet. Start with:

- [`commercial-legal-cockpit/ARCHITECTURE.md`](commercial-legal-cockpit/ARCHITECTURE.md) for the target product and completion contract;
- [`commercial-legal-cockpit/README.md`](commercial-legal-cockpit/README.md) for local setup and implemented capabilities;
- [`commercial-legal-cockpit/PRODUCTION_READINESS.md`](commercial-legal-cockpit/PRODUCTION_READINESS.md) for current release limitations and acceptance gates.

This repository does **not** claim that a preview, synthetic evaluation, or passing source-level test establishes production readiness. Production reliance requires the exact deployed release, approved source-processing environment, live integrations, complete human authority, and the acceptance evidence listed in the readiness document.

## Canonical development commands

```bash
cd commercial-legal-cockpit
npm ci
npm run test:controls
npm run typecheck
npm run build
```

Database-backed acceptance also requires disposable PostgreSQL or an explicitly approved non-production target; see the cockpit runbook.

## Historical Flask prototype

`app.py`, `analyzer.py`, `templates/`, the Python fixtures, and `tests.py` are a retained stateless regex prototype. They are non-authoritative historical/demo material, have no persistent governance or legal-reliance controls, and must not be deployed or used for contract conclusions. Their CI job is labeled as legacy coverage while they are being isolated into an archival package.
