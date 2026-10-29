import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const packageManifest = JSON.parse(readFileSync(join(projectRoot, "package.json"), "utf8"));
const lockfile = readFileSync(join(projectRoot, "package-lock.json"), "utf8");
const authSource = readFileSync(join(projectRoot, "lib/auth.ts"), "utf8");
const opsRunbook = readFileSync(join(projectRoot, "OPERATIONS_RUNBOOK.md"), "utf8");
const securityDoc = readFileSync(join(projectRoot, "SECURITY.md"), "utf8");
const envExample = readFileSync(join(projectRoot, ".env.example"), "utf8");
const cutoverScript = readFileSync(join(projectRoot, "scripts/microsoft-account-oid-cutover.mjs"), "utf8");
const installedBetterAuth = require(join(projectRoot, "node_modules/better-auth/package.json"));

const REQUIRED_BETTER_AUTH = "1.7.14";

assert.equal(
  packageManifest.dependencies["better-auth"],
  REQUIRED_BETTER_AUTH,
  `package.json must pin better-auth ${REQUIRED_BETTER_AUTH} to clear GHSA-965c-763c-88jm and related 1.7 advisories`
);
assert.match(
  lockfile,
  new RegExp(`"node_modules/better-auth"[\\s\\S]*?"version": "${REQUIRED_BETTER_AUTH}"`),
  `package-lock.json must resolve better-auth ${REQUIRED_BETTER_AUTH}`
);
assert.equal(
  installedBetterAuth.version,
  REQUIRED_BETTER_AUTH,
  `installed better-auth must be ${REQUIRED_BETTER_AUTH}`
);

assert.match(authSource, /AMBIGUOUS_MICROSOFT_TENANTS/, "auth must reject ambiguous Microsoft tenants");
assert.match(authSource, /common.*organizations.*consumers|organizations.*consumers/, "auth must name the ambiguous Microsoft tenants");
assert.match(authSource, /MICROSOFT_TENANT_GUID/, "auth must require a concrete Entra tenant GUID");
assert.match(authSource, /disableProfilePhoto:\s*true/, "Microsoft provider must disable oversized profile photos");
assert.match(authSource, /verified Entra `oid` claim|account\.accountId/, "auth must document the Better Auth 1.7 Microsoft oid account-identifier change");
assert.match(authSource, /account issuer|trusted issuer|id-token issuer/i, "auth must document the Microsoft account-issuer binding");

assert.match(opsRunbook, /Better Auth 1\.7/, "operations runbook must document the Better Auth 1.7 upgrade");
assert.match(opsRunbook, /sub.*oid|oid claim/i, "operations runbook must require Microsoft accountId migration from sub to oid");
assert.match(opsRunbook, /microsoft-account-oid-cutover/, "operations runbook must point operators at the oid cutover script");
assert.match(opsRunbook, /common|organizations|consumers/, "operations runbook must forbid ambiguous Microsoft tenants");
assert.match(opsRunbook, /issuer/i, "operations runbook must cover the Microsoft account-issuer change");

assert.match(securityDoc, /better-auth[`*_\s]*1\.7\.14|Better Auth[`*_\s]*1\.7\.14/i, "security doc must record the patched Better Auth version");
assert.match(securityDoc, /GHSA-965c-763c-88jm/, "security doc must cite the cleared Better Auth advisory");
assert.match(securityDoc, /oid/i, "security doc must describe the Microsoft oid account identifier");

assert.match(envExample, /concrete Entra tenant GUID|tenant GUID/i, ".env.example must require a concrete Entra tenant GUID");
assert.doesNotMatch(envExample, /MICROSOFT_TENANT_ID=common/, ".env.example must not suggest an ambiguous Microsoft tenant");

assert.match(cutoverScript, /providerId.?=.?['"]microsoft['"]|providerId:\s*["']microsoft["']|"microsoft"/, "cutover script must target microsoft provider rows");
assert.match(cutoverScript, /accountId/, "cutover script must rewrite Microsoft accountId values");
assert.match(cutoverScript, /oid/, "cutover script must migrate to the Entra oid claim");
assert.match(cutoverScript, /--apply/, "cutover script must require an explicit apply flag");

assert.match(
  packageManifest.scripts["test:controls"],
  /test:better-auth-upgrade/,
  "test:controls must include the Better Auth upgrade gate"
);

console.log(`Better Auth upgrade controls passed for ${REQUIRED_BETTER_AUTH}.`);
