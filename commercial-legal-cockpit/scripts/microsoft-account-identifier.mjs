import { createHash } from "node:crypto";
import { createRequire } from "node:module";

// Better Auth 1.7 identifies Microsoft accounts by the Entra directory object
// id (`oid`). Version 1.6 stored the app-specific subject (`sub`). These are
// different ids for the same person. This module plans that rewrite. It does
// not guess an object id from an email address, and the schema migrator must
// not call it: a partial rewrite creates duplicate accounts.

export const MICROSOFT_AUTHORITY = "https://login.microsoftonline.com";
export const MICROSOFT_PROVIDER_IDS = Object.freeze(["microsoft", "microsoft-entra-id"]);
export const MICROSOFT_CONSUMER_TENANT_ID = "9188040d-6c67-4c5b-b112-36a304b66dad";
export const ACCOUNT_ID_UPDATE_SQL = `update "account" set "accountId" = $1, "updatedAt" = statement_timestamp() where "id" = $2 and "providerId" = $3 and "accountId" = $4`;
const DIRECTORY_GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const MULTI_TENANT = new Set(["common", "organizations", "consumers"]);
const REQUIRED_ACCOUNT_COLUMNS = ["id", "accountId", "providerId", "userId", "idToken", "updatedAt"];
const EXPORT_KEYS = new Set(["providerId", "sub", "oid"]);
const MAX_MICROSOFT_ROWS = 10_000;

export function redactDatabaseUrl(message) {
  return String(message).replace(/postgres(?:ql)?:\/\/\S+/giu, "[database]");
}

export class MicrosoftAccountIdentifierError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "MicrosoftAccountIdentifierError";
    this.code = code;
  }
}

export function normalizeDirectoryGuid(value) {
  return typeof value === "string" && DIRECTORY_GUID.test(value) ? value.toLowerCase() : null;
}

export function classifyMicrosoftTenant(tenantId) {
  if (typeof tenantId !== "string" || tenantId.trim() !== tenantId || tenantId.length === 0) return null;
  const lowered = tenantId.toLowerCase();
  if (MULTI_TENANT.has(lowered)) return { kind: lowered, guid: null };
  const guid = normalizeDirectoryGuid(tenantId);
  if (!guid) return null;
  return { kind: "tenant", guid };
}

export function assessLegacyIssuerSchema({ columnPresent, nullable, uniqueIndexPresent }) {
  if (uniqueIndexPresent) {
    return {
      ok: false,
      code: "issuer-index",
      message: "The account table still has the Better Auth 1.7.0–1.7.2 issuer unique index. Drop that index before signing anyone in on 1.7.14. This cutover does not drop indexes."
    };
  }
  if (columnPresent && nullable === false) {
    return {
      ok: false,
      code: "issuer-not-null",
      message: "The account table still requires the issuer column added by Better Auth 1.7.0–1.7.2. Make that column optional before using 1.7.14. This cutover does not change table shape."
    };
  }
  if (columnPresent) {
    return {
      ok: true,
      code: "issuer-nullable",
      message: "A leftover issuer column is optional. Better Auth 1.7.14 does not write it. Microsoft identity still has to move from sub to oid."
    };
  }
  return {
    ok: true,
    code: "no-issuer-column",
    message: "The account table has no issuer column. That matches a database that went from Better Auth 1.6 straight to 1.7.14."
  };
}

