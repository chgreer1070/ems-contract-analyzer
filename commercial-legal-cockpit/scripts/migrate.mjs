import pg from "pg";
import {assertTrustedMigrationTarget,verifiedDatabaseConnectionConfig} from "./database-connection-config.mjs";
import {loadCanonicalMigrationSources} from "./migration-source.mjs";
import {
  assertDatabaseSchemaMigrationReceiptPrefix,
  assertExactSchemaMigrationReceipts,
  loadSchemaMigrationManifest,
  MIGRATION_ADVISORY_XACT_LOCK_QUERY
} from "./schema-migration-manifest.mjs";
import {assertHeldPreMigrationTargetChallenge} from "./release-target-binding.mjs";
import {PRODUCTION_DATABASE_ID_PATTERN} from "./production-target-anchor.mjs";

const {Client}=pg;
if(!process.env.DATABASE_URL)throw new Error("DATABASE_URL is required.");
const expectedProductionDatabaseId=process.env.EXPECTED_PRODUCTION_DATABASE_ID||"";
if(process.env.APP_ENV==="production"&&!PRODUCTION_DATABASE_ID_PATTERN.test(expectedProductionDatabaseId)){
  throw new Error("Production application migration requires the externally approved database ID.");
}
const migrations=await loadCanonicalMigrationSources(process.cwd());
const manifest=await loadSchemaMigrationManifest();
const repositoryReceipts=migrations.map(({filename,sha256})=>({filename,sha256}));
assertExactSchemaMigrationReceipts(repositoryReceipts,manifest,"Repository");

const client=new Client(verifiedDatabaseConnectionConfig(process.env.DATABASE_URL,"contracttwin-migrator",{requireVerifiedTls:process.env.APP_ENV==="production"}));
await client.connect();
let transactionOpen=false;
try{
  await assertTrustedMigrationTarget(client);
  await client.query("begin");
  transactionOpen=true;
  await assertHeldPreMigrationTargetChallenge(client,{withinTransaction:true});
  await client.query(MIGRATION_ADVISORY_XACT_LOCK_QUERY);
  if(process.env.APP_ENV==="production"){
    await client.query("select pg_catalog.set_config('contracttwin.expected_database_id',$1,true)",[expectedProductionDatabaseId]);
  }
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
    await assertHeldPreMigrationTargetChallenge(client,{withinTransaction:true});
    await client.query(migration.sql);
    await client.query("insert into public.schema_migrations(filename,sha256) values($1,$2)",[migration.filename,migration.sha256]);
  }
  const completed=await client.query("select filename,sha256 from public.schema_migrations order by filename");
  assertExactSchemaMigrationReceipts(completed.rows,manifest,"Completed database");
  await assertTrustedMigrationTarget(client);
  await client.query("commit");
  transactionOpen=false;
  console.log(`Migration complete: ${migrations.length} canonical-LF migration files verified.`);
}finally{
  if(transactionOpen){try{await client.query("rollback");}catch{}}
  await client.end();
}
