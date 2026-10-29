import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const requireFromBetterAuth = createRequire(require.resolve("better-auth"));

let joseModule;

function betterAuthJose() {
  if (!joseModule) joseModule = requireFromBetterAuth("jose");
  return joseModule;
}

export const MICROSOFT_PROVIDER_IDS = Object.freeze(["microsoft", "microsoft-entra-id"]);
export const MICROSOFT_AUTHORITY = "https://login.microsoftonline.com";
export const ACCOUNT_ISSUER_INDEX = "account_issuer_accountId_uidx";
export const ISSUER_CLEANUP_SQL = [
  "ALTER TABLE public.account ALTER COLUMN issuer DROP NOT NULL;",
  `DROP INDEX IF EXISTS public."${ACCOUNT_ISSUER_INDEX}";`
].join(" ");

const GUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const JWT_PATTERN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u;
const CLOCK_SKEW_SECONDS = 300;
const jwksByTenant = new Map();

export class MicrosoftKeyLookupError extends Error {
  constructor(message) {
    super(message);
    this.name = "MicrosoftKeyLookupError";
  }
}

export class UnverifiableMicrosoftTokenError extends Error {
  constructor(message) {
    super(message);
    this.name = "UnverifiableMicrosoftTokenError";
  }
}

export function migrationPlanAddsAccountIssuer(tables) {
  return tables.some((table) => table?.table === "account" && Object.hasOwn(table.fields || {}, "issuer"));
}

export function issuerSchemaBlocker(columns, indexNames) {
  const issuer = columns.find((column) => column.name === "issuer");
  const problems = [];
  if (issuer && issuer.nullable === false) problems.push("the issuer column is required");
  if (indexNames.includes(ACCOUNT_ISSUER_INDEX)) problems.push(`unique index ${ACCOUNT_ISSUER_INDEX} is present`);
  if (!problems.length) return null;
  return `Better Auth 1.7.14 recognizes accounts by providerId and accountId. This database still has the temporary 1.7.0 through 1.7.2 issuer requirement (${problems.join("; ")}). Pause sign-in, apply this cleanup on a restored backup, then rerun the migration: ${ISSUER_CLEANUP_SQL} This migration will not drop or rewrite that column by itself.`;
}

function sameGuid(left, right) {
  return typeof left === "string" && typeof right === "string" && GUID_PATTERN.test(left) && GUID_PATTERN.test(right) && left.toLowerCase() === right.toLowerCase();
}