export function parseEntraExport(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new MicrosoftAccountIdentifierError("export-invalid", "The Entra export must be an object with an accounts list.");
  }
  if (value.source !== "entra-export") {
    throw new MicrosoftAccountIdentifierError("export-invalid", "The Entra export source must be entra-export. This file is operator-supplied; it is not checked against Microsoft.");
  }
  if (!Array.isArray(value.accounts)) {
    throw new MicrosoftAccountIdentifierError("export-invalid", "The Entra export must include an accounts list.");
  }
  const accounts = [];
  const seenSubjects = new Set();
  const seenObjects = new Set();
  for (const [index, record] of value.accounts.entries()) {
    if (!record || typeof record !== "object" || Array.isArray(record)) {
      throw new MicrosoftAccountIdentifierError("export-invalid", `Entra export record ${index + 1} is not an object.`);
    }
    const keys = Object.keys(record);
    if (keys.some((key) => !EXPORT_KEYS.has(key)) || EXPORT_KEYS.size !== keys.length) {
      throw new MicrosoftAccountIdentifierError("export-invalid", `Entra export record ${index + 1} may contain only providerId, sub, and oid. Email and other profile fields are not accepted.`);
    }
    if (!MICROSOFT_PROVIDER_IDS.includes(record.providerId)) {
      throw new MicrosoftAccountIdentifierError("export-invalid", `Entra export record ${index + 1} is not a Microsoft provider.`);
    }
    const sub = normalizeDirectoryGuid(record.sub);
    const oid = normalizeDirectoryGuid(record.oid);
    if (!sub || !oid) {
      throw new MicrosoftAccountIdentifierError("export-invalid", `Entra export record ${index + 1} needs directory-id values for sub and oid.`);
    }
    const subjectKey = `${record.providerId}\u0000${sub}`;
    const objectKey = `${record.providerId}\u0000${oid}`;
    if (seenSubjects.has(subjectKey) || seenObjects.has(objectKey)) {
      throw new MicrosoftAccountIdentifierError("export-invalid", "The Entra export repeats a subject or object id.");
    }
    seenSubjects.add(subjectKey);
    seenObjects.add(objectKey);
    accounts.push({ providerId: record.providerId, sub: record.sub, oid: record.oid });
  }
  return accounts;
}

function sameDirectoryId(left, right) {
  const normalizedLeft = normalizeDirectoryGuid(left);
  const normalizedRight = normalizeDirectoryGuid(right);
  return Boolean(normalizedLeft && normalizedRight && normalizedLeft === normalizedRight);
}

function tokenFingerprint(idToken) {
  if (typeof idToken !== "string" || idToken.length === 0) return "";
  return createHash("sha256").update(idToken, "utf8").digest("hex");
}

function loadBetterAuthJose() {
  const josePackage = new URL("../node_modules/better-auth/node_modules/jose/package.json", import.meta.url);
  return createRequire(josePackage)("jose");
}

function expectedIssuer(authority, tenant) {
  return `${authority}/${tenant.guid}/v2.0`;
}

function claimsMatchTenant(payload, authority, tenant) {
  const tid = normalizeDirectoryGuid(payload?.tid);
  if (!tid || payload.iss !== `${authority}/${tid}/v2.0`) return false;
  if (tenant.kind === "tenant" && tid !== tenant.guid) return false;
  if (tenant.kind === "organizations" && tid === MICROSOFT_CONSUMER_TENANT_ID) return false;
  if (tenant.kind === "consumers" && tid !== MICROSOFT_CONSUMER_TENANT_ID) return false;
  return true;
}

