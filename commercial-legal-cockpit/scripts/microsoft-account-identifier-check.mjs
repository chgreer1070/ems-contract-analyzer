import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ACCOUNT_ID_UPDATE_SQL,
  MICROSOFT_AUTHORITY,
  assessLegacyIssuerSchema,
  executeMicrosoftAccountCutover,
  formatCutoverReport,
  parseEntraExport,
  planMicrosoftAccountIdentifierCutover,
  redactDatabaseUrl,
  verifyStoredMicrosoftIdToken
} from "./microsoft-account-identifier.mjs";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const tenantId = "11111111-1111-4111-8111-111111111111";
const otherTenantId = "99999999-9999-4999-8999-999999999999";
const consumerTenantId = "9188040d-6c67-4c5b-b112-36a304b66dad";
const sub = "22222222-2222-4222-8222-222222222222";
const oid = "33333333-3333-4333-8333-333333333333";
const otherSub = "44444444-4444-4444-8444-444444444444";
const otherOid = "55555555-5555-4555-8555-555555555555";
const audience = "microsoft-client-id";
const issuer = assessLegacyIssuerSchema({ columnPresent: false, nullable: null, uniqueIndexPresent: false });
const jose = createRequire(new URL("../node_modules/better-auth/node_modules/jose/package.json", import.meta.url))("jose");

const { publicKey, privateKey } = await jose.generateKeyPair("RS256");
const jwk = await jose.exportJWK(publicKey);
jwk.kid = "cutover-test";
jwk.alg = "RS256";
jwk.use = "sig";
const jwks = { keys: [jwk] };

async function signToken({ subject = sub, objectId = oid, tenant = tenantId, clientId = audience, issuedAt = Math.floor(Date.now() / 1000) - (30 * 24 * 60 * 60), lifetimeSeconds = 3600, issuerOverride, extra = {} } = {}) {
  const claims = { oid: objectId, tid: tenant, ...extra };
  const tokenIssuer = issuerOverride || `${MICROSOFT_AUTHORITY}/${tenant}/v2.0`;
  return new jose.SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", kid: "cutover-test" })
    .setIssuer(tokenIssuer)
    .setAudience(clientId)
    .setSubject(subject)
    .setIssuedAt(issuedAt)
    .setExpirationTime(issuedAt + lifetimeSeconds)
    .sign(privateKey);
}

const oldToken = await signToken();
const verified = await verifyStoredMicrosoftIdToken(oldToken, { jwks, audience, tenantId });
assert.deepEqual({ sub: verified.sub, oid: verified.oid, tenantId: verified.tenantId }, { sub, oid, tenantId });

await assert.rejects(
  verifyStoredMicrosoftIdToken(await signToken({ clientId: "other-app" }), { jwks, audience, tenantId }),
  (error) => error.code === "id-token-audience"
);
await assert.rejects(
  verifyStoredMicrosoftIdToken(await signToken({ tenant: otherTenantId }), { jwks, audience, tenantId }),
  (error) => error.code === "id-token-issuer"
);
await assert.rejects(
  verifyStoredMicrosoftIdToken(await signToken({ tenant: consumerTenantId }), { jwks, audience, tenantId: "organizations" }),
  (error) => error.code === "id-token-issuer"
);
await assert.rejects(
  verifyStoredMicrosoftIdToken(await signToken({ extra: { oid: "" } }), { jwks, audience, tenantId }),
  (error) => error.code === "id-token-identity"
);
const noneHeader = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
const noneBody = Buffer.from(JSON.stringify({ sub, oid, tid: tenantId, iss: `${MICROSOFT_AUTHORITY}/${tenantId}/v2.0`, aud: audience, iat: 1_700_000_000, exp: 1_700_003_600 })).toString("base64url");
await assert.rejects(
  verifyStoredMicrosoftIdToken(`${noneHeader}.${noneBody}.`, { jwks, audience, tenantId }),
  (error) => error.code === "id-token-signature" || error.code === "id-token-rejected"
);

