import pg from "pg";
import {assertTrustedMigrationTarget,verifiedDatabaseConnectionConfig} from "./database-connection-config.mjs";
import {
  assertDatabaseSchemaMigrationReceiptPrefix,
  assertSchemaMigrationManifestMatchesRepository,
  MIGRATION_ADVISORY_LOCK_QUERY,
  MIGRATION_ADVISORY_UNLOCK_QUERY
} from "./schema-migration-manifest.mjs";

const {Client}=pg;
if(!process.env.DATABASE_URL)throw new Error("DATABASE_URL is required.");
const manifest=await assertSchemaMigrationManifestMatchesRepository(process.cwd());
const client=new Client(verifiedDatabaseConnectionConfig(process.env.DATABASE_URL,"contracttwin-migration-preflight",{requireVerifiedTls:process.env.APP_ENV==="production"}));
await client.connect();
let migrationLockHeld=false;
try{
  await assertTrustedMigrationTarget(client);
  await client.query(MIGRATION_ADVISORY_LOCK_QUERY);
  migrationLockHeld=true;
  const result=await assertDatabaseSchemaMigrationReceiptPrefix(client,manifest,"Preflight database");
  await assertTrustedMigrationTarget(client);
  console.log(`Migration preflight passed: ${result.rows.length} existing receipt(s) form an exact canonical-LF manifest prefix; no schema mutation was performed.`);
}finally{
  if(migrationLockHeld){try{await client.query(MIGRATION_ADVISORY_UNLOCK_QUERY);}catch{}}
  await client.end();
}
