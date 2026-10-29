import { lstat, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import pg from "pg";
import { assertTrustedMigrationTarget, verifiedDatabaseConnectionConfig } from "./database-connection-config.mjs";
import { assertHeldPreMigrationTargetChallenge } from "./release-target-binding.mjs";
import {
  MICROSOFT_AUTHORITY,
  MicrosoftAccountIdentifierError,
  executeMicrosoftAccountCutover,
  formatCutoverReport,
  parseEntraExport,
  redactDatabaseUrl
} from "./microsoft-account-identifier.mjs";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);
const MAX_EXPORT_BYTES = 1_000_000;

function databaseHost(connectionString) {
  let parsed;
  try {
    parsed = new URL(connectionString);
  } catch {
    throw new MicrosoftAccountIdentifierError("database-invalid", "DATABASE_URL is invalid.");
  }
  return parsed.hostname.replace(/^\[|\]$/gu, "");
}

async function readRegularFile(filePath, label) {
  const absolute = resolve(filePath);
  const metadata = await lstat(absolute);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new MicrosoftAccountIdentifierError("file-invalid", `${label} must be a regular file.`);
  }
  if (metadata.size > MAX_EXPORT_BYTES) {
    throw new MicrosoftAccountIdentifierError("file-invalid", `${label} is too large.`);
  }
  return readFile(absolute, "utf8");
}

async function loadExport(filePath) {
  let parsed;
  try {
    parsed = JSON.parse(await readRegularFile(filePath, "The Entra export"));
  } catch (error) {
    if (error instanceof MicrosoftAccountIdentifierError) throw error;
    throw new MicrosoftAccountIdentifierError("export-invalid", "The Entra export is not valid JSON.");
  }
  return parseEntraExport(parsed);
}

async function loadJwksFile(filePath) {
  let parsed;
  try {
    parsed = JSON.parse(await readRegularFile(filePath, "The signing-key file"));
  } catch (error) {
    if (error instanceof MicrosoftAccountIdentifierError) throw error;
    throw new MicrosoftAccountIdentifierError("jwks-unavailable", "The signing-key file is not valid JSON.");
  }
  if (!parsed || !Array.isArray(parsed.keys) || parsed.keys.length === 0) {
    throw new MicrosoftAccountIdentifierError("jwks-unavailable", "The signing-key file has no keys.");
  }
  return parsed;
}

async function fetchMicrosoftJwks(tenantId) {
  const response = await fetch(`${MICROSOFT_AUTHORITY}/${encodeURIComponent(tenantId)}/discovery/v2.0/keys`, {
    signal: AbortSignal.timeout(10_000)
  });
  if (!response.ok) {
    throw new MicrosoftAccountIdentifierError("jwks-unavailable", "Microsoft signing keys were not available.");
  }
  const text = await response.text();
  if (text.length > MAX_EXPORT_BYTES) {
    throw new MicrosoftAccountIdentifierError("jwks-unavailable", "Microsoft signing keys were too large.");
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new MicrosoftAccountIdentifierError("jwks-unavailable", "Microsoft signing keys were not valid JSON.");
  }
  if (!parsed || !Array.isArray(parsed.keys) || parsed.keys.length === 0) {
    throw new MicrosoftAccountIdentifierError("jwks-unavailable", "Microsoft signing keys were empty.");
  }
  return parsed;
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (command !== "inventory" && command !== "apply") {
    throw new MicrosoftAccountIdentifierError("command-invalid", "Usage: node scripts/microsoft-account-identifier-cutover.mjs <inventory|apply> [--confirm-paused-microsoft-sign-in] [--export file] [--jwks-file file]");
  }
  let pausedSignInConfirmed = false;
  let exportPath = "";
  let jwksPath = "";
  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index];
    if (argument === "--confirm-paused-microsoft-sign-in") {
      pausedSignInConfirmed = true;
      continue;
    }
    if (argument === "--export" || argument === "--jwks-file") {
      const value = rest[index + 1];
      if (!value || value.startsWith("--")) {
        throw new MicrosoftAccountIdentifierError("command-invalid", `${argument} needs a file path.`);
      }
      if (argument === "--export") exportPath = value;
      else jwksPath = value;
      index += 1;
      continue;
    }
    throw new MicrosoftAccountIdentifierError("command-invalid", `Unknown argument ${argument}.`);
  }
  return { command, pausedSignInConfirmed, exportPath, jwksPath };
}

async function main() {
  const { command, pausedSignInConfirmed, exportPath, jwksPath } = parseArgs(process.argv.slice(2));
  if (command === "apply" && !pausedSignInConfirmed) {
    throw new MicrosoftAccountIdentifierError("sign-in-not-paused", "Refusing to rewrite Microsoft account ids until sign-in is paused. Re-run apply with --confirm-paused-microsoft-sign-in.");
  }
  const databaseUrl = process.env.DATABASE_URL || "";
  if (!databaseUrl) throw new MicrosoftAccountIdentifierError("database-missing", "DATABASE_URL is required.");
  const host = databaseHost(databaseUrl);
  const production = process.env.APP_ENV === "production";
  const client = new pg.Client(verifiedDatabaseConnectionConfig(databaseUrl, "contracttwin-microsoft-oid-cutover", {
    requireVerifiedTls: production || !LOCAL_HOSTS.has(host)
  }));
  await client.connect();
  try {
    const entraExport = exportPath ? await loadExport(exportPath) : null;
    const result = await executeMicrosoftAccountCutover({
      mode: command,
      client,
      pausedSignInConfirmed,
      audience: process.env.MICROSOFT_CLIENT_ID || "",
      tenantId: process.env.MICROSOFT_TENANT_ID || "",
      entraExport,
      loadJwks: () => jwksPath ? loadJwksFile(jwksPath) : fetchMicrosoftJwks(process.env.MICROSOFT_TENANT_ID || ""),
      assertProductionTarget: async (heldClient) => {
        if (!production) return;
        await assertHeldPreMigrationTargetChallenge(heldClient, { withinTransaction: true });
        await assertTrustedMigrationTarget(heldClient);
      }
    });
    console.log(formatCutoverReport(result));
    if (!result.applicable || (command === "apply" && !result.applied)) process.exitCode = 1;
  } finally {
    await client.end();
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : "Microsoft account cutover failed.";
    console.error(redactDatabaseUrl(message));
    process.exitCode = 1;
  });
}