const blockedIssuer = assessLegacyIssuerSchema({ columnPresent: true, nullable: false, uniqueIndexPresent: false });
assert.equal(blockedIssuer.ok, false);
assert.equal(assessLegacyIssuerSchema({ columnPresent: true, nullable: true, uniqueIndexPresent: true }).ok, false);
assert.equal(assessLegacyIssuerSchema({ columnPresent: false, nullable: null, uniqueIndexPresent: false }).code, "no-issuer-column");

assert.throws(
  () => parseEntraExport({ source: "entra-export", accounts: [{ providerId: "microsoft", sub, oid, email: "person@example.com" }] }),
  (error) => error.code === "export-invalid" && /email/i.test(error.message)
);
const exportAccounts = parseEntraExport({ source: "entra-export", accounts: [{ providerId: "microsoft", sub, oid }] });

function plan(overrides = {}) {
  return planMicrosoftAccountIdentifierCutover({
    rows: [{ id: "row-1", providerId: "microsoft", accountId: sub, userId: "user-1", email: "person@example.com" }],
    issuer,
    ...overrides
  });
}

const tokenPlan = plan({ verifiedTokens: [{ accountRowId: "row-1", sub, oid, tenantId }] });
assert.equal(tokenPlan.applicable, true);
assert.equal(tokenPlan.updates.length, 1);
assert.equal(tokenPlan.updates[0].toAccountId, oid);
assert.equal(tokenPlan.updates[0].source, "verified-id-token");
assert.equal(JSON.stringify(tokenPlan).includes("person@example.com"), false, "email must not become an account identifier");

const alreadyOid = plan({
  rows: [{ id: "row-1", providerId: "microsoft", accountId: oid, userId: "user-1" }],
  verifiedTokens: [{ accountRowId: "row-1", sub, oid, tenantId }]
});
assert.equal(alreadyOid.applicable, true);
assert.equal(alreadyOid.updates.length, 0);
assert.equal(alreadyOid.alreadyCurrent.length, 1);

const exportPlan = plan({ entraExport: exportAccounts });
assert.equal(exportPlan.applicable, true);
assert.equal(exportPlan.updates[0].source, "entra-export");
assert.equal(exportPlan.updates[0].toAccountId, oid);

const unresolved = plan();
assert.equal(unresolved.applicable, false);
assert.equal(unresolved.errors[0].code, "unresolved");

const disagreement = plan({
  verifiedTokens: [{ accountRowId: "row-1", sub, oid, tenantId }],
  entraExport: [{ providerId: "microsoft", sub, oid: otherOid }]
});
assert.equal(disagreement.applicable, false);
assert.equal(disagreement.errors.some((error) => error.code === "export-disagrees"), true);

const genericProvider = planMicrosoftAccountIdentifierCutover({
  rows: [{ id: "row-2", providerId: "microsoft-entra-id", accountId: otherSub, userId: "user-2" }],
  verifiedTokens: [{ accountRowId: "row-2", sub: otherSub, oid: otherOid, tenantId }],
  issuer
});
assert.equal(genericProvider.applicable, true);
assert.equal(genericProvider.updates[0].providerId, "microsoft-entra-id");
assert.equal(genericProvider.updates[0].toAccountId, otherOid);

const collision = planMicrosoftAccountIdentifierCutover({
  rows: [
    { id: "row-1", providerId: "microsoft", accountId: sub, userId: "user-1" },
    { id: "row-2", providerId: "microsoft", accountId: otherSub, userId: "user-2" }
  ],
  verifiedTokens: [
    { accountRowId: "row-1", sub, oid, tenantId },
    { accountRowId: "row-2", sub: otherSub, oid, tenantId }
  ],
  issuer
});
assert.equal(collision.applicable, false);
assert.equal(collision.errors.some((error) => error.code === "collision"), true);

