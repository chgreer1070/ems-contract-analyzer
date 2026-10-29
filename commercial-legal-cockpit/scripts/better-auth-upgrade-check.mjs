import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root=process.cwd();
const packageManifest=JSON.parse(fs.readFileSync(path.join(root,"package.json"),"utf8"));
const lockfile=fs.readFileSync(path.join(root,"package-lock.json"),"utf8");
const authSource=fs.readFileSync(path.join(root,"lib/auth.ts"),"utf8");
const authMigrateSource=fs.readFileSync(path.join(root,"scripts/auth-migrate.mjs"),"utf8");
const microsoftMigrateSource=fs.readFileSync(path.join(root,"scripts/microsoft-account-oid-migrate.mjs"),"utf8");
const runbook=fs.readFileSync(path.join(root,"OPERATIONS_RUNBOOK.md"),"utf8");
const security=fs.readFileSync(path.join(root,"SECURITY.md"),"utf8");

assert.equal(packageManifest.dependencies["better-auth"],"1.7.14","production better-auth must be pinned to 1.7.14");
assert.equal(packageManifest.dependencies.jose,"6.2.14","Microsoft oid migrator must pin jose directly rather than rely on a transitive Better Auth copy");
assert.match(lockfile,/"node_modules\/better-auth"[\s\S]*?"version": "1\.7\.14"/,"package-lock must resolve better-auth 1.7.14");
assert.match(packageManifest.scripts["db:migrate:microsoft-oid"],/microsoft-account-oid-migrate\.mjs/,"package scripts must expose the explicit Microsoft oid cutover");
assert.match(packageManifest.scripts["test:better-auth-upgrade"],/better-auth-upgrade-check\.mjs/,"package scripts must expose the Better Auth 1.7 upgrade control check");
assert.match(packageManifest.scripts["test:controls"],/test:better-auth-upgrade/,"test:controls must include the Better Auth 1.7 upgrade control check");

assert.match(authSource,/socialProviders:[\s\S]*microsoft:\s*\{/,"auth must keep the built-in Microsoft social provider");
assert.match(authSource,/tenantId:\s*process\.env\.MICROSOFT_TENANT_ID/,"Microsoft tenantId must remain the configured concrete tenant");
assert.match(authSource,/Better Auth 1\.7\+|accountId from Entra `oid`|Entra `oid` claim/,"auth.ts must document the 1.7 Microsoft oid account-identifier change");
assert.doesNotMatch(authSource,/tenantId:\s*['"]common['"]|tenantId:\s*['"]organizations['"]|tenantId:\s*['"]consumers['"]/,"Microsoft social provider must not use common/organizations/consumers aliases");
assert.doesNotMatch(authSource,/genericOAuth|microsoftEntraId/,"ContractTwin must not use the Generic OAuth microsoftEntraId helper for production Entra SSO");
assert.doesNotMatch(authSource,/magicLink\(|emailOTP\(/,"this deployment does not enable Magic Link/email OTP plugins covered by the 1.7 advisory class");

assert.match(authMigrateSource,/getMigrations\(migrationAuth\.options\)/,"Better Auth schema changes must continue through the gated auth migrator");
assert.match(microsoftMigrateSource,/CONFIRM_MICROSOFT_ACCOUNT_OID_MIGRATION/,"Microsoft oid migrator must require an explicit confirmation gate");
assert.match(microsoftMigrateSource,/createRemoteJWKSet|jwtVerify/,"Microsoft oid migrator must verify stored ID tokens before rewriting accountId");
assert.match(microsoftMigrateSource,/MICROSOFT_OID_EXPORT_MAP_PATH/,"Microsoft oid migrator must accept a trusted Entra export map when ID tokens are unavailable");
assert.match(microsoftMigrateSource,/Dry-run only|dry-run/,"Microsoft oid migrator must default to non-mutating inventory");
assert.match(microsoftMigrateSource,/issuer is still NOT NULL|1\.7\.0-1\.7\.2/,"Microsoft/auth cutover must detect leftover 1.7.0-1.7.2 issuer NOT NULL constraints");
assert.match(microsoftMigrateSource,/Pause Microsoft sign-in|duplicate/i,"cutover must fail closed when oid mapping or duplicate keys are unsafe");

assert.match(runbook,/Better Auth 1\.7/,"operations runbook must document the Better Auth 1.7 cutover");
assert.match(runbook,/Microsoft account.*oid|oid claim/i,"operations runbook must document the Microsoft sub-to-oid account migration");
assert.match(runbook,/CONFIRM_MICROSOFT_ACCOUNT_OID_MIGRATION|db:migrate:microsoft-oid/,"operations runbook must name the explicit oid migration command/gate");
assert.match(runbook,/never ran Better Auth 1\.7\.0 through 1\.7\.2|no issuer schema cleanup/i,"operations runbook must record the direct 1.6-to-1.7.3+ issuer guidance");
assert.match(security,/1\.7\.14|GHSA-965c-763c-88jm/,"security docs must record the Better Auth advisory clearance target");

console.log("Better Auth 1.7.14 upgrade controls passed.");
