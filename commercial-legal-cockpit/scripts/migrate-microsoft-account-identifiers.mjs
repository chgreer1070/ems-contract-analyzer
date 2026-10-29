import { lstat, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import pg from "pg";
import { assertTrustedMigrationTarget, verifiedDatabaseConnectionConfig } from "./database-connection-config.mjs";
import {
  microsoftAccountIdUpdateQuery,
  parseReviewedOidMapping,
  planStoredMicrosoftAccountCutover
} from "./microsoft-account-identity.mjs";

const { Client } = pg;

function parseArgs(argv) {
  let apply = false;
  let mappingPath = "";
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--apply") apply = true;
    else if (arg === "--mapping") {
      mappingPath = argv[index + 1] || "";
      index += 1;
      if (!mappingPath || mappingPath.startsWith("--")) throw new Error("--mapping requires a file path.");
    } else {
      throw new Error("Usage: node scripts/migrate-microsoft-account-identifiers.mjs [--apply] [--mapping <reviewed-entra-export.json>]");
    }
  }
  return { apply, mappingPath };
}

function scrub(error) {
  const message = error instanceof Error ? error.message : "Microsoft account cutover failed.";
  return message.replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[stored-id-token]");
}

async function loadMapping(mappingPath) {
  if (!mappingPath) return null;
  const filePath = resolve(mappingPath);
  const metadata = await lstat(filePath);
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error("Mapping file must be a regular, non-symbolic-link file.");
  return parseReviewedOidMapping(JSON.parse(await readFile(filePath, "utf8")));
}

async function main() {
  const { apply, mappingPath } = parseArgs(process.argv.slice(2));
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required.");
  const reviewed = await loadMapping(mappingPath);
  const client = new Client(verifiedDatabaseConnectionConfig(process.env.DATABASE_URL, "contracttwin-microsoft-oid-cutover", {
    requireVerifiedTls: process.env.APP_ENV === "production"
  }));
  await client.connect();
  let open = false;
  try {
    await assertTrustedMigrationTarget(client);
    await client.query(apply ? "begin" : "begin transaction read only");
    open = true;
    const { state, plan } = await planStoredMicrosoftAccountCutover(client, {
      lock: apply,
      clientId: process.env.MICROSOFT_CLIENT_ID || "",
      tenantId: process.env.MICROSOFT_TENANT_ID || "",
      reviewedByRowId: reviewed
    });
    if (reviewed && state.accountTableExists) {
      const ids = new Set(state.microsoftRows.map(row => row.id));
      for (const id of reviewed.keys()) {
        if (!ids.has(id)) throw new Error(`Mapping names account ${id}, which is not a Microsoft account row.`);
      }
    }
    if (!plan.ok) {
      throw new Error(plan.errors.join(" "));
    }
    console.log(`Microsoft account cutover: ${plan.aligned.length} already using the directory object id, ${plan.updates.length} ready to change.`);
    for (const update of plan.updates) {
      console.log(`Account ${update.id} (${update.providerId}) would change to directory object id ${update.oid}.`);
    }
    if (!apply) {
      await client.query("rollback");
      open = false;
      if (plan.updates.length) {
        console.error("Dry run only. Pause Microsoft sign-in, then re-run with --apply.");
        process.exitCode = 2;
      }
      return;
    }
    for (const update of plan.updates) {
      const query = microsoftAccountIdUpdateQuery(state.columns, update);
      const result = await client.query(query.text, query.values);
      if (result.rowCount !== 1) throw new Error(`Account ${update.id} was not updated. No other rows were committed.`);
    }
    await client.query("commit");
    open = false;
    const tokenless = state.microsoftRows.filter(row => !row.idToken).length;
    if (tokenless) {
      console.log(`Updated ${plan.updates.length} account id(s). ${tokenless} row(s) had no stored ID token and now use the reviewed Entra export. Keep Microsoft sign-in paused. For the release that deploys this version, set the GitHub secret MICROSOFT_ACCOUNT_OID_MAPPING_JSON to this same mapping. The release checks that those object ids are already stored. It does not write them, and it does not treat the old subject as proof. Remove the secret after that release.`);
    } else {
      console.log(`Updated ${plan.updates.length} Microsoft account id(s) from verified ID tokens.`);
    }
  } catch (error) {
    if (open) {
      try { await client.query("rollback"); } catch { /* the original error is the one to report */ }
    }
    console.error(scrub(error));
    process.exitCode = 2;
  } finally {
    await client.end();
  }
}

if (process.argv[1] && process.argv[1].endsWith("migrate-microsoft-account-identifiers.mjs")) {
  main().catch(error => {
    console.error(scrub(error));
    process.exitCode = 2;
  });
}
