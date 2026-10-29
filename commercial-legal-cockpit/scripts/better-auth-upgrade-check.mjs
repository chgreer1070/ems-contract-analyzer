import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");

const REQUIRED_BETTER_AUTH = "1.7.14";
const packageManifest = JSON.parse(read("package.json"));
const packageLock = JSON.parse(read("package-lock.json"));
const authSource = read("lib/auth.ts");
const runbook = read("OPERATIONS_RUNBOOK.md");
const security = read("SECURITY.md");

assert.equal(
  packageManifest.dependencies["better-auth"],
  REQUIRED_BETTER_AUTH,
  `package.json must pin better-auth exactly to ${REQUIRED_BETTER_AUTH} (intentional 1.7 upgrade, not a silent 1.6 patch)`
);

const lockedBetterAuth = packageLock.packages?.["node_modules/better-auth"];
assert.equal(
  lockedBetterAuth?.version,
  REQUIRED_BETTER_AUTH,
  `package-lock.json must resolve better-auth to ${REQUIRED_BETTER_AUTH}`
);
assert.match(
  lockedBetterAuth?.resolved || "",
  new RegExp(`better-auth-${REQUIRED_BETTER_AUTH.replaceAll(".", "\\.")}\\.tgz`),
  "lockfile must resolve the exact better-auth tarball for the pinned release"
);

assert.match(
  packageManifest.scripts["test:controls"],
  /test:better-auth-upgrade/,
  "test:controls must include the Better Auth upgrade control check"
);

assert.match(
  authSource,
  /Better Auth 1\.7 Microsoft identity contract/,
  "auth config must document the intentional 1.7 Microsoft identity change"
);
assert.match(
  authSource,
  /account\.accountId|directory `oid`|directory \$\{?oid\}?/,
  "auth config must name the oid accountId contract"
);
assert.match(
  authSource,
  /\$\{authority\}\/\$\{tenantId\}\/v2\.0|authority\/\$\{tenantId\}\/v2\.0/,
  "auth config must document the concrete-tenant issuer check introduced for Microsoft tokens"
);
assert.match(
  authSource,
  /tenantId:\s*process\.env\.MICROSOFT_TENANT_ID/,
  "Microsoft provider must keep a concrete MICROSOFT_TENANT_ID (issuer-binding tenant GUID)"
);
assert.doesNotMatch(
  authSource,
  /tenantId:\s*["'](?:common|organizations|consumers)["']/,
  "Microsoft provider must not use multi-tenant aliases that skip the fixed issuer check"
);
assert.match(
  authSource,
  /authority:\s*"https:\/\/login\.microsoftonline\.com"/,
  "Microsoft authority must remain the Entra login host"
);

assert.match(
  runbook,
  /Better Auth 1\.7 upgrade/,
  "operations runbook must include an explicit Better Auth 1.7 upgrade section"
);
assert.match(
  runbook,
  /not a silent 1\.6 patch|Do not treat this as a silent patch/i,
  "runbook must forbid treating the Better Auth bump as a silent patch"
);
assert.match(
  runbook,
  /GHSA-965c-763c-88jm/,
  "runbook must cite the OAuth-state / magic-link advisory cleared by 1.7.14"
);
assert.match(
  runbook,
  /providerId\s*=\s*'microsoft'|providerId:\s*"microsoft"/,
  "runbook must inventory Microsoft account rows by providerId"
);
assert.match(
  runbook,
  /\boid\b[\s\S]*\bsub\b|\bsub\b[\s\S]*\boid\b/,
  "runbook must require migrating Microsoft accountId values from sub to oid"
);
assert.match(
  runbook,
  /pause Microsoft sign-in|pause Microsoft Entra sign-in/i,
  "runbook must require pausing Microsoft sign-in when stored ID tokens are unavailable"
);
assert.match(
  runbook,
  /1\.7\.0 through 1\.7\.2|issuer column/i,
  "runbook must cover the temporary account.issuer schema episode for databases that briefly ran 1.7.0-1.7.2"
);

assert.match(
  security,
  /better-auth@1\.7\.14|Better Auth 1\.7\.14/,
  "SECURITY.md must record the intentional Better Auth 1.7.14 floor"
);
assert.match(
  security,
  /GHSA-965c-763c-88jm/,
  "SECURITY.md must cite GHSA-965c-763c-88jm as cleared by the 1.7.14 upgrade"
);
assert.match(
  security,
  /oid/,
  "SECURITY.md must mention the Microsoft oid account identifier change"
);

console.log(
  `Better Auth upgrade controls passed: package and lock pin ${REQUIRED_BETTER_AUTH}; Microsoft oid/issuer cutover is documented in auth config, OPERATIONS_RUNBOOK, and SECURITY.md.`
);