export async function verifyStoredMicrosoftIdToken(idToken, { jwks, audience, tenantId, authority = MICROSOFT_AUTHORITY }) {
  const tenant = classifyMicrosoftTenant(tenantId);
  if (!tenant) {
    throw new MicrosoftAccountIdentifierError("tenant-invalid", "MICROSOFT_TENANT_ID must be one directory id, or common, organizations, or consumers.");
  }
  if (authority !== MICROSOFT_AUTHORITY) {
    throw new MicrosoftAccountIdentifierError("authority-invalid", "Microsoft token checks use https://login.microsoftonline.com, the same authority as sign-in.");
  }
  if (typeof audience !== "string" || audience.trim().length === 0) {
    throw new MicrosoftAccountIdentifierError("audience-missing", "MICROSOFT_CLIENT_ID is required to check a stored Microsoft sign-in token.");
  }
  if (typeof idToken !== "string" || idToken.trim().length === 0) {
    throw new MicrosoftAccountIdentifierError("id-token-missing", "There is no stored Microsoft sign-in token for this account.");
  }
  const jose = loadBetterAuthJose();
  let unverified;
  try {
    unverified = jose.decodeJwt(idToken);
  } catch {
    throw new MicrosoftAccountIdentifierError("id-token-rejected", "The stored Microsoft sign-in token could not be read.");
  }
  if (typeof unverified.iat !== "number" || !Number.isFinite(unverified.iat)) {
    throw new MicrosoftAccountIdentifierError("id-token-rejected", "The stored Microsoft sign-in token has no issue time.");
  }
  const keyStore = jwks && Array.isArray(jwks.keys) ? jose.createLocalJWKSet(jwks) : jwks;
  if (!keyStore) {
    throw new MicrosoftAccountIdentifierError("jwks-unavailable", "Microsoft signing keys are required to check a stored sign-in token.");
  }
  const verifyOptions = {
    algorithms: ["RS256"],
    audience,
    currentDate: new Date(unverified.iat * 1000),
    clockTolerance: "60s"
  };
  if (tenant.kind === "tenant") verifyOptions.issuer = expectedIssuer(authority, tenant);
  let payload;
  try {
    payload = (await jose.jwtVerify(idToken, keyStore, verifyOptions)).payload;
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
    if (code === "ERR_JWS_SIGNATURE_VERIFICATION_FAILED" || code === "ERR_JOSE_ALG_NOT_ALLOWED" || code === "ERR_JOSE_NOT_SUPPORTED" || code === "ERR_JWS_INVALID") {
      throw new MicrosoftAccountIdentifierError("id-token-signature", "The stored Microsoft sign-in token signature was rejected.");
    }
    const claim = error && typeof error === "object" && "claim" in error ? String(error.claim) : "";
    if (claim === "iss") throw new MicrosoftAccountIdentifierError("id-token-issuer", "The stored Microsoft sign-in token issuer does not match the configured directory.");
    if (claim === "aud") throw new MicrosoftAccountIdentifierError("id-token-audience", "The stored Microsoft sign-in token was not issued for this application.");
    throw new MicrosoftAccountIdentifierError("id-token-rejected", "The stored Microsoft sign-in token was rejected.");
  }
  if (!claimsMatchTenant(payload, authority, tenant)) {
    throw new MicrosoftAccountIdentifierError("id-token-issuer", "The stored Microsoft sign-in token tenant does not match the configured directory.");
  }
  const sub = typeof payload.sub === "string" ? payload.sub : "";
  const oid = typeof payload.oid === "string" ? payload.oid : "";
  if (!normalizeDirectoryGuid(sub) || !normalizeDirectoryGuid(oid)) {
    throw new MicrosoftAccountIdentifierError("id-token-identity", "The stored Microsoft sign-in token did not include directory ids for both sub and oid.");
  }
  return { sub, oid, tenantId: normalizeDirectoryGuid(payload.tid) };
}

function rememberFinalKey(finalKeys, providerId, accountId, rowId) {
  const normalized = normalizeDirectoryGuid(accountId);
  if (!normalized) return;
  const key = `${providerId}\u0000${normalized}`;
  const holders = finalKeys.get(key) || [];
  holders.push(rowId);
  finalKeys.set(key, holders);
}