function requireGuid(value, label) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} is required before stored Microsoft account ids can be checked. No account ids were changed.`);
  }
  if (!GUID_PATTERN.test(value)) {
    throw new Error(`${label} must be the directory GUID configured for this Microsoft app. No account ids were changed.`);
  }
  return value;
}

function targetKey(providerId, accountId) {
  return `${providerId}\u0000${accountId.toLowerCase()}`;
}

function rememberTarget(targets, providerId, accountId, rowId, errors) {
  const key = targetKey(providerId, accountId);
  const existing = targets.get(key);
  if (existing && existing !== rowId) {
    errors.push(`Microsoft account rows ${existing} and ${rowId} would share one ${providerId} object id.`);
    return;
  }
  targets.set(key, rowId);
}

export function parseMicrosoftAccountExport(raw, expectedTenantId) {
  if (typeof raw !== "string" || !raw.trim()) return null;
  if (/[\r\n]/u.test(raw)) {
    throw new Error("The Entra account export must be one line of JSON.");
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("The Entra account export is not valid JSON.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("The Entra account export must be an object.");
  }
  if (!sameGuid(parsed.tenantId, expectedTenantId)) {
    throw new Error("The Entra account export is for a different tenant than MICROSOFT_TENANT_ID.");
  }
  if (!Array.isArray(parsed.accounts)) {
    throw new Error("The Entra account export must include an accounts list.");
  }
  return parsed.accounts.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`Entra export account ${index + 1} is not an object.`);
    }
    const id = typeof entry.id === "string" ? entry.id.trim() : "";
    const previousAccountId = typeof entry.previousAccountId === "string" ? entry.previousAccountId : "";
    const oid = typeof entry.oid === "string" ? entry.oid.trim() : "";
    if (!id || !previousAccountId || !GUID_PATTERN.test(oid)) {
      throw new Error(`Entra export account ${index + 1} needs an account row id, the stored account id, and an Entra object id.`);
    }
    return { id, previousAccountId, oid };
  });
}

export function planMicrosoftAccountCutover({ rows, decisions, exportAccounts }) {
  const errors = [];
  const updates = [];
  const confirmed = [];
  const targets = new Map();
  const unusedExport = new Map((exportAccounts || []).map((entry) => [entry.id, entry]));
  if (unusedExport.size !== (exportAccounts || []).length) {
    errors.push("The Entra export lists the same account row more than once.");
  }

  for (const row of rows) {
    if (!MICROSOFT_PROVIDER_IDS.includes(row.providerId)) continue;
    const decision = decisions.get(row.id);
    if (!decision) {
      errors.push(`Microsoft account ${row.id} was not checked.`);
      continue;
    }
    if (decision.ok) {
      const exported = unusedExport.get(row.id);
      if (exported && !sameGuid(exported.oid, decision.oid)) {
        errors.push(`The Entra export object id for account ${row.id} does not match its verified sign-in token.`);
      }
      unusedExport.delete(row.id);
      if (row.accountId === decision.oid) {
        confirmed.push({ id: row.id, providerId: row.providerId, oid: decision.oid });
        rememberTarget(targets, row.providerId, decision.oid, row.id, errors);
        continue;
      }
      if (row.accountId === decision.sub || sameGuid(row.accountId, decision.oid)) {
        updates.push({
          id: row.id,
          providerId: row.providerId,
          from: row.accountId,
          to: decision.oid,
          evidence: "verified-id-token"
        });
        rememberTarget(targets, row.providerId, decision.oid, row.id, errors);
        continue;
      }
      errors.push(`Microsoft account ${row.id} matches neither the token subject nor the Entra object id, so it was left unchanged.`);
      continue;
    }
    if (decision.kind === "rejected") {
      errors.push(`Microsoft account ${row.id} has a sign-in token that failed verification (${decision.reason}). An export cannot override that token.`);
      continue;
    }
    const exported = unusedExport.get(row.id);
    unusedExport.delete(row.id);
    if (!exported) {
      errors.push(`Microsoft account ${row.id} has no usable stored sign-in token. Pause Microsoft sign-in and provide a reviewed Entra export before accepting Better Auth 1.7 traffic.`);
      continue;
    }
    const exportedOid = exported.oid.toLowerCase();
    if (row.accountId !== exported.previousAccountId && row.accountId !== exportedOid) {
      errors.push(`Microsoft account ${row.id} does not match the Entra export.`);
      continue;
    }
    if (row.accountId === exportedOid) {
      confirmed.push({ id: row.id, providerId: row.providerId, oid: exportedOid });
    } else {
      updates.push({
        id: row.id,
        providerId: row.providerId,
        from: row.accountId,
        to: exportedOid,
        evidence: "entra-export"
      });
    }
    rememberTarget(targets, row.providerId, exportedOid, row.id, errors);
  }

  for (const id of unusedExport.keys()) {
    errors.push(`The Entra export lists account ${id}, which is not a Microsoft account row.`);
  }

  return { ok: errors.length === 0, errors, updates, confirmed };
}

function tokenShapeProblem(token) {
  if (typeof token !== "string" || !token.trim()) return "no stored sign-in token";
  if (token.startsWith("$ba$") || !token.includes(".")) return "stored value is not a readable Microsoft ID token";
  if (!JWT_PATTERN.test(token)) return "stored value is not a Microsoft ID token";
  return null;
}

function audienceMatches(audience, clientId) {
  const values = Array.isArray(audience) ? audience : [audience];
  return values.some((value) => typeof value === "string" && value.toLowerCase() === clientId.toLowerCase());
}

export async function verifyStoredMicrosoftIdToken(token, { tenantId, clientId, resolveKey }) {
  const shapeProblem = tokenShapeProblem(token);
  if (shapeProblem) return { ok: false, kind: "unverifiable", reason: shapeProblem };
  const jose = betterAuthJose();
  let header;
  try {
    header = jose.decodeProtectedHeader(token);
  } catch {
    return { ok: false, kind: "unverifiable", reason: "stored value is not a Microsoft ID token" };
  }
  if (header.alg !== "RS256") {
    return { ok: false, kind: "rejected", reason: "token algorithm is not RS256" };
  }
  let verified;
  try {
    verified = await jose.compactVerify(token, await resolveKey(header, tenantId));
  } catch (error) {
    if (error instanceof UnverifiableMicrosoftTokenError) {
      return { ok: false, kind: "unverifiable", reason: error.message };
    }
    if (error instanceof MicrosoftKeyLookupError) throw error;
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
    if (code === "ERR_JWS_SIGNATURE_VERIFICATION_FAILED" || code === "ERR_JWS_INVALID") {
      return { ok: false, kind: "rejected", reason: "token signature is invalid" };
    }
    throw new MicrosoftKeyLookupError("A stored Microsoft sign-in token could not be checked. No account ids were changed.");
  }
  let claims;
  try {
    claims = JSON.parse(new TextDecoder().decode(verified.payload));
  } catch {
    return { ok: false, kind: "rejected", reason: "token claims are not JSON" };
  }
  if (!claims || typeof claims !== "object" || Array.isArray(claims)) {
    return { ok: false, kind: "rejected", reason: "token claims are not an object" };
  }
  const tid = typeof claims.tid === "string" ? claims.tid : "";
  const oid = typeof claims.oid === "string" ? claims.oid.trim() : "";
  const sub = typeof claims.sub === "string" ? claims.sub : "";
  if (!sameGuid(tid, tenantId) || claims.iss !== `${MICROSOFT_AUTHORITY}/${tid}/v2.0`) {
    return { ok: false, kind: "rejected", reason: "token issuer does not match the configured tenant" };
  }
  if (!audienceMatches(claims.aud, clientId)) {
    return { ok: false, kind: "rejected", reason: "token audience does not match MICROSOFT_CLIENT_ID" };
  }
  if (!GUID_PATTERN.test(oid) || !sub.trim()) {
    return { ok: false, kind: "rejected", reason: "token is missing an Entra object id or subject" };
  }
  const now = Math.floor(Date.now() / 1000);
  if (typeof claims.nbf === "number" && claims.nbf > now + CLOCK_SKEW_SECONDS) {
    return { ok: false, kind: "rejected", reason: "token is not valid yet" };
  }
  if (typeof claims.iat === "number" && typeof claims.exp === "number" && claims.exp < claims.iat) {
    return { ok: false, kind: "rejected", reason: "token expiry precedes its issue time" };
  }
  return { ok: true, oid, sub, tid };
}

export function microsoftJwksUrl(tenantId) {
  const guid = requireGuid(tenantId, "MICROSOFT_TENANT_ID");
  return `${MICROSOFT_AUTHORITY}/${encodeURIComponent(guid)}/discovery/v2.0/keys`;
}

export async function microsoftSigningKey(protectedHeader, tenantId) {
  const kid = typeof protectedHeader?.kid === "string" ? protectedHeader.kid : "";
  if (!kid) throw new UnverifiableMicrosoftTokenError("The token is missing a signing key id.");
  let keys = jwksByTenant.get(tenantId);
  if (!keys) {
    let response;
    try {
      response = await fetch(microsoftJwksUrl(tenantId), {
        redirect: "error",
        signal: AbortSignal.timeout(10_000)
      });
    } catch {
      throw new MicrosoftKeyLookupError("Microsoft signing keys could not be reached. No account ids were changed.");
    }
    if (!response.ok) {
      throw new MicrosoftKeyLookupError(`Microsoft signing keys returned HTTP ${response.status}. No account ids were changed.`);
    }
    let body;
    try {
      body = await response.json();
    } catch {
      throw new MicrosoftKeyLookupError("Microsoft signing keys were not valid JSON. No account ids were changed.");
    }
    if (!body || !Array.isArray(body.keys) || body.keys.length === 0) {
      throw new MicrosoftKeyLookupError("Microsoft signing keys were incomplete. No account ids were changed.");
    }
    keys = body.keys;
    jwksByTenant.set(tenantId, keys);
  }
  const jwk = keys.find((key) => key && key.kid === kid);
  if (!jwk) throw new UnverifiableMicrosoftTokenError("The token signing key is no longer in the current Microsoft key set.");
  try {
    return await betterAuthJose().importJWK(jwk, "RS256");
  } catch {
    throw new MicrosoftKeyLookupError("A Microsoft signing key could not be used. No account ids were changed.");
  }
}

function cutoverSummary(microsoftRows, updates, confirmed) {
  if (!microsoftRows) {
    return "Microsoft account cutover: no Microsoft account rows were present. The first Microsoft sign-in on Better Auth 1.7 stores the Entra object id.";
  }
  return `Microsoft account cutover: ${updates.length} stored Microsoft account id(s) rewritten from the app-specific subject to the Entra object id; ${confirmed.length} already used the object id.`;
}

export async function applyMicrosoftAccountCutover(client, env = process.env, dependencies = {}) {
  const issuerColumns = await client.query(
    "select column_name as name, is_nullable = 'YES' as nullable from information_schema.columns where table_schema = 'public' and table_name = 'account' and column_name = 'issuer'"
  );
  const issuerIndexes = await client.query(
    "select indexname as name from pg_indexes where schemaname = 'public' and tablename = 'account' and indexname = $1",
    [ACCOUNT_ISSUER_INDEX]
  );
  const blocker = issuerSchemaBlocker(
    issuerColumns.rows.map((row) => ({ name: row.name, nullable: row.nullable === true })),
    issuerIndexes.rows.map((row) => row.name)
  );
  if (blocker) throw new Error(blocker);

  const duplicateAccountKeys = 'select "providerId" as provider_id, "accountId" as account_id, count(*)::int as copies from public.account group by 1, 2 having count(*) > 1';
  const duplicates = await client.query(duplicateAccountKeys);
  if (duplicates.rows.length) {
    const described = duplicates.rows.map((row) => `${row.provider_id} account ${row.account_id} (${row.copies} rows)`).join(", ");
    throw new Error(`Better Auth cannot upgrade while providerId and accountId are duplicated: ${described}. Keep one row per provider account before retrying.`);
  }

  const selected = await client.query(
    'select id, "providerId" as provider_id, "accountId" as account_id, "idToken" as id_token from public.account where "providerId" = any($1::text[]) for update',
    [MICROSOFT_PROVIDER_IDS]
  );
  const rows = selected.rows.map((row) => ({
    id: String(row.id),
    providerId: row.provider_id,
    accountId: row.account_id,
    idToken: row.id_token
  }));
  if (!rows.length) {
    return {
      updates: [],
      confirmed: [],
      summary: `Better Auth account identity stays providerId plus accountId; the 1.7.0 through 1.7.2 issuer column was not added. ${cutoverSummary(0, [], [])}`
    };
  }

  const tenantId = requireGuid(env.MICROSOFT_TENANT_ID, "MICROSOFT_TENANT_ID");
  const clientId = requireGuid(env.MICROSOFT_CLIENT_ID, "MICROSOFT_CLIENT_ID");
  const exportAccounts = parseMicrosoftAccountExport(env.MICROSOFT_ACCOUNT_OID_EXPORT_JSON, tenantId);
  const resolveKey = dependencies.resolveKey || microsoftSigningKey;
  const decisions = new Map();
  for (const row of rows) {
    decisions.set(row.id, await verifyStoredMicrosoftIdToken(row.idToken, { tenantId, clientId, resolveKey }));
  }
  const plan = planMicrosoftAccountCutover({ rows, decisions, exportAccounts });
  if (!plan.ok) {
    throw new Error(`Microsoft account cutover stopped without changes. ${plan.errors.join(" ")}`);
  }
  for (const update of plan.updates) {
    const written = await client.query(
      'update public.account set "accountId" = $1, "updatedAt" = now() where id = $2 and "providerId" = $3 and "accountId" = $4',
      [update.to, update.id, update.providerId, update.from]
    );
    if (written.rowCount !== 1) {
      throw new Error(`Microsoft account ${update.id} changed while it was being rewritten. No partial cutover was committed.`);
    }
  }
  const remainingDuplicates = await client.query(duplicateAccountKeys);
  if (remainingDuplicates.rows.length) {
    throw new Error("Microsoft account cutover would leave duplicate provider account ids. No partial cutover was committed.");
  }
  return {
    updates: plan.updates,
    confirmed: plan.confirmed,
    summary: `Better Auth account identity stays providerId plus accountId; the 1.7.0 through 1.7.2 issuer column was not added. ${cutoverSummary(rows.length, plan.updates, plan.confirmed)}`
  };
}
