#!/usr/bin/env node
/**
 * Better Auth 1.7 Microsoft account-identifier cutover.
 *
 * From 1.7 onward the built-in Microsoft provider stores the verified Entra
 * directory `oid` claim as account.accountId (and binds the ID-token issuer to
 * the concrete tenant GUID). Rows created on Better Auth 1.6 still hold the
 * pairwise, app-specific `sub` claim. Accepting production Microsoft sign-in
 * before rewriting those rows can orphan sessions or create duplicate accounts.
 *
 * Usage:
 *   DATABASE_URL=... node scripts/microsoft-account-oid-cutover.mjs
 *   DATABASE_URL=... node scripts/microsoft-account-oid-cutover.mjs --apply --mapping path/to/sub-to-oid.json
 *
 * Mapping file shape (array or object):
 *   [{ "accountId": "<old-sub>", "oid": "<directory-oid>" }, ...]
 *   or { "<old-sub>": "<directory-oid>", ... }
 *
 * Obtain oid values from verified stored Microsoft ID tokens when available, or
 * from a trusted Entra export while Microsoft sign-in/linking is paused.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import pg from "pg";
import { verifiedDatabaseConnectionConfig } from "./database-connection-config.mjs";

const { Pool } = pg;
const APPLY = process.argv.includes("--apply");
const mappingFlagIndex = process.argv.indexOf("--mapping");
const mappingPath = mappingFlagIndex >= 0 ? process.argv[mappingFlagIndex + 1] : null;

const PROVIDER_IDS = ["microsoft", "microsoft-entra-id"];

function loadMapping(path) {
  if (!path) return new Map();
  const raw = JSON.parse(readFileSync(resolve(path), "utf8"));
  const entries = Array.isArray(raw)
    ? raw.map((row) => [row.accountId || row.sub, row.oid || row.accountOid])
    : Object.entries(raw);
  const mapping = new Map();
  for (const [from, to] of entries) {
    if (typeof from !== "string" || !from.trim()) throw new Error("Mapping entries require the old Microsoft accountId/sub.");
    if (typeof to !== "string" || !to.trim()) throw new Error(`Mapping for ${from} requires a non-empty oid.`);
    if (from.trim() === to.trim()) continue;
    mapping.set(from.trim(), to.trim());
  }
  return mapping;
}

function decodeJwtPayload(token) {
  if (typeof token !== "string" || token.split(".").length < 2) return null;
  try {
    const payload = Buffer.from(token.split(".")[1], "base64url").toString("utf8");
    return JSON.parse(payload);
  } catch {
    return null;
  }
}

async function main() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required.");
  const mapping = loadMapping(mappingPath);
  const pool = new Pool({
    ...verifiedDatabaseConnectionConfig(process.env.DATABASE_URL, "contracttwin-microsoft-oid-cutover", {
      requireVerifiedTls: process.env.APP_ENV === "production"
    })
  });

  const client = await pool.connect();
  try {
    const inventory = await client.query(
      `select id, "userId" as user_id, "providerId" as provider_id, "accountId" as account_id, "idToken" as id_token
         from account
        where "providerId" = any($1::text[])
        order by "providerId", id`,
      [PROVIDER_IDS]
    );

    const plans = [];
    const unresolved = [];
    for (const row of inventory.rows) {
      const fromToken = decodeJwtPayload(row.id_token);
      const tokenOid = typeof fromToken?.oid === "string" ? fromToken.oid.trim() : "";
      const mappedOid = mapping.get(row.account_id) || "";
      const nextOid = mappedOid || tokenOid;
      if (!nextOid) {
        unresolved.push(row);
        continue;
      }
      if (nextOid === row.account_id) continue;
      plans.push({ ...row, nextOid, source: mappedOid ? "mapping" : "id_token" });
    }

    console.log(`Microsoft account rows: ${inventory.rowCount}`);
    console.log(`Planned accountId rewrites (sub -> oid): ${plans.length}`);
    console.log(`Unresolved rows needing Entra export/mapping: ${unresolved.length}`);
    for (const plan of plans.slice(0, 20)) {
      console.log(`- ${plan.provider_id} ${plan.id}: ${plan.account_id} -> ${plan.nextOid} (${plan.source})`);
    }
    if (plans.length > 20) console.log(`- … ${plans.length - 20} more`);
    for (const row of unresolved.slice(0, 20)) {
      console.log(`! unresolved ${row.provider_id} ${row.id} accountId=${row.account_id}`);
    }

    if (!APPLY) {
      if (unresolved.length) {
        throw new Error(
          "Dry-run found Microsoft account rows without a verified oid mapping. Pause Microsoft sign-in/linking, supply --mapping from a trusted Entra export or stored ID tokens, then re-run with --apply before production traffic on Better Auth 1.7."
        );
      }
      console.log("Dry-run complete. Re-run with --apply after reviewing the planned rewrites.");
      return;
    }

    if (unresolved.length) {
      throw new Error("Refusing --apply while unresolved Microsoft account rows remain.");
    }

    await client.query("begin");
    for (const plan of plans) {
      const updated = await client.query(
        `update account
            set "accountId" = $1
          where id = $2
            and "providerId" = $3
            and "accountId" = $4`,
        [plan.nextOid, plan.id, plan.provider_id, plan.account_id]
      );
      if (updated.rowCount !== 1) {
        throw new Error(`Failed to rewrite Microsoft account ${plan.id}; aborting cutover.`);
      }
    }
    await client.query("commit");
    console.log(`Applied ${plans.length} Microsoft accountId oid rewrites.`);
  } catch (error) {
    try { await client.query("rollback"); } catch { /* already closed / idle */ }
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