export function planMicrosoftAccountIdentifierCutover({
  rows,
  verifiedTokens = [],
  entraExport = null,
  tokenErrors = [],
  existingDuplicates = [],
  issuer
}) {
  const errors = [];
  const updates = [];
  const alreadyCurrent = [];
  const finalKeys = new Map();
  const tokenErrorById = new Map(tokenErrors.map((error) => [error.accountRowId, error]));
  const verifiedById = new Map();
  for (const token of verifiedTokens) {
    if (verifiedById.has(token.accountRowId)) {
      errors.push({ id: token.accountRowId, code: "duplicate-verification", message: "The same account was checked more than once." });
    }
    verifiedById.set(token.accountRowId, token);
  }

  if (!issuer?.ok) {
    errors.push({ id: null, code: issuer?.code || "issuer-schema", message: issuer?.message || "The account issuer column is not safe for Better Auth 1.7.14." });
  }
  for (const duplicate of existingDuplicates) {
    errors.push({
      id: null,
      code: "duplicate-account-key",
      message: `More than one account row already uses provider ${duplicate.providerId} and account id ${duplicate.accountId}.`
    });
  }

  for (const row of rows) {
    if (!row || typeof row.id !== "string" || row.id.length === 0) {
      errors.push({ id: null, code: "row-invalid", message: "A Microsoft account row has no local id." });
      continue;
    }
    if (!MICROSOFT_PROVIDER_IDS.includes(row.providerId)) {
      errors.push({ id: row.id, code: "unexpected-provider", message: "This cutover only rewrites Microsoft account rows." });
      continue;
    }
    if (!normalizeDirectoryGuid(row.accountId)) {
      errors.push({ id: row.id, code: "account-id-not-directory-guid", message: "The stored Microsoft account id is not a directory id, so it cannot be matched to sub or oid." });
      continue;
    }
    const tokenError = tokenErrorById.get(row.id);
    if (tokenError) {
      errors.push({ id: row.id, code: tokenError.code, message: tokenError.message });
      rememberFinalKey(finalKeys, row.providerId, row.accountId, row.id);
      continue;
    }
    const token = verifiedById.get(row.id);
    if (token) {
      if (!sameDirectoryId(token.sub, row.accountId) && !sameDirectoryId(token.oid, row.accountId)) {
        errors.push({ id: row.id, code: "identity-mismatch", message: "The stored account id matches neither sub nor oid in the checked sign-in token." });
        rememberFinalKey(finalKeys, row.providerId, row.accountId, row.id);
        continue;
      }
      if (entraExport) {
        const exported = entraExport.find((entry) => entry.providerId === row.providerId && sameDirectoryId(entry.sub, token.sub));
        if (exported && !sameDirectoryId(exported.oid, token.oid)) {
          errors.push({ id: row.id, code: "export-disagrees", message: "The Entra export object id does not match the checked sign-in token." });
          rememberFinalKey(finalKeys, row.providerId, row.accountId, row.id);
          continue;
        }
      }
      if (sameDirectoryId(row.accountId, token.oid)) {
        if (row.accountId === token.oid) alreadyCurrent.push({ id: row.id, providerId: row.providerId, accountId: row.accountId });
        else updates.push({ id: row.id, providerId: row.providerId, fromAccountId: row.accountId, toAccountId: token.oid, source: "verified-id-token" });
      } else {
        updates.push({ id: row.id, providerId: row.providerId, fromAccountId: row.accountId, toAccountId: token.oid, source: "verified-id-token" });
      }
      rememberFinalKey(finalKeys, row.providerId, token.oid, row.id);
      continue;
    }

    const subMatches = (entraExport || []).filter((entry) => entry.providerId === row.providerId && sameDirectoryId(entry.sub, row.accountId));
    const oidMatches = (entraExport || []).filter((entry) => entry.providerId === row.providerId && sameDirectoryId(entry.oid, row.accountId) && !sameDirectoryId(entry.sub, row.accountId));
    if (subMatches.length > 1 || oidMatches.length > 1) {
      errors.push({ id: row.id, code: "export-ambiguous", message: "More than one Entra export record matches this account." });
      rememberFinalKey(finalKeys, row.providerId, row.accountId, row.id);
      continue;
    }
    if (subMatches.length === 1) {
      const exported = subMatches[0];
      if (oidMatches.some((entry) => !sameDirectoryId(entry.oid, exported.oid))) {
        errors.push({ id: row.id, code: "export-ambiguous", message: "The Entra export matches this account as both an old subject and a different object id." });
        rememberFinalKey(finalKeys, row.providerId, row.accountId, row.id);
        continue;
      }
      if (sameDirectoryId(row.accountId, exported.oid)) {
        if (row.accountId === exported.oid) alreadyCurrent.push({ id: row.id, providerId: row.providerId, accountId: row.accountId });
        else updates.push({ id: row.id, providerId: row.providerId, fromAccountId: row.accountId, toAccountId: exported.oid, source: "entra-export" });
      } else {
        updates.push({ id: row.id, providerId: row.providerId, fromAccountId: row.accountId, toAccountId: exported.oid, source: "entra-export" });
      }
      rememberFinalKey(finalKeys, row.providerId, exported.oid, row.id);
      continue;
    }
    if (oidMatches.length === 1) {
      const exported = oidMatches[0];
      if (row.accountId === exported.oid) alreadyCurrent.push({ id: row.id, providerId: row.providerId, accountId: row.accountId });
      else updates.push({ id: row.id, providerId: row.providerId, fromAccountId: row.accountId, toAccountId: exported.oid, source: "entra-export" });
      rememberFinalKey(finalKeys, row.providerId, exported.oid, row.id);
      continue;
    }
    errors.push({
      id: row.id,
      code: "unresolved",
      message: "This Microsoft account still needs a checked sign-in token or a trusted Entra export. The old account id alone cannot be turned into an oid."
    });
    rememberFinalKey(finalKeys, row.providerId, row.accountId, row.id);
  }

  for (const holders of finalKeys.values()) {
    if (holders.length > 1) {
      errors.push({ id: holders.join(","), code: "collision", message: "The rewrite would leave two Microsoft rows with the same directory object id." });
    }
  }

  return {
    applicable: errors.length === 0,
    issuer,
    duplicates: existingDuplicates,
    updates,
    alreadyCurrent,
    errors
  };
}

