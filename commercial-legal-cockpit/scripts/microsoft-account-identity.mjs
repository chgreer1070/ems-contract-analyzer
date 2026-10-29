import { createLocalJWKSet, decodeJwt, decodeProtectedHeader, jwtVerify } from "jose";

// Better Auth 1.7 identifies Microsoft accounts by the Entra directory object id
// (`oid`). Better Auth 1.6 stored the app-specific `sub` value. These helpers
// prove which id a stored sign-in token belongs to before a release accepts traffic.
export const MICROSOFT_AUTHORITY = "https://login.microsoftonline.com";
export const MICROSOFT_PROVIDER_IDS = ["microsoft", "microsoft-entra-id"];
const ENTRA_GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RESERVED_MICROSOFT_TENANTS = new Set(["common", "organizations", "consumers"]);
const ACCOUNT_COLUMNS = ["id", "accountId", "providerId", "idToken", "updatedAt"];

export function isConcreteEntraTenantId(value) {
  return typeof value === "string" && !RESERVED_MICROSOFT_TENANTS.has(value.trim().toLowerCase()) && ENTRA_GUID.test(value.trim());
}

export function isEntraObjectId(value) {
  return typeof value === "string" && ENTRA_GUID.test(value.trim());
}

export function normalizeEntraTenantId(value) {
  if (!isConcreteEntraTenantId(value)) {
    throw new Error("MICROSOFT_TENANT_ID must be the Entra directory GUID. common, organizations, and consumers are not accepted.");
  }
  return value.trim().toLowerCase();
}

function quoteIdentifier(name) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error("Unexpected account-table identifier.");
  return `"${name}"`;
}

export function resolveAccountColumns(columnRows) {
  const byLower = new Map(columnRows.map(row => [String(row.column_name).toLowerCase(), row]));
  const columns = {};
  const missing = [];
  for (const name of ACCOUNT_COLUMNS) {
    const found = byLower.get(name.toLowerCase());
    if (!found) missing.push(name);
    else columns[name] = found.column_name;
  }
  if (missing.length) throw new Error(`Better Auth account table is missing ${missing.join(", ")}.`);
  const issuer = byLower.get("issuer");
  return {
    columns,
    issuer: issuer ? { name: issuer.column_name, nullable: issuer.is_nullable === "YES" } : null
  };
}

export function assessStructuralCutover({ duplicateKeys, issuer, indexDefinitions }) {
  const errors = [];
  for (const row of duplicateKeys || []) {
    errors.push(`More than one account uses provider ${row.provider_id} with the same account id (${row.row_count} rows). Better Auth 1.7 rejects that lookup. Merge the rows before upgrading.`);
  }
  if (issuer && !issuer.nullable) {
    errors.push("The account.issuer column is required. Better Auth 1.7.3 no longer writes it, so sign-in would fail until it is optional. On PostgreSQL run: ALTER TABLE account ALTER COLUMN issuer DROP NOT NULL; This upgrade does not run that statement.");
  }
  for (const definition of indexDefinitions || []) {
    if (/unique/i.test(definition) && /\bissuer\b/i.test(definition)) {
      errors.push(`A unique index still covers issuer (${definition}). Drop that index before upgrading. On PostgreSQL the generated name is account_issuer_accountId_uidx. Drop the index before dropping the column, or MySQL can turn it into a unique constraint on accountId alone. This upgrade does not drop it.`);
    }
  }
  return { ok: errors.length === 0, errors };
}

function sameAccountId(left, right) {
  return String(left) === String(right);
}

export function planMicrosoftAccountIdentifierMigration(rows) {
  const errors = [];
  const updates = [];
  const aligned = [];
  const seenTarget = new Map();
  for (const row of rows) {
    if (!MICROSOFT_PROVIDER_IDS.includes(row.providerId)) continue;
    let target = null;
    if (row.verifiedOid) {
      if (row.reviewedOid && row.reviewedOid.toLowerCase() !== row.verifiedOid.toLowerCase()) {
        errors.push(`Account ${row.id} has a reviewed mapping that disagrees with its verified ID token.`);
        continue;
      }
      target = row.verifiedOid;
    } else if (row.verificationError) {
      errors.push(`Account ${row.id} has a stored Microsoft ID token that could not be verified.`);
      continue;
    } else if (row.reviewedOid) {
      target = row.reviewedOid;
    } else {
      errors.push(`Account ${row.id} has no verified directory object id.`);
      continue;
    }
    if (!isEntraObjectId(target)) {
      errors.push(`Account ${row.id} did not resolve to an Entra directory object id.`);
      continue;
    }
    const key = `${row.providerId}\0${target.toLowerCase()}`;
    const previous = seenTarget.get(key);
    if (previous) errors.push(`Accounts ${previous} and ${row.id} would share one Microsoft directory object id.`);
    else seenTarget.set(key, row.id);
    if (sameAccountId(row.accountId, target)) aligned.push(row.id);
    else updates.push({ id: row.id, providerId: row.providerId, previousAccountId: row.accountId, oid: target });
  }
  return { ok: errors.length === 0, errors, updates, aligned };
}

