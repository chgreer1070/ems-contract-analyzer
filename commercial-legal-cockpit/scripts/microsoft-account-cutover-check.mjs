import assert from "node:assert/strict";
import {
  ACCOUNT_ISSUER_INDEX,
  ISSUER_CLEANUP_SQL,
  applyMicrosoftAccountCutover,
  issuerSchemaBlocker,
  microsoftSigningKey,
  migrationPlanAddsAccountIssuer,
  parseMicrosoftAccountExport,
  planMicrosoftAccountCutover,
  verifyStoredMicrosoftIdToken
} from "./microsoft-account-cutover.mjs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { SignJWT, generateKeyPair } = createRequire(require.resolve("better-auth"))("jose");

const tenantId = "11111111-1111-4111-8111-111111111111";
const clientId = "22222222-2222-4222-8222-222222222222";
const oid = "aaaaaaaa-1111-4111-8111-111111111111";
const otherOid = "44444444-4444-4444-8444-444444444444";
const issuer = `https://login.microsoftonline.com/${tenantId}/v2.0`;
const { publicKey, privateKey } = await generateKeyPair("RS256");

async function token(claims, options = {}) {
  const builder = new SignJWT({ tid: tenantId, oid, sub: "pairwise-sub", ...claims })
    .setProtectedHeader({ alg: "RS256", kid: "test-key", ...options.header })
    .setIssuer(options.issuer || issuer)
    .setAudience(options.audience || clientId)
    .setIssuedAt(options.issuedAt || Math.floor(Date.now() / 1000) - 7200)
    .setExpirationTime(options.expirationTime || Math.floor(Date.now() / 1000) - 3600);
  return builder.sign(privateKey);
}

const resolveKey = async (header) => {
  if (header.kid !== "test-key") {
    const error = new Error("The token signing key is no longer in the current Microsoft key set.");
    error.name = "UnverifiableMicrosoftTokenError";
    throw error;
  }
  return publicKey;
};

const verified = await verifyStoredMicrosoftIdToken(await token(), { tenantId, clientId, resolveKey });
assert.equal(verified.ok, true, "an expired but signed Microsoft token still proves the directory object id");
assert.equal(verified.oid, oid);
assert.equal(verified.sub, "pairwise-sub");

const wrongAudience = await verifyStoredMicrosoftIdToken(await token({}, { audience: otherOid }), { tenantId, clientId, resolveKey });
assert.equal(wrongAudience.kind, "rejected");
const wrongIssuer = await verifyStoredMicrosoftIdToken(
  await token({}, { issuer: `https://login.microsoftonline.com/${otherOid}/v2.0` }),
  { tenantId, clientId, resolveKey }
);
assert.equal(wrongIssuer.kind, "rejected");
const missingOid = await verifyStoredMicrosoftIdToken(await token({ oid: "" }), { tenantId, clientId, resolveKey });
assert.equal(missingOid.kind, "rejected");
const tampered = `${await token()}x`;
const badSignature = await verifyStoredMicrosoftIdToken(tampered, { tenantId, clientId, resolveKey });
assert.equal(badSignature.kind, "rejected");
const missing = await verifyStoredMicrosoftIdToken(null, { tenantId, clientId, resolveKey });
assert.equal(missing.kind, "unverifiable");
const encrypted = await verifyStoredMicrosoftIdToken("$ba$not-a-token", { tenantId, clientId, resolveKey });
assert.equal(encrypted.kind, "unverifiable");

const rewrite = planMicrosoftAccountCutover({
  rows: [{ id: "account-1", providerId: "microsoft", accountId: "pairwise-sub" }],
  decisions: new Map([["account-1", verified]]),
  exportAccounts: null
});
assert.equal(rewrite.ok, true);
assert.deepEqual(rewrite.updates, [{
  id: "account-1",
  providerId: "microsoft",
  from: "pairwise-sub",
  to: oid,
  evidence: "verified-id-token"
}]);

const alreadyMigrated = planMicrosoftAccountCutover({
  rows: [{ id: "account-1", providerId: "microsoft-entra-id", accountId: oid }],
  decisions: new Map([["account-1", verified]]),
  exportAccounts: null
});
assert.equal(alreadyMigrated.ok, true);
assert.equal(alreadyMigrated.updates.length, 0);
assert.equal(alreadyMigrated.confirmed.length, 1);
const caseNormalized = planMicrosoftAccountCutover({
  rows: [{ id: "account-1", providerId: "microsoft", accountId: oid.toUpperCase() }],
  decisions: new Map([["account-1", verified]]),
  exportAccounts: null
});
assert.equal(caseNormalized.ok, true);
assert.equal(caseNormalized.updates[0].to, oid);
assert.equal(caseNormalized.updates[0].from, oid.toUpperCase());