export function formatCutoverReport(result) {
  const lines = [
    `Microsoft account cutover (${result.mode === "apply" ? (result.applied ? "applied" : "not applied") : "inventory"})`,
    `Issuer column: ${result.issuer?.code || "unknown"}. ${result.issuer?.message || ""}`.trim(),
    `Microsoft rows: ${result.rowCount}`,
    `Ready to rewrite from sub to oid: ${result.updates.length}`,
    `Already using oid: ${result.alreadyCurrent.length}`,
    `Problems: ${result.errors.length}`,
    `Duplicate account keys: ${result.duplicates.length}`,
    `Safe to apply: ${result.applicable ? "yes" : "no"}`
  ];
  for (const update of result.updates) {
    lines.push(`rewrite ${update.id} ${update.providerId} ${update.fromAccountId} -> ${update.toAccountId} (${update.source})`);
  }
  for (const current of result.alreadyCurrent) lines.push(`already-oid ${current.id} ${current.providerId} ${current.accountId}`);
  for (const error of result.errors) lines.push(`problem ${error.id || "database"} ${error.code}: ${error.message}`);
  if (result.applied) lines.push(`Rows rewritten: ${result.updatedCount}`);
  return lines.join("\n");
}

function microsoftAccountSelectSql(forUpdate) {
  return `select "id", "providerId", "accountId", "userId", "idToken" from "account" where "providerId" = any($1::text[]) order by "id"${forUpdate ? " for update" : ""}`;
}

async function withTransaction(client, work) {
  await client.query("begin");
  try {
    const result = await work();
    await client.query("commit");
    return result;
  } catch (error) {
    try {
      await client.query("rollback");
    } catch {
      // Report the original failure. A rollback error must not hide it.
    }
    throw error;
  }
}

async function readAccountPresence(client) {
  const relation = await client.query("select pg_catalog.to_regclass('public.account')::text as relation_name");
  if (!relation.rows[0]?.relation_name) return { table: false, columns: [], issuer: null, issuerIndex: false };
  const columns = await client.query("select column_name, is_nullable from information_schema.columns where table_schema = 'public' and table_name = 'account'");
  const indexes = await client.query(`
    select c.relname as index_name
      from pg_catalog.pg_class t
      join pg_catalog.pg_namespace n on n.oid = t.relnamespace
      join pg_catalog.pg_index i on i.indrelid = t.oid
      join pg_catalog.pg_class c on c.oid = i.indexrelid
     where n.nspname = 'public' and t.relname = 'account' and c.relname = 'account_issuer_accountId_uidx'
  `);
  return {
    table: true,
    columns: columns.rows,
    issuer: columns.rows.find((column) => column.column_name === "issuer") || null,
    issuerIndex: indexes.rows.length > 0
  };
}