export function parseReviewedOidMapping(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Mapping file must be a JSON object.");
  if (value.source !== "entra-export") throw new Error("Mapping file source must be entra-export.");
  if (typeof value.reviewedBy !== "string" || value.reviewedBy.trim().length < 3) {
    throw new Error("Mapping file must name the person who reviewed the Entra export.");
  }
  if (!Array.isArray(value.accounts) || value.accounts.length === 0) throw new Error("Mapping file must list at least one account.");
  const byId = new Map();
  for (const entry of value.accounts) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("Mapping entry is invalid.");
    const extra = Object.keys(entry).filter(key => key !== "accountRowId" && key !== "oid");
    if (extra.length) throw new Error("Mapping entries may only contain accountRowId and oid. Do not match people by email.");
    if (typeof entry.accountRowId !== "string" || !/^[A-Za-z0-9]{16,64}$/.test(entry.accountRowId)) {
      throw new Error("accountRowId must be the local Better Auth account row id.");
    }
    if (!isEntraObjectId(entry.oid)) throw new Error("oid must be the Entra directory object id.");
    if (byId.has(entry.accountRowId)) throw new Error("Mapping file repeats an account row.");
    byId.set(entry.accountRowId, entry.oid.trim());
  }
  return byId;
}

function stripAuthority(authority) {
  const value = typeof authority === "string" ? authority.trim() : "";
  if (value !== MICROSOFT_AUTHORITY) throw new Error("Microsoft token verification only accepts the Entra authority https://login.microsoftonline.com.");
  return value;
}

export async function fetchMicrosoftJwks({ tenantId, authority = MICROSOFT_AUTHORITY, fetchImpl = globalThis.fetch }) {
  const directoryId = normalizeEntraTenantId(tenantId);
  const base = stripAuthority(authority);
  const response = await fetchImpl(`${base}/${directoryId}/discovery/v2.0/keys`, { signal: AbortSignal.timeout(10_000) });
  if (!response?.ok) throw new Error(`Microsoft signing keys were not available (${response?.status || "no response"}).`);
  const body = await response.json();
  if (!body || !Array.isArray(body.keys) || body.keys.length === 0 || body.keys.length > 50) {
    throw new Error("Microsoft signing-key response was empty or unexpected.");
  }
  return createLocalJWKSet({ keys: body.keys });
}

export async function verifyStoredMicrosoftIdToken(idToken, { clientId, tenantId, authority = MICROSOFT_AUTHORITY, key }) {
  if (typeof idToken !== "string" || idToken.split(".").length !== 3) throw new Error("Stored Microsoft ID token is not a compact JWT.");
  if (typeof clientId !== "string" || clientId.trim().length === 0) throw new Error("Microsoft token verification requires the Entra application id.");
  const directoryId = normalizeEntraTenantId(tenantId);
  const header = decodeProtectedHeader(idToken);
  if (header.alg !== "RS256") throw new Error("Stored Microsoft ID token must use RS256.");
  const unverified = decodeJwt(idToken);
  if (typeof unverified.iat !== "number" || !Number.isFinite(unverified.iat)) throw new Error("Stored Microsoft ID token is missing its issued-at time.");
  const base = stripAuthority(authority);
  const issuer = `${base}/${directoryId}/v2.0`;
  // Stored sign-in tokens expire in about an hour. Verify the signature, audience,
  // issuer, and tenant as of the time Microsoft issued the token.
  const { payload } = await jwtVerify(idToken, key, {
    algorithms: ["RS256"],
    audience: clientId.trim(),
    issuer,
    clockTolerance: 5,
    currentDate: new Date(unverified.iat * 1000)
  });
  if (typeof payload.tid !== "string" || payload.tid.toLowerCase() !== directoryId.toLowerCase() || payload.iss !== `${base}/${payload.tid}/v2.0`) {
    throw new Error("Stored Microsoft ID token is for a different directory.");
  }
  if (!isEntraObjectId(payload.oid)) throw new Error("Stored Microsoft ID token did not include a directory object id.");
  return { oid: payload.oid.trim() };
}

