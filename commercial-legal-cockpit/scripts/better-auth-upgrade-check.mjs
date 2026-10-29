import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import path from "node:path";

const root=process.cwd();
const packageJson=JSON.parse(await readFile(path.join(root,"package.json"),"utf8"));
const lockfile=await readFile(path.join(root,"package-lock.json"),"utf8");
const authSource=await readFile(path.join(root,"lib/auth.ts"),"utf8");
const authClientSource=await readFile(path.join(root,"lib/auth-client.ts"),"utf8");
const proxySource=await readFile(path.join(root,"proxy.ts"),"utf8");
const migrateScript=await readFile(path.join(root,"scripts/microsoft-account-oid-migrate.mjs"),"utf8");
const upgradeCheckSelf=await readFile(path.join(root,"scripts/better-auth-upgrade-check.mjs"),"utf8");
const runbook=await readFile(path.join(root,"OPERATIONS_RUNBOOK.md"),"utf8");
const security=await readFile(path.join(root,"SECURITY.md"),"utf8");

const requiredVersion="1.7.14";
assert.equal(packageJson.dependencies["better-auth"],requiredVersion,`better-auth must be pinned exactly to ${requiredVersion} for the GHSA-965c-763c-88jm / 1.7 advisory cutover`);
const lockPackages=JSON.parse(lockfile).packages||{};
const lockedBetterAuth=lockPackages["node_modules/better-auth"];
assert.equal(lockedBetterAuth?.version,requiredVersion,`package-lock must resolve better-auth ${requiredVersion}`);
for(const [name,meta] of Object.entries(lockPackages)){
  if(name==="node_modules/better-auth"||name.startsWith("node_modules/better-auth/")||/^node_modules\/@better-auth\//.test(name)){
    assert.ok(!String(meta?.version||"").startsWith("1.6."),`${name} must not remain on better-auth 1.6.x after the 1.7.14 cutover`);
  }
}

assert.match(authSource,/socialProviders:\s*microsoftConfigured/,"auth config must keep the Microsoft social provider gate");
assert.match(authSource,/tenantId:\s*process\.env\.MICROSOFT_TENANT_ID/,"Microsoft provider must use the configured tenant id");
assert.match(authSource,/Better Auth 1\.7/,"auth.ts must document the Better Auth 1.7 Microsoft oid identity change");
assert.match(authSource,/oid/,"auth.ts must call out Entra oid as the provider account identifier");
assert.doesNotMatch(authSource,/tenantId:\s*["'](?:common|organizations|consumers)["']/,"do not hard-code multi-tenant Microsoft authority aliases; use a concrete tenant GUID");

assert.match(authClientSource,/createAuthClient/,"auth client must continue to use the Better Auth React client");
assert.match(proxySource,/getSessionCookie/,"edge/session gate must continue to use better-auth cookie helper");

assert.match(packageJson.scripts["db:migrate:microsoft-oid"],/microsoft-account-oid-migrate\.mjs/,"package scripts must expose the Microsoft oid cutover tool");
assert.match(packageJson.scripts["test:better-auth-upgrade"],/better-auth-upgrade-check\.mjs/,"package scripts must expose the Better Auth upgrade control check");
assert.match(packageJson.scripts["test:controls"],/test:better-auth-upgrade/,"test:controls must include the Better Auth upgrade control check");

assert.match(migrateScript,/apply-id-tokens/,"Microsoft oid migrator must support verified idToken rewrites");
assert.match(migrateScript,/apply-mapping/,"Microsoft oid migrator must support trusted Entra export mappings");
assert.match(migrateScript,/account_issuer_accountId_uidx/,"Microsoft oid migrator must detect leftover 1.7.0–1.7.2 issuer indexes");
assert.match(migrateScript,/createRemoteJWKSet|jwtVerify/,"idToken apply path must verify Microsoft tokens rather than trusting raw payload decode alone");
assert.match(migrateScript,/needs_oid_migration/,"migrator must classify sub→oid rows explicitly");

assert.match(runbook,/Better Auth 1\.7/,"operations runbook must document the Better Auth 1.7 upgrade cutover");
assert.match(runbook,/Microsoft account/,"operations runbook must document the Microsoft account identifier migration");
assert.match(runbook,/oid/,"operations runbook must name the Entra oid cutover");
assert.match(runbook,/issuer/,"operations runbook must explain the 1.7.0–1.7.2 issuer column reversal");
assert.match(runbook,/db:migrate:microsoft-oid/,"operations runbook must point operators at the oid migration script");

assert.match(security,/oid/,"security boundary docs must treat Entra oid as the stable Microsoft identity anchor");
assert.match(security,/Better Auth 1\.7/,"security docs must record the Better Auth 1.7 identity change");

assert.match(upgradeCheckSelf,/GHSA-965c-763c-88jm/,"upgrade control check must name the advisory motivating 1.7.14");

console.log("Better Auth 1.7.14 upgrade controls passed.");