function assertAccountColumns(columns) {
  const names = new Set(columns.map((column) => column.column_name));
  const missing = REQUIRED_ACCOUNT_COLUMNS.filter((name) => !names.has(name));
  if (missing.length) {
    throw new MicrosoftAccountIdentifierError("account-schema-unexpected", `The account table is missing ${missing.join(", ")}.`);
  }
}

async function readDuplicateKeys(client) {
  const result = await client.query(`select "providerId", "accountId", count(*)::int as count from "account" group by "providerId", "accountId" having count(*) > 1`);
  return result.rows.map((row) => ({ providerId: row.providerId, accountId: row.accountId, count: row.count }));
}

async function readMicrosoftRows(client, forUpdate) {
  const result = await client.query(microsoftAccountSelectSql(forUpdate), [MICROSOFT_PROVIDER_IDS]);
  if (result.rows.length > MAX_MICROSOFT_ROWS) {
    throw new MicrosoftAccountIdentifierError("too-many-rows", "There are more Microsoft account rows than this cutover will rewrite in one pass.");
  }
  return result.rows.map((row) => ({
    id: row.id,
    providerId: row.providerId,
    accountId: row.accountId,
    userId: row.userId,
    idToken: typeof row.idToken === "string" ? row.idToken : "",
    fingerprint: tokenFingerprint(typeof row.idToken === "string" ? row.idToken : "")
  }));
}

async function verifyRows(rows, { audience, tenantId, authority, loadJwks, verifyToken }) {
  const verifiedTokens = [];
  const tokenErrors = [];
  const tokenRows = rows.filter((row) => row.idToken.length > 0);
  if (tokenRows.length === 0) return { verifiedTokens, tokenErrors };
  if (!audience) {
    for (const row of tokenRows) {
      tokenErrors.push({ accountRowId: row.id, code: "audience-missing", message: "MICROSOFT_CLIENT_ID is required to check a stored Microsoft sign-in token." });
    }
    return { verifiedTokens, tokenErrors };
  }
  const jwks = await loadJwks();
  for (const row of tokenRows) {
    try {
      const claims = await verifyToken(row.idToken, { jwks, audience, tenantId, authority });
      verifiedTokens.push({ accountRowId: row.id, ...claims });
    } catch (error) {
      const code = error instanceof MicrosoftAccountIdentifierError ? error.code : "id-token-rejected";
      const message = error instanceof MicrosoftAccountIdentifierError ? error.message : "The stored Microsoft sign-in token was rejected.";
      tokenErrors.push({ accountRowId: row.id, code, message });
    }
  }
  return { verifiedTokens, tokenErrors };
}

function snapshotIdentity(row) {
  return `${row.id}\u0000${row.providerId}\u0000${row.accountId}\u0000${row.userId}\u0000${row.fingerprint}`;
}