const contradicted = planMicrosoftAccountCutover({
  rows: [{ id: "account-1", providerId: "microsoft", accountId: "pairwise-sub" }],
  decisions: new Map([["account-1", wrongAudience]]),
  exportAccounts: [{ id: "account-1", previousAccountId: "pairwise-sub", oid }]
});
assert.equal(contradicted.ok, false);
assert.match(contradicted.errors.join(" "), /cannot override/);

const exported = planMicrosoftAccountCutover({
  rows: [{ id: "account-1", providerId: "microsoft", accountId: "pairwise-sub" }],
  decisions: new Map([["account-1", missing]]),
  exportAccounts: [{ id: "account-1", previousAccountId: "pairwise-sub", oid }]
});
assert.equal(exported.ok, true);
assert.equal(exported.updates[0].evidence, "entra-export");
assert.equal(exported.updates[0].to, oid);
const uppercaseExport = planMicrosoftAccountCutover({
  rows: [{ id: "account-1", providerId: "microsoft", accountId: "pairwise-sub" }],
  decisions: new Map([["account-1", missing]]),
  exportAccounts: [{ id: "account-1", previousAccountId: "pairwise-sub", oid: oid.toUpperCase() }]
});
assert.equal(uppercaseExport.ok, true);
assert.equal(uppercaseExport.updates[0].to, oid);
const alreadyLowercase = planMicrosoftAccountCutover({
  rows: [{ id: "account-2", providerId: "microsoft", accountId: oid }],
  decisions: new Map([["account-2", missing]]),
  exportAccounts: [{ id: "account-2", previousAccountId: "old-subject", oid: oid.toUpperCase() }]
});
assert.equal(alreadyLowercase.ok, true);
assert.equal(alreadyLowercase.updates.length, 0);
assert.equal(alreadyLowercase.confirmed.length, 1);

const missingExport = planMicrosoftAccountCutover({
  rows: [{ id: "account-1", providerId: "microsoft", accountId: "pairwise-sub" }],
  decisions: new Map([["account-1", missing]]),
  exportAccounts: null
});
assert.equal(missingExport.ok, false);
assert.match(missingExport.errors.join(" "), /Pause Microsoft sign-in/);

const collision = planMicrosoftAccountCutover({
  rows: [
    { id: "account-1", providerId: "microsoft", accountId: "pairwise-sub" },
    { id: "account-2", providerId: "microsoft", accountId: oid }
  ],
  decisions: new Map([
    ["account-1", verified],
    ["account-2", { ok: true, oid, sub: "other-sub", tid: tenantId }]
  ]),
  exportAccounts: null
});
assert.equal(collision.ok, false);
assert.match(collision.errors.join(" "), /share one microsoft object id/);

const unknownSubject = planMicrosoftAccountCutover({
  rows: [{ id: "account-1", providerId: "microsoft", accountId: "not-the-subject" }],
  decisions: new Map([["account-1", verified]]),
  exportAccounts: null
});
assert.equal(unknownSubject.ok, false);

assert.equal(issuerSchemaBlocker([], []), null);
assert.match(issuerSchemaBlocker([{ name: "issuer", nullable: false }], []), /DROP NOT NULL/);
assert.match(issuerSchemaBlocker([{ name: "issuer", nullable: true }], [ACCOUNT_ISSUER_INDEX]), new RegExp(ACCOUNT_ISSUER_INDEX));
assert.match(ISSUER_CLEANUP_SQL, /public\."account_issuer_accountId_uidx"/);
assert.equal(migrationPlanAddsAccountIssuer([{ table: "account", fields: { issuer: {} } }]), true);
assert.equal(migrationPlanAddsAccountIssuer([{ table: "account", fields: { accountId: {} } }]), false);

const parsed = parseMicrosoftAccountExport(JSON.stringify({
  tenantId: tenantId.toUpperCase(),
  accounts: [{ id: "account-1", previousAccountId: "pairwise-sub", oid }]
}), tenantId);
assert.equal(parsed[0].id, "account-1");
assert.throws(() => parseMicrosoftAccountExport('{"tenantId":"99999999-9999-4999-8999-999999999999","accounts":[]}', tenantId), /different tenant/);
assert.throws(() => parseMicrosoftAccountExport("{", tenantId), /not valid JSON/);
assert.equal(parseMicrosoftAccountExport("  ", tenantId), null);

function queryClient(handlers) {
  const calls = [];
  return {
    calls,
    async query(sql, params = []) {
      calls.push({ sql, params });
      const handler = handlers.find((candidate) => candidate.pattern.test(sql));
      if (!handler) throw new Error(`Unexpected SQL: ${sql}`);
      return handler.answer(params);
    }
  };
}

