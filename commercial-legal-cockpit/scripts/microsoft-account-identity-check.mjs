import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import {
  MICROSOFT_AUTHORITY,
  assessStructuralCutover,
  assertBetterAuth17AccountCutover,
  fetchMicrosoftJwks,
  isConcreteEntraTenantId,
  microsoftAccountIdUpdateQuery,
  parseReviewedOidMapping,
  planMicrosoftAccountIdentifierMigration,
  verifyStoredMicrosoftIdToken
} from "./microsoft-account-identity.mjs";

const tenantId = "22222222-2222-4222-8222-222222222222";
const clientId = "33333333-3333-4333-8333-333333333333";
const oid = "11111111-1111-4111-8111-111111111111";
const subject = "44444444-4444-4444-8444-444444444444";
const rowId = "a".repeat(32);
const otherRowId = "b".repeat(32);

assert.equal(isConcreteEntraTenantId(tenantId), true);
assert.equal(isConcreteEntraTenantId(`  ${tenantId.toUpperCase()}  `), true);
for (const rejected of ["common", "organizations", "consumers", "contoso.onmicrosoft.com", "", "not-a-guid"]) {
  assert.equal(isConcreteEntraTenantId(rejected), false, rejected);
}

assert.deepEqual(assessStructuralCutover({ duplicateKeys: [], issuer: null, indexDefinitions: [] }), { ok: true, errors: [] });
assert.equal(assessStructuralCutover({ duplicateKeys: [{ provider_id: "microsoft", account_id: subject, row_count: 2 }], issuer: null, indexDefinitions: [] }).ok, false);
assert.equal(assessStructuralCutover({ duplicateKeys: [], issuer: { name: "issuer", nullable: false }, indexDefinitions: [] }).ok, false);
assert.equal(assessStructuralCutover({ duplicateKeys: [], issuer: { name: "issuer", nullable: true }, indexDefinitions: [] }).ok, true);
assert.equal(assessStructuralCutover({
  duplicateKeys: [],
  issuer: { name: "issuer", nullable: true },
  indexDefinitions: ["CREATE UNIQUE INDEX account_issuer_accountId_uidx ON public.account USING btree (issuer, \"accountId\")"]
}).ok, false);

const aligned = planMicrosoftAccountIdentifierMigration([{
  id: rowId, providerId: "microsoft", accountId: oid, verifiedOid: oid, verificationError: null, reviewedOid: null
}]);
assert.equal(aligned.ok, true);
assert.deepEqual(aligned.updates, []);
assert.deepEqual(aligned.aligned, [rowId]);

const rewrite = planMicrosoftAccountIdentifierMigration([{
  id: rowId, providerId: "microsoft", accountId: subject, verifiedOid: oid, verificationError: null, reviewedOid: null
}]);
assert.equal(rewrite.ok, true);
assert.equal(rewrite.updates[0].oid, oid);
assert.equal(rewrite.updates[0].previousAccountId, subject);

const collision = planMicrosoftAccountIdentifierMigration([
  { id: rowId, providerId: "microsoft", accountId: subject, verifiedOid: oid, verificationError: null, reviewedOid: null },
  { id: otherRowId, providerId: "microsoft", accountId: oid, verifiedOid: oid, verificationError: null, reviewedOid: null }
]);
assert.equal(collision.ok, false);

const disagreed = planMicrosoftAccountIdentifierMigration([{
  id: rowId, providerId: "microsoft", accountId: subject, verifiedOid: oid, verificationError: null, reviewedOid: "55555555-5555-4555-8555-555555555555"
}]);
assert.equal(disagreed.ok, false);

const failedToken = planMicrosoftAccountIdentifierMigration([{
  id: rowId, providerId: "microsoft-entra-id", accountId: subject, verifiedOid: null, verificationError: "no", reviewedOid: oid
}]);
assert.equal(failedToken.ok, false, "a failed token must not be replaced by a mapping");

const mapped = planMicrosoftAccountIdentifierMigration([{
  id: rowId, providerId: "microsoft", accountId: subject, verifiedOid: null, verificationError: null, reviewedOid: oid
}]);
assert.equal(mapped.ok, true);
assert.equal(mapped.updates[0].oid, oid);

const unproven = planMicrosoftAccountIdentifierMigration([{
  id: rowId, providerId: "microsoft", accountId: subject, verifiedOid: null, verificationError: null, reviewedOid: null
}]);
assert.equal(unproven.ok, false);

