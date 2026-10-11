import { createHash } from "node:crypto";
import { normalizedDatabaseEndpoint } from "./production-target-anchor.mjs";
import { assertExactSchemaMigrationReceipts } from "./schema-migration-manifest.mjs";
import { RUNTIME_DATABASE_PRINCIPAL_QUERY, evaluateRuntimeDatabasePrincipal } from "./runtime-database-principal.mjs";

const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/;
const AUTH_VARIABLES = ["BETTER_AUTH_SECRET", "BETTER_AUTH_URL", "MICROSOFT_CLIENT_ID", "MICROSOFT_CLIENT_SECRET", "MICROSOFT_TENANT_ID"];
function present(env, name) { return typeof env[name] === "string" && env[name].trim().length > 0; }

/** Version 1 binds host, port, database and username, including pooled tenant IDs.
 * Passwords are deliberately excluded so credential rotation preserves identity. */
export function pdfTestDatabaseTargetSha256(connectionString) {
  const endpoint = normalizedDatabaseEndpoint(connectionString);
  const username = decodeURIComponent(new URL(connectionString).username);
  if (!username) throw new Error("Test database username is required.");
  return createHash("sha256").update(JSON.stringify([endpoint.hostname, endpoint.port, endpoint.databaseName, username]), "utf8").digest("hex");
}

export function inspectPdfTestConfiguration(env) {
  const checks = [];
  function check(id, variables, pass, problem) {
    checks.push({ id, variables, pass, ...(pass ? {} : { problem }) });
  }
  check("nonproduction", ["APP_ENV", "VERCEL_ENV"],
    ["test", "preview"].includes(env.APP_ENV) && (env.VERCEL_ENV === undefined || ["preview", "development"].includes(env.VERCEL_ENV)),
    "Use APP_ENV=test or preview; production and ambiguous environment selectors are rejected.");
  check("feature-disabled", ["PDF_PREPARATION_ENABLED"], env.PDF_PREPARATION_ENABLED === undefined || env.PDF_PREPARATION_ENABLED === "false",
    "Keep PDF_PREPARATION_ENABLED unset or false throughout preflight.");
  check("synthetic-only", ["PDF_PREPARATION_TEST_DATA"], env.PDF_PREPARATION_TEST_DATA === "synthetic-only",
    "Declare synthetic-only test data. This declaration does not inspect or approve actual documents.");
  let databaseValid = false;
  try {
    const url = new URL(env.DATABASE_URL);
    databaseValid = Boolean(url.password) && url.searchParams.getAll("sslmode").length === 1 && url.searchParams.get("sslmode") === "verify-full" &&
      pdfTestDatabaseTargetSha256(env.DATABASE_URL) === env.PDF_PREPARATION_TEST_DATABASE_TARGET_SHA256 && SHA256.test(env.PDF_PREPARATION_TEST_DATABASE_TARGET_SHA256 || "");
  } catch { /* Fixed diagnostic below never includes URL or credentials. */ }
  check("database-target", ["DATABASE_URL", "PDF_PREPARATION_TEST_DATABASE_TARGET_SHA256"], databaseValid,
    "Supply a verified-TLS PostgreSQL URL matching the separately reviewed test-target SHA-256.");
  check("database-identity", ["PDF_PREPARATION_TEST_DATABASE_ID"], UUID.test(env.PDF_PREPARATION_TEST_DATABASE_ID || ""),
    "Supply the reviewed physical test database UUID from release_database_identity.");
  check("transport-overrides", ["NODE_TLS_REJECT_UNAUTHORIZED", "PGOPTIONS", "PGSSLMODE"],
    ["NODE_TLS_REJECT_UNAUTHORIZED", "PGOPTIONS", "PGSSLMODE"].every(name => env[name] === undefined),
    "Remove inherited TLS and PostgreSQL option overrides.");
  let authUrlValid = false;
  try { const url = new URL(env.BETTER_AUTH_URL); authUrlValid = url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash; } catch {}
  check("authentication", ["AUTH_REQUIRED", ...AUTH_VARIABLES], env.AUTH_REQUIRED === "true" && AUTH_VARIABLES.every(name => present(env, name)) &&
    env.BETTER_AUTH_SECRET.trim().length >= 32 && authUrlValid,
    "Require authentication, a secret of at least 32 characters, an HTTPS auth URL, and the app's Microsoft provider configuration.");
  check("private-storage", ["BLOB_READ_WRITE_TOKEN"], present(env, "BLOB_READ_WRITE_TOKEN"),
    "Supply a dedicated test private-Blob credential through the secret store; presence does not prove scope or access.");
  const port = Number(env.CLAMAV_PORT || "3310"); const timeout = Number(env.CLAMAV_TIMEOUT_MS || "60000");
  check("malware-scanner", ["CLAMAV_HOST", "CLAMAV_PORT", "CLAMAV_TIMEOUT_MS"], present(env, "CLAMAV_HOST") &&
    Number.isInteger(port) && port >= 1 && port <= 65535 && Number.isFinite(timeout) && timeout >= 1000 && timeout <= 300000,
    "Supply a reachable test ClamAV host with a valid port and timeout; configuration does not prove detection.");
  const required = ["APP_ENV", "PDF_PREPARATION_TEST_DATA", "DATABASE_URL", "PDF_PREPARATION_TEST_DATABASE_TARGET_SHA256", "PDF_PREPARATION_TEST_DATABASE_ID", "AUTH_REQUIRED", ...AUTH_VARIABLES, "BLOB_READ_WRITE_TOKEN", "CLAMAV_HOST"];
  const configurationComplete = checks.every(item => item.pass);
  return {
    version: 1, mode: "CONFIGURATION_ONLY", status: configurationComplete ? "CONFIGURATION_PRESENT_NOT_VERIFIED" : "BLOCKED",
    configurationComplete, liveValidationPassed: false, featureMayBeEnabled: false,
    missingVariables: required.filter(name => !present(env, name)), checks
  };
}