const mismatched = plan({ verifiedTokens: [{ accountRowId: "row-1", sub: otherSub, oid, tenantId }] });
assert.equal(mismatched.errors.some((error) => error.code === "identity-mismatch"), true);
assert.equal(redactDatabaseUrl("connect failed postgresql://migrator:secret@db.example/contracttwin"), "connect failed [database]");
assert.doesNotMatch(ACCOUNT_ID_UPDATE_SQL, /userId|email|idToken|issuer/u);
assert.match(ACCOUNT_ID_UPDATE_SQL, /set "accountId" = \$1/u);

const requiredColumns = [
  ["id", "NO"], ["accountId", "NO"], ["providerId", "NO"], ["userId", "NO"], ["idToken", "YES"], ["updatedAt", "NO"]
].map(([column_name, is_nullable]) => ({ column_name, is_nullable }));

function fakeClient(state) {
  const queries = [];
  let reads = 0;
  return {
    queries,
    async query(sql, params) {
      const text = String(sql).trim();
      queries.push(text);
      if (text === "begin" || text.startsWith("begin ") || text === "commit" || text === "rollback") return { rows: [], rowCount: 0 };
      if (text.includes("to_regclass")) return { rows: [{ relation_name: state.table === false ? null : "account" }] };
      if (text.includes("information_schema.columns")) return { rows: state.columns || requiredColumns };
      if (text.includes("account_issuer_accountId_uidx")) return { rows: state.issuerIndex ? [{ index_name: "account_issuer_accountId_uidx" }] : [] };
      if (text.includes("having count(*)")) return { rows: state.duplicates || [] };
      if (text.includes(`from "account" where`)) {
        reads += 1;
        const rows = reads > 1 && state.secondRead ? state.secondRead : state.rows;
        return { rows };
      }
      if (text === ACCOUNT_ID_UPDATE_SQL) {
        state.updated.push(params);
        return { rows: [], rowCount: state.updateRowCount ?? 1 };
      }
      throw new Error(`Unexpected SQL: ${text}`);
    }
  };
}

const storedToken = "stored-id-token-must-not-be-printed";
const client = fakeClient({
  rows: [{ id: "row-1", providerId: "microsoft", accountId: sub, userId: "user-1", idToken: storedToken }],
  updated: []
});
const applied = await executeMicrosoftAccountCutover({
  mode: "apply",
  client,
  pausedSignInConfirmed: true,
  audience,
  tenantId,
  verifyToken: async () => ({ sub, oid, tenantId }),
  loadJwks: async () => jwks
});
assert.equal(applied.applied, true);
assert.equal(applied.updatedCount, 1);
assert.deepEqual(client.queries.filter((sql) => sql === ACCOUNT_ID_UPDATE_SQL).length, 1);
assert.deepEqual(applied.updates[0].toAccountId, oid);
assert.equal(JSON.stringify(applied).includes(storedToken), false);
assert.equal(formatCutoverReport(applied).includes(storedToken), false);
assert.equal(client.queries.some((sql) => /^\s*(?:delete|drop|alter)\b/iu.test(sql)), false);
assert.equal(client.queries.some((sql) => sql.startsWith("update") && /userId|email|idToken|issuer/u.test(sql)), false);

const refused = fakeClient({ rows: [], updated: [] });
await assert.rejects(
  executeMicrosoftAccountCutover({ mode: "apply", client: refused, pausedSignInConfirmed: false, tenantId }),
  (error) => error.code === "sign-in-not-paused"
);
assert.equal(refused.queries.length, 0);

const unresolvedClient = fakeClient({
  rows: [{ id: "row-1", providerId: "microsoft", accountId: sub, userId: "user-1", idToken: "" }],
  updated: []
});
const inventory = await executeMicrosoftAccountCutover({
  mode: "inventory",
  client: unresolvedClient,
  tenantId,
  verifyToken: async () => { throw new Error("no token"); },
  loadJwks: async () => { throw new Error("keys not needed"); }
});
assert.equal(inventory.applicable, false);
assert.equal(unresolvedClient.queries.some((sql) => sql.startsWith("update")), false);

