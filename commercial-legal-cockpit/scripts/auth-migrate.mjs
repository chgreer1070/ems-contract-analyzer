import {betterAuth} from "better-auth";
import {getMigrations} from "better-auth/db/migration";
import pg from "pg";
import {assertTrustedMigrationTarget,verifiedDatabaseConnectionConfig} from "./database-connection-config.mjs";
import {
  assertDatabaseSchemaMigrationReceiptPrefix,
  assertSchemaMigrationManifestMatchesRepository,
  MIGRATION_ADVISORY_LOCK_QUERY,
  MIGRATION_ADVISORY_UNLOCK_QUERY
} from "./schema-migration-manifest.mjs";

const {Pool}=pg;
if(!process.env.DATABASE_URL)throw new Error("DATABASE_URL is required.");
const manifest=await assertSchemaMigrationManifestMatchesRepository(process.cwd());
const pool=new Pool({
  ...verifiedDatabaseConnectionConfig(process.env.DATABASE_URL,"contracttwin-auth-migrator",{requireVerifiedTls:process.env.APP_ENV==="production"})
});

let targetClient;
let migrationLockHeld=false;
try{
  targetClient=await pool.connect();
  await assertTrustedMigrationTarget(targetClient);
  await targetClient.query(MIGRATION_ADVISORY_LOCK_QUERY);
  migrationLockHeld=true;
  await assertDatabaseSchemaMigrationReceiptPrefix(targetClient,manifest,"Pre-auth database");
  const migrationAuth=betterAuth({database:pool});
  const {toBeCreated,toBeAdded,runMigrations}=await getMigrations(migrationAuth.options);
  console.log(`Better Auth schema: ${toBeCreated.length} tables to create, ${toBeAdded.length} fields/indexes to add.`);
  await runMigrations();
  await assertDatabaseSchemaMigrationReceiptPrefix(targetClient,manifest,"Post-auth database");
  await assertTrustedMigrationTarget(targetClient);
  console.log("Better Auth schema migration complete.");
}finally{
  if(targetClient&&migrationLockHeld){try{await targetClient.query(MIGRATION_ADVISORY_UNLOCK_QUERY);}catch{}}
  targetClient?.release();
  await pool.end();
}