const emptyClient = queryClient([
  { pattern: /information_schema/, answer: () => ({ rows: [] }) },
  { pattern: /pg_indexes/, answer: () => ({ rows: [] }) },
  { pattern: /having count/, answer: () => ({ rows: [] }) },
  { pattern: /for update/, answer: () => ({ rows: [] }) }
]);
const emptyResult = await applyMicrosoftAccountCutover(emptyClient, {});
assert.match(emptyResult.summary, /no Microsoft account rows/);
assert.equal(emptyClient.calls.some((call) => call.sql.startsWith("update ")), false);

const blockedClient = queryClient([
  { pattern: /information_schema/, answer: () => ({ rows: [{ name: "issuer", nullable: false }] }) },
  { pattern: /pg_indexes/, answer: () => ({ rows: [] }) }
]);
await assert.rejects(applyMicrosoftAccountCutover(blockedClient, {}), /will not drop or rewrite that column/);
assert.equal(blockedClient.calls.length, 2);

const signedToken = await token();
const rewriteClient = queryClient([
  { pattern: /information_schema/, answer: () => ({ rows: [] }) },
  { pattern: /pg_indexes/, answer: () => ({ rows: [] }) },
  { pattern: /having count/, answer: () => ({ rows: [] }) },
  {
    pattern: /for update/,
    answer: () => ({ rows: [{ id: "account-1", provider_id: "microsoft", account_id: "pairwise-sub", id_token: signedToken }] })
  },
  { pattern: /^update public\.account/, answer: () => ({ rowCount: 1 }) }
]);
const rewritten = await applyMicrosoftAccountCutover(rewriteClient, {
  MICROSOFT_TENANT_ID: tenantId,
  MICROSOFT_CLIENT_ID: clientId
}, { resolveKey });
assert.equal(rewritten.updates.length, 1);
const updateCall = rewriteClient.calls.find((call) => call.sql.startsWith("update "));
assert.deepEqual(updateCall.params, [oid, "account-1", "microsoft", "pairwise-sub"]);
assert.equal(updateCall.sql.includes(signedToken), false);
assert.equal(rewriteClient.calls.filter((call) => /having count/.test(call.sql)).length, 2);

const missingTenantClient = queryClient([
  { pattern: /information_schema/, answer: () => ({ rows: [] }) },
  { pattern: /pg_indexes/, answer: () => ({ rows: [] }) },
  { pattern: /having count/, answer: () => ({ rows: [] }) },
  {
    pattern: /for update/,
    answer: () => ({ rows: [{ id: "account-1", provider_id: "microsoft", account_id: "pairwise-sub", id_token: signedToken }] })
  }
]);
await assert.rejects(applyMicrosoftAccountCutover(missingTenantClient, {}), /MICROSOFT_TENANT_ID is required/);
assert.equal(missingTenantClient.calls.some((call) => call.sql.startsWith("update ")), false);

const partialClient = queryClient([
  { pattern: /information_schema/, answer: () => ({ rows: [] }) },
  { pattern: /pg_indexes/, answer: () => ({ rows: [] }) },
  { pattern: /having count/, answer: () => ({ rows: [] }) },
  {
    pattern: /for update/,
    answer: () => ({ rows: [{ id: "account-1", provider_id: "microsoft", account_id: "pairwise-sub", id_token: signedToken }] })
  },
  { pattern: /^update public\.account/, answer: () => ({ rowCount: 0 }) }
]);
await assert.rejects(
  applyMicrosoftAccountCutover(partialClient, { MICROSOFT_TENANT_ID: tenantId, MICROSOFT_CLIENT_ID: clientId }, { resolveKey }),
  /No partial cutover was committed/
);

const originalFetch = globalThis.fetch;
const emptyKeyTenant = "55555555-5555-4555-8555-555555555555";
globalThis.fetch = async () => ({ ok: true, json: async () => ({ keys: [] }) });
try {
  await assert.rejects(microsoftSigningKey({ alg: "RS256", kid: "missing" }, emptyKeyTenant), /incomplete/);
} finally {
  globalThis.fetch = originalFetch;
}
const invalidKeyTenant = "66666666-6666-4666-8666-666666666666";
globalThis.fetch = async () => ({ ok: true, json: async () => { throw new SyntaxError("not json"); } });
try {
  await assert.rejects(microsoftSigningKey({ alg: "RS256", kid: "missing" }, invalidKeyTenant), /not valid JSON/);
} finally {
  globalThis.fetch = originalFetch;
}

console.log("Microsoft account cutover checks passed.");
