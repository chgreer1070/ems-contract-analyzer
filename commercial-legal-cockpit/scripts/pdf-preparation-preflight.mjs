import { Client } from "pg";
import { verifiedDatabaseConnectionConfig } from "./database-connection-config.mjs";
import { assertSchemaMigrationManifestMatchesRepository } from "./schema-migration-manifest.mjs";
import { inspectPdfTestConfiguration, pdfTestDatabaseCheckPermitted, inspectReadOnlyPdfTestDatabase } from "./pdf-preparation-test-environment.mjs";

const args = process.argv.slice(2);
if (args.some(arg => arg !== "--database-read-only") || args.length > 1) {
  console.error("Usage: node scripts/pdf-preparation-preflight.mjs [--database-read-only]"); process.exitCode = 2;
} else {
  const report = inspectPdfTestConfiguration(process.env);
  if (args.length === 0) {
    console.log(JSON.stringify(report, null, 2)); process.exitCode = report.configurationComplete ? 0 : 2;
  } else if (!pdfTestDatabaseCheckPermitted(report)) {
    console.log(JSON.stringify({ ...report, mode: "DATABASE_READ_ONLY", databaseMetadataChecksPassed: false }, null, 2)); process.exitCode = 2;
  } else {
    let client;
    try {
      const manifest = await assertSchemaMigrationManifestMatchesRepository();
      client = new Client({ ...verifiedDatabaseConnectionConfig(process.env.DATABASE_URL, "contracttwin-pdf-test-preflight", { requireVerifiedTls: true }), connectionTimeoutMillis: 5000, query_timeout: 5000 });
      await client.connect();
      const evidence = await inspectReadOnlyPdfTestDatabase(client, process.env.PDF_PREPARATION_TEST_DATABASE_ID, manifest);
      console.log(JSON.stringify({ ...report, mode: "DATABASE_READ_ONLY", ...evidence }, null, 2));
      process.exitCode = report.configurationComplete ? 0 : 2;
    } catch {
      // Connection and provider diagnostics can contain private endpoint details.
      console.log(JSON.stringify({ ...report, mode: "DATABASE_READ_ONLY", databaseMetadataChecksPassed: false,
        problem: "Read-only database verification failed. Confirm approved target identity, exact migrations, connectivity, and least-privilege role with the operator." }, null, 2));
      process.exitCode = 1;
    } finally { if (client) await client.end().catch(() => { process.exitCode = 1; }); }
  }
}
