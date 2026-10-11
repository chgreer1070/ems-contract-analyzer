# PDF preparation: nonproduction acceptance setup

The local PDF, stream, scanner-protocol, worker, and package checks are complete.
They do not establish authenticated database/Blob/ClamAV behavior or hosted
worker execution. Keep the PDF preparation flag off. No environment is created
or configured by the tools in this increment.

## First decision

Choose the organization and provider for a separate synthetic test database.
Proposed database project name: `contracttwin-pdf-test`; proposed region if using
Supabase: `us-east-1`. Verify the organization's current project cost and obtain
cost/account approval before creation. Do not reactivate or repurpose an existing
project without evidence that it is an approved test target.

The database is the first setup step. Test private storage, Microsoft/Better Auth,
ClamAV, and a preview application follow separately. Creating a database alone
does not complete the environment. Engineering owns preparation and validation;
the user approves account changes and resource cost. No due date is set.

## Configuration-only preflight

See `docs/pdf-preparation-test.env.example` for the exact variables. Inject them
through the approved environment/secret store. Do not commit filled-in files,
copy production credentials, or paste secrets into review comments.

Run from `commercial-legal-cockpit`:

```sh
npm run pdf-preparation:preflight
```

This default command performs no network calls or writes. It reports variable
names, pass/fail conditions, and fixed diagnostics. It does not print credential
values or private endpoints. Exit 2 means missing/invalid configuration.
`CONFIGURATION_PRESENT_NOT_VERIFIED` means settings are present, not accepted.
Every result keeps `liveValidationPassed=false` and `featureMayBeEnabled=false`.

The physical DB UUID and the connection-target hash must come from a separately
reviewed target record. The hash is version 1 SHA-256 of JSON containing canonical
host, port, database name, and decoded username, in that order. Including username
distinguishes tenant-specific pooled endpoints; passwords are excluded so rotation
does not alter the binding. The utility `pdfTestDatabaseTargetSha256` calculates
it without printing the connection string. A self-supplied matching hash does not
prove that a database is nonproduction or authorize access.

## Read-only database verification

Once the approved target has exact repository migrations and a least-privilege
runtime role, run:

```sh
npm run pdf-preparation:preflight -- --database-read-only
```

This stage needs only the test/environment/target settings, not Blob or auth
credentials. It rejects production or ambiguous selectors, enabled feature flags,
unverified TLS, inherited TLS/PG overrides, and mismatched target bindings before
connecting. It uses the repository's verified connection helper, 5-second connect
and query limits, and a read-only transaction with statement/lock/idle limits.

It rejects a `contracttwin_control.production_target_binding` relation, including
one preserved in a test clone. It then checks the exact physical database UUID,
the repository migration receipts, and all existing runtime-principal controls.
It always rolls back after a begun transaction. It never reads contract contents,
creates schema, changes grants, seeds users, writes audit receipts, or touches Blob.
Absent production bindings alone do not establish nonproduction; operator approval
and provider project identity remain required. Provider failures emit a fixed
diagnostic, not raw errors that may contain endpoints or credentials.

## Remaining live acceptance

After separate setup approvals, validate the app's actual authenticated routes
with synthetic PDFs and editor/viewer/outsider test principals. Verify private
object retrieval, hashes, scanner clean/threat/error handling, intent/completion
receipts, source revocation, interruption, and worker execution on the hosted
runtime. Any test writes must be limited to the approved synthetic matter/store.
Agree derivative retention, legal-hold, and interrupted-write recovery before
feature enablement. Read-only preflight is not that approval.

If Supabase is selected, this app continues to use direct PostgreSQL, Better Auth,
and Vercel Blob. Supabase's Data API defaults are not a substitute for the app's
authorization, and its schema/role compatibility remains to be verified against
the existing migration and least-privilege controls. Keep app tables outside
public Data API access. See the
[Supabase Data API change](https://supabase.com/changelog/45329-breaking-change-tables-not-exposed-to-data-and-graphql-api-automatically).

## Local verification

`npm run test:pdf-preparation-preflight` has 15 checks covering production
selectors, feature flags, missing/malformed settings, pooled target binding,
secret redaction, zero-network default execution, connection-error redaction,
read-only sequencing/rollback, production markers, identity drift, migration
drift, and unsafe runtime privileges. DB replies are mocked. No live provider
behavior is claimed.