export async function executeMicrosoftAccountCutover({
  mode,
  client,
  pausedSignInConfirmed = false,
  audience = "",
  tenantId = "",
  authority = MICROSOFT_AUTHORITY,
  entraExport = null,
  loadJwks = async () => null,
  verifyToken = verifyStoredMicrosoftIdToken,
  assertProductionTarget = async () => {}
}) {
  if (mode !== "inventory" && mode !== "apply") {
    throw new MicrosoftAccountIdentifierError("command-invalid", "Use inventory or apply.");
  }
  if (mode === "apply" && pausedSignInConfirmed !== true) {
    throw new MicrosoftAccountIdentifierError("sign-in-not-paused", "Refusing to rewrite Microsoft account ids until sign-in is paused. Re-run apply with --confirm-paused-microsoft-sign-in.");
  }
  if (authority !== MICROSOFT_AUTHORITY) {
    throw new MicrosoftAccountIdentifierError("authority-invalid", "Microsoft token checks use https://login.microsoftonline.com, the same authority as sign-in.");
  }

  const snapshot = await withTransaction(client, async () => {
    await assertProductionTarget(client);
    const presence = await readAccountPresence(client);
    if (!presence.table) return { empty: true };
    assertAccountColumns(presence.columns);
    const issuer = assessLegacyIssuerSchema({
      columnPresent: Boolean(presence.issuer),
      nullable: presence.issuer ? presence.issuer.is_nullable === "YES" : null,
      uniqueIndexPresent: presence.issuerIndex
    });
    const duplicates = await readDuplicateKeys(client);
    const rows = await readMicrosoftRows(client, false);
    return { empty: false, issuer, duplicates, rows };
  });

  if (snapshot.empty) {
    const issuer = assessLegacyIssuerSchema({ columnPresent: false, nullable: null, uniqueIndexPresent: false });
    return {
      mode,
      applied: mode === "apply",
      updatedCount: 0,
      rowCount: 0,
      applicable: true,
      issuer,
      duplicates: [],
      updates: [],
      alreadyCurrent: [],
      errors: []
    };
  }
  if (snapshot.rows.length > 0 && !classifyMicrosoftTenant(tenantId)) {
    throw new MicrosoftAccountIdentifierError("tenant-invalid", "MICROSOFT_TENANT_ID must be one directory id, or common, organizations, or consumers, before existing Microsoft rows can be checked.");
  }

  const { verifiedTokens, tokenErrors } = await verifyRows(snapshot.rows, { audience, tenantId, authority, loadJwks, verifyToken });
  for (const row of snapshot.rows) row.idToken = "";
  const plan = planMicrosoftAccountIdentifierCutover({
    rows: snapshot.rows,
    verifiedTokens,
    entraExport,
    tokenErrors,
    existingDuplicates: snapshot.duplicates,
    issuer: snapshot.issuer
  });
  const report = { mode, applied: false, updatedCount: 0, rowCount: snapshot.rows.length, ...plan };
  if (mode !== "apply" || !plan.applicable) return report;
  if (plan.updates.length === 0) return { ...report, applied: true, updatedCount: 0 };

  let updatedCount = 0;
  await withTransaction(client, async () => {
    await assertProductionTarget(client);
    const presence = await readAccountPresence(client);
    assertAccountColumns(presence.columns);
    const issuer = assessLegacyIssuerSchema({
      columnPresent: Boolean(presence.issuer),
      nullable: presence.issuer ? presence.issuer.is_nullable === "YES" : null,
      uniqueIndexPresent: presence.issuerIndex
    });
    if (!issuer.ok) throw new MicrosoftAccountIdentifierError(issuer.code, issuer.message);
    const duplicates = await readDuplicateKeys(client);
    if (duplicates.length) {
      throw new MicrosoftAccountIdentifierError("duplicate-account-key", "Duplicate account keys appeared before the rewrite. No account id was changed.");
    }
    const locked = await readMicrosoftRows(client, true);
    const before = snapshot.rows.map(snapshotIdentity).sort();
    const after = locked.map(snapshotIdentity).sort();
    if (before.length !== after.length || before.some((value, index) => value !== after[index])) {
      throw new MicrosoftAccountIdentifierError("cutover-stale", "A Microsoft account changed while its token was being checked. No account id was changed. Run the cutover again.");
    }
    const lockedPlan = planMicrosoftAccountIdentifierCutover({
      rows: locked,
      verifiedTokens,
      entraExport,
      tokenErrors,
      existingDuplicates: duplicates,
      issuer
    });
    const beforeUpdates = JSON.stringify(plan.updates);
    if (!lockedPlan.applicable || JSON.stringify(lockedPlan.updates) !== beforeUpdates) {
      throw new MicrosoftAccountIdentifierError("cutover-stale", "The Microsoft account rewrite changed while it was being checked. No account id was changed.");
    }
    for (const update of lockedPlan.updates) {
      const written = await client.query(ACCOUNT_ID_UPDATE_SQL, [update.toAccountId, update.id, update.providerId, update.fromAccountId]);
      if (written.rowCount !== 1) {
        throw new MicrosoftAccountIdentifierError("update-missed", "A Microsoft account row was not rewritten. The database transaction was rolled back.");
      }
      updatedCount += 1;
    }
  });
  return { ...report, applied: true, updatedCount };
}