const staleState = {
  rows: [{ id: "row-1", providerId: "microsoft", accountId: sub, userId: "user-1", idToken: storedToken }],
  secondRead: [{ id: "row-1", providerId: "microsoft", accountId: oid, userId: "user-1", idToken: storedToken }],
  updated: []
};
await assert.rejects(
  executeMicrosoftAccountCutover({
    mode: "apply",
    client: fakeClient(staleState),
    pausedSignInConfirmed: true,
    audience,
    tenantId,
    verifyToken: async () => ({ sub, oid, tenantId }),
    loadJwks: async () => jwks
  }),
  (error) => error.code === "cutover-stale"
);
assert.equal(staleState.updated.length, 0);

const issuerClient = fakeClient({
  columns: [...requiredColumns, { column_name: "issuer", is_nullable: "NO" }],
  rows: [{ id: "row-1", providerId: "microsoft", accountId: sub, userId: "user-1", idToken: "" }],
  updated: []
});
const issuerResult = await executeMicrosoftAccountCutover({ mode: "inventory", client: issuerClient, tenantId });
assert.equal(issuerResult.applicable, false);
assert.equal(issuerResult.errors.some((error) => error.code === "issuer-not-null"), true);

const packageJson = JSON.parse(readFileSync(path.join(packageRoot, "package.json"), "utf8"));
assert.equal(packageJson.dependencies["better-auth"], "1.7.14");
const lockfile = readFileSync(path.join(packageRoot, "package-lock.json"), "utf8");
assert.equal(lockfile.includes("better-auth-1.6.25"), false);
assert.equal(lockfile.includes("@better-auth/core-1.6.25"), false);
assert.equal(lockfile.includes("better-auth-1.7.14"), true);
const authSource = readFileSync(path.join(packageRoot, "lib/auth.ts"), "utf8");
assert.match(authSource, /MICROSOFT_ACCOUNT_IDENTIFIER !== "oid"/u);
assert.match(authSource, /https:\/\/login\.microsoftonline\.com/u);
assert.doesNotMatch(authSource, /mapProfileToUser|accountSubject/u);
const authMigrate = readFileSync(path.join(packageRoot, "scripts/auth-migrate.mjs"), "utf8");
assert.match(authMigrate, /must not rewrite those ids/u);
assert.doesNotMatch(authMigrate, /microsoft-account-identifier/u);
const environmentGate = readFileSync(path.join(packageRoot, "scripts/production-env-check.mjs"), "utf8");
assert.match(environmentGate, /\["MICROSOFT_ACCOUNT_IDENTIFIER", "oid"\]/u);
const releaseHealth = readFileSync(path.join(packageRoot, "app/api/health/release/route.ts"), "utf8");
assert.match(releaseHealth, /MICROSOFT_ACCOUNT_IDENTIFIER==="oid"/u);
const example = readFileSync(path.join(packageRoot, ".env.example"), "utf8");
assert.match(example, /MICROSOFT_ACCOUNT_IDENTIFIER=oid/u);
assert.match(example, /paused/iu);

const paused = spawnSync(process.execPath, ["scripts/microsoft-account-identifier-cutover.mjs", "apply"], {
  cwd: packageRoot,
  encoding: "utf8",
  env: { ...process.env, DATABASE_URL: "", APP_ENV: "test" }
});
assert.notEqual(paused.status, 0);
assert.match(`${paused.stderr}`, /confirm-paused-microsoft-sign-in/u);
assert.doesNotMatch(`${paused.stdout}${paused.stderr}`, /stored-id-token|eyJ/u);

const missingDatabase = spawnSync(process.execPath, ["scripts/microsoft-account-identifier-cutover.mjs", "inventory"], {
  cwd: packageRoot,
  encoding: "utf8",
  env: { ...process.env, DATABASE_URL: "", APP_ENV: "test" }
});
assert.notEqual(missingDatabase.status, 0);
assert.match(`${missingDatabase.stderr}`, /DATABASE_URL is required/u);

console.log("Microsoft account identifier checks passed: expired tokens stay signature-checked, email cannot choose an account, and the schema migrator does not rewrite ids.");