export async function readAccountCutoverState(client, { lock = false } = {}) {
  const table = await client.query("select to_regclass('public.account')::text as name");
  if (!table.rows[0]?.name) return { accountTableExists: false, duplicateKeys: [], issuer: null, indexDefinitions: [], microsoftRows: [], columns: null };
  if (lock) await client.query("lock table public.account in share mode");
  const columnResult = await client.query(`
    select column_name, is_nullable
    from information_schema.columns
    where table_schema = 'public' and table_name = 'account'
  `);
  const resolved = resolveAccountColumns(columnResult.rows);
  const id = quoteIdentifier(resolved.columns.id);
  const providerId = quoteIdentifier(resolved.columns.providerId);
  const accountId = quoteIdentifier(resolved.columns.accountId);
  const idToken = quoteIdentifier(resolved.columns.idToken);
  const indexResult = await client.query(`
    select indexdef
    from pg_indexes
    where schemaname = 'public' and tablename = 'account'
  `);
  const duplicateResult = await client.query(`
    select ${providerId} as provider_id, ${accountId} as account_id, count(*)::int as row_count
    from public.account
    group by 1, 2
    having count(*) > 1
  `);
  const microsoftResult = await client.query(`
    select ${id} as id, ${providerId} as provider_id, ${accountId} as account_id, ${idToken} as id_token
    from public.account
    where ${providerId} = any($1::text[])
  `, [MICROSOFT_PROVIDER_IDS]);
  return {
    accountTableExists: true,
    columns: resolved.columns,
    issuer: resolved.issuer,
    indexDefinitions: indexResult.rows.map(row => row.indexdef),
    duplicateKeys: duplicateResult.rows,
    microsoftRows: microsoftResult.rows.map(row => ({
      id: row.id,
      providerId: row.provider_id,
      accountId: row.account_id,
      idToken: row.id_token || null
    }))
  };
}

export function microsoftAccountIdUpdateQuery(columns, change) {
  const accountId = quoteIdentifier(columns.accountId);
  const updatedAt = quoteIdentifier(columns.updatedAt);
  const id = quoteIdentifier(columns.id);
  const providerId = quoteIdentifier(columns.providerId);
  return {
    text: `update public.account set ${accountId} = $1, ${updatedAt} = pg_catalog.now() where ${id} = $2 and ${providerId} = $3 and ${accountId} = $4`,
    values: [change.oid, change.id, change.providerId, change.previousAccountId]
  };
}

async function describeMicrosoftRows(state, options, reviewedByRowId) {
  const prepared = state.microsoftRows.map(row => ({
    id: row.id,
    providerId: row.providerId,
    accountId: row.accountId,
    verifiedOid: null,
    verificationError: null,
    reviewedOid: reviewedByRowId?.get(row.id) || null,
    hasIdToken: Boolean(row.idToken)
  }));
  const tokenRows = prepared.filter(row => row.hasIdToken);
  if (tokenRows.length) {
    if (!options.clientId || !isConcreteEntraTenantId(options.tenantId)) {
      throw new Error("Better Auth 1.7 account cutover blocked: Microsoft account rows exist, but the migrator was not given the Entra application id and directory GUID needed to verify stored ID tokens.");
    }
    const key = options.verifyToken ? null : options.jwks || await fetchMicrosoftJwks({
      tenantId: options.tenantId,
      authority: options.authority || MICROSOFT_AUTHORITY,
      fetchImpl: options.fetchImpl
    });
    for (const row of prepared) {
      const source = state.microsoftRows.find(candidate => candidate.id === row.id);
      if (!source?.idToken) continue;
      try {
        const verified = options.verifyToken
          ? await options.verifyToken(source.idToken, row.id)
          : await verifyStoredMicrosoftIdToken(source.idToken, {
            clientId: options.clientId,
            tenantId: options.tenantId,
            authority: options.authority || MICROSOFT_AUTHORITY,
            key
          });
        row.verifiedOid = verified.oid;
      } catch {
        row.verificationError = "stored ID token could not be verified";
      }
    }
  }
  return prepared;
}

export async function assertBetterAuth17AccountCutover(client, options = {}) {
  const state = await readAccountCutoverState(client, { lock: true });
  if (!state.accountTableExists) return { microsoftAccounts: 0, aligned: 0 };
  const structural = assessStructuralCutover(state);
  if (!structural.ok) throw new Error(`Better Auth 1.7 account cutover blocked: ${structural.errors.join(" ")}`);
  const prepared = await describeMicrosoftRows(state, options, options.reviewedByRowId || null);
  const plan = planMicrosoftAccountIdentifierMigration(prepared);
  if (!plan.ok || plan.updates.length > 0) {
    const details = [
      ...plan.errors,
      plan.updates.length ? `${plan.updates.length} Microsoft account id(s) still need the directory object id. A reviewed export is accepted only after its object id is already stored on that row.` : ""
    ].filter(Boolean);
    throw new Error(`Better Auth 1.7 account cutover blocked: ${details.join(" ")} Pause Microsoft sign-in and run node scripts/migrate-microsoft-account-identifiers.mjs before this release. This check does not rewrite account ids.`);
  }
  return { microsoftAccounts: prepared.length, aligned: plan.aligned.length };
}

export async function planStoredMicrosoftAccountCutover(client, options = {}) {
  const state = await readAccountCutoverState(client, { lock: Boolean(options.lock) });
  if (!state.accountTableExists) return { state, structural: { ok: true, errors: [] }, plan: { ok: true, errors: [], updates: [], aligned: [] } };
  const structural = assessStructuralCutover(state);
  if (!structural.ok) return { state, structural, plan: { ok: false, errors: structural.errors, updates: [], aligned: [] } };
  const prepared = await describeMicrosoftRows(state, options, options.reviewedByRowId || null);
  return { state, structural, plan: planMicrosoftAccountIdentifierMigration(prepared) };
}