assert.throws(() => parseReviewedOidMapping({ source: "email", reviewedBy: "Ada Lovelace", accounts: [] }), /entra-export/);
assert.throws(() => parseReviewedOidMapping({
  source: "entra-export",
  reviewedBy: "Ada Lovelace",
  accounts: [{ accountRowId: rowId, oid, email: "person@example.com" }]
}), /email/);
const parsed = parseReviewedOidMapping({
  source: "entra-export",
  reviewedBy: "Ada Lovelace",
  accounts: [{ accountRowId: rowId, oid }]
});
assert.equal(parsed.get(rowId), oid);

const update = microsoftAccountIdUpdateQuery({
  id: "id", accountId: "accountId", providerId: "providerId", updatedAt: "updatedAt"
}, { id: rowId, providerId: "microsoft", previousAccountId: subject, oid });
assert.match(update.text, /update public\.account set "accountId" = \$1/);
assert.equal(update.values[0], oid);
assert.equal(update.text.includes(oid), false);
assert.equal(update.text.includes(subject), false);

const columnRows = [
  ["id", "NO"], ["accountId", "NO"], ["providerId", "NO"], ["idToken", "YES"], ["updatedAt", "NO"]
].map(([column_name, is_nullable]) => ({ column_name, is_nullable }));

function fakeClient(microsoftRows, extra = {}) {
  const queries = [];
  return {
    queries,
    async query(sql, params) {
      queries.push({ sql, params });
      if (sql.includes("to_regclass")) return { rows: [{ name: extra.missingTable ? null : "account" }] };
      if (sql.includes("lock table")) return { rows: [] };
      if (sql.includes("information_schema.columns")) return { rows: extra.columns || columnRows };
      if (sql.includes("pg_indexes")) return { rows: (extra.indexes || []).map(indexdef => ({ indexdef })) };
      if (sql.includes("having count")) return { rows: extra.duplicateKeys || [] };
      if (sql.includes("any($1::text[])")) {
        assert.deepEqual(params[0], ["microsoft", "microsoft-entra-id"]);
        return { rows: microsoftRows };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    }
  };
}

const empty = fakeClient([]);
const emptyResult = await assertBetterAuth17AccountCutover(empty, {});
assert.equal(emptyResult.microsoftAccounts, 0);
assert.ok(empty.queries.every(query => !/\b(insert|update|delete|truncate|alter|drop)\b/i.test(query.sql)));

const ready = fakeClient([{ id: rowId, provider_id: "microsoft", account_id: oid, id_token: "stored-token" }]);
const readyResult = await assertBetterAuth17AccountCutover(ready, {
  clientId, tenantId, verifyToken: async () => ({ oid })
});
assert.equal(readyResult.aligned, 1);
assert.ok(ready.queries.some(query => /lock table public\.account in share mode/i.test(query.sql)));
assert.ok(ready.queries.every(query => !/\b(insert|update|delete|truncate|alter|drop)\b/i.test(query.sql)));

const stale = fakeClient([{ id: rowId, provider_id: "microsoft", account_id: subject, id_token: "stored-token" }]);
await assert.rejects(() => assertBetterAuth17AccountCutover(stale, {
  clientId, tenantId, verifyToken: async () => ({ oid })
}), /directory object id/);

const reviewed = new Map([[rowId, oid]]);
await assert.rejects(() => assertBetterAuth17AccountCutover(fakeClient([{
  id: rowId, provider_id: "microsoft", account_id: subject, id_token: null
}]), { reviewedByRowId: reviewed }), /directory object id/);
await assert.rejects(() => assertBetterAuth17AccountCutover(fakeClient([{
  id: rowId, provider_id: "microsoft", account_id: subject, id_token: null
}]), {}), /directory object id/);
const proved = await assertBetterAuth17AccountCutover(fakeClient([{
  id: rowId, provider_id: "microsoft", account_id: oid, id_token: null
}]), { reviewedByRowId: reviewed });
assert.equal(proved.aligned, 1);

await assert.rejects(() => assertBetterAuth17AccountCutover(fakeClient([{
  id: rowId, provider_id: "microsoft", account_id: subject, id_token: "stored-token"
}]), { verifyToken: async () => { throw new Error("bad signature"); }, clientId, tenantId }), /could not be verified/);

const missingTable = fakeClient([], { missingTable: true });
assert.deepEqual(await assertBetterAuth17AccountCutover(missingTable, {}), { microsoftAccounts: 0, aligned: 0 });
assert.equal(missingTable.queries.length, 1);

await assert.rejects(() => fetchMicrosoftJwks({ tenantId: "common" }), /directory GUID/);
await assert.rejects(() => fetchMicrosoftJwks({
  tenantId,
  fetchImpl: async (url) => {
    assert.equal(url, `${MICROSOFT_AUTHORITY}/${tenantId}/discovery/v2.0/keys`);
    return { ok: false, status: 503, json: async () => ({}) };
  }
}), /not available/);

const { privateKey, publicKey } = await generateKeyPair("RS256");
const jwk = await exportJWK(publicKey);
jwk.kid = "test-key";
jwk.alg = "RS256";
const issuedAt = Math.floor(Date.now() / 1000) - (60 * 60 * 24 * 30);
async function sign(claims, { audience = clientId, issuer = `${MICROSOFT_AUTHORITY}/${tenantId}/v2.0`, expiresIn = 3600, alg = "RS256" } = {}) {
  return new SignJWT(claims)
    .setProtectedHeader({ alg, kid: "test-key" })
    .setIssuer(issuer)
    .setAudience(audience)
    .setIssuedAt(issuedAt)
    .setExpirationTime(issuedAt + expiresIn)
    .sign(privateKey);
}
const key = createLocalJWKSet({ keys: [jwk] });
const historical = await sign({ oid, tid: tenantId, sub: subject });
const otherTenant = "66666666-6666-4666-8666-666666666666";
const otherDirectory = await sign({ oid, tid: otherTenant, sub: subject }, { issuer: `${MICROSOFT_AUTHORITY}/${otherTenant}/v2.0` });
const missingOid = await sign({ tid: tenantId, sub: subject });
const alreadyExpired = await sign({ oid, tid: tenantId, sub: subject }, { expiresIn: -10 });
assert.equal((await verifyStoredMicrosoftIdToken(historical, { clientId, tenantId: tenantId.toUpperCase(), key })).oid, oid);
await assert.rejects(() => verifyStoredMicrosoftIdToken(historical, { clientId: "wrong-client", tenantId, key }), /signature|audience|claim/i);
await assert.rejects(() => verifyStoredMicrosoftIdToken(otherDirectory, { clientId, tenantId, key }), /iss|claim|directory/);
await assert.rejects(() => verifyStoredMicrosoftIdToken(missingOid, { clientId, tenantId, key }), /directory object id/);
await assert.rejects(() => verifyStoredMicrosoftIdToken(alreadyExpired, { clientId, tenantId, key }), /exp|"exp"|expired/i);
const forged = historical.replace(/^[^.]+/, Buffer.from(JSON.stringify({ alg: "none", kid: "test-key" })).toString("base64url"));
await assert.rejects(() => verifyStoredMicrosoftIdToken(forged, { clientId, tenantId, key }), /RS256|alg|signature/i);

const authSource = await fs.readFile(path.resolve("lib/auth.ts"), "utf8");
assert.match(authSource, /https:\/\/login\.microsoftonline\.com/);
assert.match(authSource, /toLowerCase\(\)/);
assert.match(authSource, /unconfiguredAuthSecret/);
assert.match(authSource, /authRequired\s*\?\s*\{\}/);
for (const tenant of ["common", "organizations", "consumers"]) assert.match(authSource, new RegExp(tenant));
assert.match(authSource, /\[0-9a-f\]\{8\}-\[0-9a-f\]\{4\}-\[1-5\]\[0-9a-f\]\{3\}-\[89ab\]\[0-9a-f\]\{3\}-\[0-9a-f\]\{12\}/);

const authMigrateSource = await fs.readFile(path.resolve("scripts/auth-migrate.mjs"), "utf8");
assert.ok(authMigrateSource.indexOf("assertBetterAuth17AccountCutover") < authMigrateSource.indexOf("getMigrations(migrationAuth.options)"));
assert.ok(authMigrateSource.indexOf("assertBetterAuth17AccountCutover") < authMigrateSource.indexOf("targetClient.query(compiledAuthMigrationSql)"));
assert.doesNotMatch(authMigrateSource, /MICROSOFT_CLIENT_SECRET/);

console.log("Microsoft account cutover checks passed.");
