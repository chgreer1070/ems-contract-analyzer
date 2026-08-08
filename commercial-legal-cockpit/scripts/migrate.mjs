import pg from "pg";
import {assertTrustedMigrationTarget,verifiedDatabaseConnectionConfig} from "./database-connection-config.mjs";
import {loadCanonicalMigrationSources} from "./migration-source.mjs";
import {
  assertDatabaseSchemaMigrationReceiptPrefix,
  assertExactSchemaMigrationReceipts,
  loadSchemaMigrationManifest,
  MIGRATION_ADVISORY_LOCK_QUERY,
  MIGRATION_ADVISORY_UNLOCK_QUERY
} from "./schema-migration-manifest.mjs";

const {Client}=pg;
if(!process.env.DATABASE_URL)throw new Error("DATABASE_URL is required.");
const migrations=await loadCanonicalMigrationSources(process.cwd());
const manifest=await loadSchemaMigrationManifest();
const repositoryReceipts=migrations.map(({filename,sha256})=>({filename,sha256}));
assertExactSchemaMigrationReceipts(repositoryReceipts,manifest,"Repository");

const client=new Client(verifiedDatabaseConnectionConfig(process.env.DATABASE_URL,"contracttwin-migrator",{requireVerifiedTls:process.env.APP_ENV==="production"}));
await client.connect();
let migrationLockHeld=false;
try{
  await assertTrustedMigrationTarget(client);
  await client.query(MIGRATION_ADVISORY_LOCK_QUERY);
  migrationLockHeld=true;
  const {historyExists,rows:appliedRows}=await assertDatabaseSchemaMigrationReceiptPrefix(client,manifest,"Applied database");
  if(!historyExists){
    await client.query("create table public.schema_migrations(filename text primary key,sha256 text not null,applied_at timestamptz not null default now())");
  }
  const appliedFilenames=new Set(appliedRows.map(row=>row.filename));
  for(const migration of migrations){
    if(appliedFilenames.has(migration.filename)){
      console.log(`skip ${migration.filename} (already applied)`);
      continue;
    }
    console.log(`apply ${migration.filename}`);
    await client.query("BEGIN");
    try{
      await client.query(migration.sql);
      await client.query("insert into public.schema_migrations(filename,sha256) values($1,$2)",[migration.filename,migration.sha256]);
      await client.query("COMMIT");
    }catch(error){
      await client.query("ROLLBACK");
      throw error;
    }
  }
  const completed=await client.query("select filename,sha256 from public.schema_migrations order by filename");
  assertExactSchemaMigrationReceipts(completed.rows,manifest,"Completed database");
  await assertTrustedMigrationTarget(client);
  console.log(`Migration complete: ${migrations.length} canonical-LF migration files verified.`);
}finally{
  if(migrationLockHeld){try{await client.query(MIGRATION_ADVISORY_UNLOCK_QUERY);}catch{}}
  await client.end();
}
