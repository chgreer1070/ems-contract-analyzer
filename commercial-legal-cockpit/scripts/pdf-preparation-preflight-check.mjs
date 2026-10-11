import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { inspectPdfTestConfiguration, pdfTestDatabaseCheckPermitted, pdfTestDatabaseTargetSha256, inspectReadOnlyPdfTestDatabase } from "./pdf-preparation-test-environment.mjs";
import { loadSchemaMigrationManifest } from "./schema-migration-manifest.mjs";
import { REQUIRED_RUNTIME_DATABASE_PRINCIPAL_FIELDS } from "./runtime-database-principal.mjs";

let count = 0;
async function check(name, fn) { await fn(); count++; console.log(`PASS ${name}`); }
const id = "22222222-2222-4222-8222-222222222222";
const databaseUrl = "postgresql://runtime.tenant:SYNTHETIC_PASSWORD@pool.example.invalid:5432/postgres?sslmode=verify-full";
const ready = {
  APP_ENV: "test", PDF_PREPARATION_TEST_DATA: "synthetic-only", DATABASE_URL: databaseUrl,
  PDF_PREPARATION_TEST_DATABASE_TARGET_SHA256: pdfTestDatabaseTargetSha256(databaseUrl), PDF_PREPARATION_TEST_DATABASE_ID: id,
  AUTH_REQUIRED: "true", BETTER_AUTH_SECRET: "SYNTHETIC_AUTH_SECRET_".repeat(3), BETTER_AUTH_URL: "https://pdf-test.example.invalid",
  MICROSOFT_CLIENT_ID: "synthetic-client", MICROSOFT_CLIENT_SECRET: "SYNTHETIC_PROVIDER_SECRET", MICROSOFT_TENANT_ID: "synthetic-tenant",
  BLOB_READ_WRITE_TOKEN: "SYNTHETIC_BLOB_SECRET", CLAMAV_HOST: "scanner.example.invalid"
};
const manifest = await loadSchemaMigrationManifest();
const folder = mkdtempSync(join(tmpdir(), "pdf-preflight-check-"));
const trap = join(folder, "network-trap.mjs");
writeFileSync(trap, "import net from 'node:net';net.Socket.prototype.connect=function(){throw new Error('SYNTHETIC_CONNECTION_SECRET');};");
function cli(args, env) {
  const inherited = { ...process.env };
  for (const name of [...Object.keys(ready), "VERCEL_ENV", "PDF_PREPARATION_ENABLED", "PGOPTIONS", "PGSSLMODE", "NODE_TLS_REJECT_UNAUTHORIZED"]) delete inherited[name];
  return spawnSync(process.execPath, ["--import", pathToFileURL(trap).href, "scripts/pdf-preparation-preflight.mjs", ...args], { env: { ...inherited, ...env }, encoding: "utf8", timeout: 7000 });
}
function database(overrides = {}) {
  const queries = [];
  const principal = Object.fromEntries(REQUIRED_RUNTIME_DATABASE_PRINCIPAL_FIELDS.map(name => [name, true]));
  return {
    queries, async query(sql) {
      queries.push(sql);
      if (sql.includes("to_regclass")) return { rows: overrides.markerRows ?? [{ production_binding: null }] };
      if (sql.includes("select database_id")) return { rows: overrides.identityRows ?? [{ database_id: id }] };
      if (sql.includes("select filename")) return { rows: overrides.receipts ?? manifest.migrations };
      if (sql.includes("with identities")) return { rows: [{ ...principal, ...overrides.principal }] };
      return { rows: [] };
    }
  };
}
try {
  await check("missing configuration is blocked and names the required settings", () => {
    const report = inspectPdfTestConfiguration({}); assert.equal(report.status, "BLOCKED");
    for (const name of ["DATABASE_URL", "BLOB_READ_WRITE_TOKEN", "CLAMAV_HOST", "BETTER_AUTH_SECRET"]) assert.ok(report.missingVariables.includes(name));
    assert.equal(pdfTestDatabaseCheckPermitted(report), false); assert.equal(report.featureMayBeEnabled, false);
  });
  await check("present configuration never claims live acceptance or permission to enable", () => {
    const report = inspectPdfTestConfiguration(ready); assert.equal(report.configurationComplete, true);
    assert.equal(report.status, "CONFIGURATION_PRESENT_NOT_VERIFIED"); assert.equal(report.liveValidationPassed, false); assert.equal(report.featureMayBeEnabled, false);
  });
  await check("production and ambiguous environment selectors block database probes", () => {
    for (const change of [{ APP_ENV: "production" }, { APP_ENV: "development" }, { APP_ENV: undefined }, { VERCEL_ENV: "production" }, { VERCEL_ENV: "PRODUCTION" }]) assert.equal(pdfTestDatabaseCheckPermitted(inspectPdfTestConfiguration({ ...ready, ...change })), false);
  });
  await check("enabled or ambiguous feature flags block database probes", () => {
    for (const flag of ["true", "TRUE", "1", ""]) assert.equal(pdfTestDatabaseCheckPermitted(inspectPdfTestConfiguration({ ...ready, PDF_PREPARATION_ENABLED: flag })), false);
    assert.equal(pdfTestDatabaseCheckPermitted(inspectPdfTestConfiguration({ ...ready, PDF_PREPARATION_ENABLED: "false" })), true);
  });
  await check("target hash preserves password rotation and separates pooled tenant usernames", () => {
    assert.equal(pdfTestDatabaseTargetSha256(databaseUrl.replace("SYNTHETIC_PASSWORD", "rotated")), ready.PDF_PREPARATION_TEST_DATABASE_TARGET_SHA256);
    const other = databaseUrl.replace("runtime.tenant", "runtime.other-tenant"); assert.notEqual(pdfTestDatabaseTargetSha256(other), ready.PDF_PREPARATION_TEST_DATABASE_TARGET_SHA256);
    assert.equal(pdfTestDatabaseCheckPermitted(inspectPdfTestConfiguration({ ...ready, DATABASE_URL: other })), false);
  });
  await check("unsafe database overrides and unverified transport are rejected", () => {
    for (const url of [databaseUrl + "&host=other.invalid", databaseUrl.replace("verify-full", "require"), databaseUrl + "&sslmode=verify-full", "not-a-url"]) assert.equal(pdfTestDatabaseCheckPermitted(inspectPdfTestConfiguration({ ...ready, DATABASE_URL: url })), false);
    for (const name of ["PGOPTIONS", "PGSSLMODE", "NODE_TLS_REJECT_UNAUTHORIZED"]) assert.equal(pdfTestDatabaseCheckPermitted(inspectPdfTestConfiguration({ ...ready, [name]: "override" })), false);
  });
  await check("weak authentication and invalid scanner settings remain blocked", () => {
    for (const change of [{ AUTH_REQUIRED: "false" }, { BETTER_AUTH_SECRET: "short" }, { BETTER_AUTH_URL: "http://test.invalid" }, { MICROSOFT_CLIENT_SECRET: undefined }, { CLAMAV_PORT: "0" }, { CLAMAV_TIMEOUT_MS: "1" }]) assert.equal(inspectPdfTestConfiguration({ ...ready, ...change }).configurationComplete, false);
  });
  await check("reports never contain credentials or private endpoint values", () => {
    const serialized = JSON.stringify(inspectPdfTestConfiguration(ready));
    for (const value of [ready.DATABASE_URL, ready.BETTER_AUTH_SECRET, ready.BLOB_READ_WRITE_TOKEN, ready.MICROSOFT_CLIENT_SECRET, ready.CLAMAV_HOST]) assert.equal(serialized.includes(value), false);
  });
  await check("default CLI performs no network calls even with complete configuration", () => {
    const result = cli([], ready); assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).mode, "CONFIGURATION_ONLY"); assert.equal(result.stderr.includes("SYNTHETIC_CONNECTION_SECRET"), false);
  });
  await check("blocked database CLI stops before any network call", () => {
    const result = cli(["--database-read-only"], {}); assert.equal(result.status, 2, result.stderr);
    assert.equal(JSON.parse(result.stdout).databaseMetadataChecksPassed, false); assert.equal(result.stderr.includes("SYNTHETIC_CONNECTION_SECRET"), false);
  });
  await check("connection errors produce sanitized JSON without raw provider diagnostics", () => {
    const result = cli(["--database-read-only"], ready); assert.equal(result.status, 1, result.stderr);
    assert.equal(JSON.parse(result.stdout).databaseMetadataChecksPassed, false);
    assert.equal((result.stdout + result.stderr).includes("SYNTHETIC_CONNECTION_SECRET"), false);
  });
  await check("database check uses read-only metadata queries and always rolls back", async () => {
    const client = database(); const evidence = await inspectReadOnlyPdfTestDatabase(client, id, manifest);
    assert.equal(evidence.databaseMetadataChecksPassed, true); assert.equal(evidence.liveValidationPassed, false); assert.equal(evidence.featureMayBeEnabled, false);
    assert.equal(client.queries[0], "BEGIN READ ONLY"); assert.equal(client.queries.at(-1), "ROLLBACK");
    assert.ok(client.queries.every(sql => /^(BEGIN READ ONLY|SET LOCAL|select |\nwith identities|ROLLBACK)/.test(sql)));
  });
  await check("production-bound target is rejected before identity or application reads", async () => {
    const client = database({ markerRows: [{ production_binding: "contracttwin_control.production_target_binding" }] });
    await assert.rejects(() => inspectReadOnlyPdfTestDatabase(client, id, manifest), /Production-bound/);
    assert.equal(client.queries.some(sql => sql.includes("select database_id")), false); assert.equal(client.queries.at(-1), "ROLLBACK");
  });
  await check("ambiguous or mismatched database identity fails closed", async () => {
    for (const rows of [[], [{ database_id: id }, { database_id: id }], [{ database_id: "wrong" }]]) {
      const client = database({ identityRows: rows }); await assert.rejects(() => inspectReadOnlyPdfTestDatabase(client, id, manifest), /identity does not match/);
      assert.equal(client.queries.some(sql => sql.includes("select filename")), false); assert.equal(client.queries.at(-1), "ROLLBACK");
    }
  });
  await check("migration drift and unsafe runtime privileges reject after rollback", async () => {
    const drift = database({ receipts: manifest.migrations.slice(1) }); await assert.rejects(() => inspectReadOnlyPdfTestDatabase(drift, id, manifest), /not exact/); assert.equal(drift.queries.at(-1), "ROLLBACK");
    const unsafe = database({ principal: { role_attributes_safe: false } }); await assert.rejects(() => inspectReadOnlyPdfTestDatabase(unsafe, id, manifest), /least-privilege/); assert.equal(unsafe.queries.at(-1), "ROLLBACK");
  });
  console.log(`${count} preflight checks passed. Database replies are mocked; no live provider or document writes occurred.`);
} finally { rmSync(folder, { recursive: true, force: true }); }