export function pdfTestDatabaseCheckPermitted(report) {
  const required = ["nonproduction", "feature-disabled", "synthetic-only", "database-target", "database-identity", "transport-overrides"];
  return required.every(id => report.checks.find(check => check.id === id)?.pass === true);
}

/** Metadata/catalog reads only. A missing production marker is not proof of
 * nonproduction: the operator must separately approve the target identity. */
export async function inspectReadOnlyPdfTestDatabase(client, expectedId, manifest) {
  if (!UUID.test(expectedId || "")) throw new Error("Test database identity is invalid.");
  await client.query("BEGIN READ ONLY");
  try {
    await client.query("SET LOCAL statement_timeout='4s'");
    await client.query("SET LOCAL lock_timeout='1s'");
    await client.query("SET LOCAL idle_in_transaction_session_timeout='5s'");
    const marker = (await client.query("select pg_catalog.to_regclass('contracttwin_control.production_target_binding')::text as production_binding")).rows;
    if (marker.length !== 1 || marker[0].production_binding !== null) throw new Error("Production-bound or ambiguous database targets are rejected.");
    const identity = (await client.query("select database_id::text from public.release_database_identity where singleton=true")).rows;
    if (identity.length !== 1 || typeof identity[0].database_id !== "string" || identity[0].database_id.toLowerCase() !== expectedId.toLowerCase()) throw new Error("Test database identity does not match the reviewed target.");
    const receipts = (await client.query("select filename,sha256 from public.schema_migrations order by filename")).rows;
    assertExactSchemaMigrationReceipts(receipts, manifest, "PDF test target");
    const principal = evaluateRuntimeDatabasePrincipal((await client.query(RUNTIME_DATABASE_PRINCIPAL_QUERY)).rows[0]);
    if (!principal.ok) throw new Error("Test database principal did not pass the existing least-privilege controls.");
    return { databaseMetadataChecksPassed: true, migrationReceiptCount: receipts.length, principalChecks: principal.checkedCount, liveValidationPassed: false, featureMayBeEnabled: false };
  } finally { await client.query("ROLLBACK"); }
}
