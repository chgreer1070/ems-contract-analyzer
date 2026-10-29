# Playbook database verification v0.3

This increment adds executable SQL evidence to the v0.2 playbook service. It changes no production service code. The fixtures contain synthetic contracts, users, and reviews only. Their `live` scope exercises host validation; it does not establish a live legal approval.

## Observed results

PGlite 0.3.14 executes PostgreSQL 17.5 in WebAssembly. Twelve checks pass under a genuine non-superuser session: create/review/export, audit immutability, transaction rollback, missing audit INSERT privilege, current capability and matter membership, source tampering, persisted revocation after orderly close/reopen, JSONB digests, expiry, and cross-matter lookup denial. Two native concurrency checks are skipped in this mode. The prior 42 kernel/service tests remain the separate regression baseline.

The fixture applies migration 001 (omitting only the unavailable pgcrypto extension declaration in WASM), plus exact selected document column and capability table statements from migrations 003, 006, and 008. This is not the complete production migration chain. The runtime role has application table DML privileges, including authority tables and audit INSERT. Trigger protection and non-superuser status do not establish independently protected authority records or production least privilege. Orderly reopen does not prove crash recovery.

## Reproduce embedded engine checks

Install the test dependency outside the application; no production dependency changes are required:

```sh
npm install --prefix /tmp/playbook-postgres-test --ignore-scripts --no-audit --no-fund @electric-sql/pglite@0.3.14
PGLITE_MODULE=/tmp/playbook-postgres-test/node_modules/@electric-sql/pglite/dist/index.js node --test scripts/playbook-postgres-check.mjs
```

Run from commercial-legal-cockpit. Temporary disk stores contain synthetic data and are left under /tmp for diagnosis.

## Native mode: prepared, not yet executed

The same script accepts PLAYBOOK_TEST_OWNER_DATABASE_URL instead of PGLITE_MODULE. It requires a loopback URL without options, database name `contracttwin_playbook_test`, an empty public schema, a superuser fixture owner, and no existing `playbook_runtime` role. Use a fresh disposable PostgreSQL 17 cluster: the script intentionally provisions a role and synthetic tables. It refuses other database names and non-loopback targets before connecting. No production database or credentials belong in this test.

Native mode additionally holds an export transaction open while another backend attempts revocation, then checks that the later export is denied. A second check holds the source row lock while another backend attempts mutation, then checks that the next export fails integrity validation. Both require an observed PostgreSQL lock wait before the first commit. Native service connection pools use a 15-second statement timeout.

The new GitHub workflow runs these checks against a disposable postgres:17 service, with contents:read and pinned actions. The image tag is not digest-pinned; the script prints the actual engine version on execution. No workflow has been published or run. Native concurrency, full migrations, TLS, crash recovery, SSO, and production authorization remain unverified.

Next decision: publish the isolated review branch to run the native CI checks, or provide a disposable local PostgreSQL environment. This increment alone does not satisfy the ContractTwin production release gates.
