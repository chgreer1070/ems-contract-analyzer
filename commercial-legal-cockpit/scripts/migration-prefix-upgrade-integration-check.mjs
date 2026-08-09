import assert from "node:assert/strict";
import {randomBytes,randomUUID} from "node:crypto";
import pg from "pg";
import {verifiedDatabaseConnectionConfig} from "./database-connection-config.mjs";
import {loadCanonicalMigrationSources} from "./migration-source.mjs";
import {
  assertDatabaseSchemaMigrationReceiptPrefix,
  assertExactSchemaMigrationReceipts,
  loadSchemaMigrationManifest
} from "./schema-migration-manifest.mjs";

const {Client}=pg;
const ownerConnectionString=process.env.DATABASE_URL||"";
if(
  process.env.CI!=="true"||
  process.env.GITHUB_ACTIONS!=="true"||
  process.env.CI_DATABASE_CONTROL_FIXTURE!=="disposable-postgres-service"
){
  throw new Error("Migration prefix-upgrade integration is restricted to the marked disposable GitHub Actions PostgreSQL service.");
}
const ownerUrl=new URL(ownerConnectionString);
if(!["localhost","127.0.0.1","[::1]"].includes(ownerUrl.hostname)||decodeURIComponent(ownerUrl.pathname)!=="/contracttwin"){
  throw new Error("Migration prefix-upgrade integration refused a non-loopback or non-ephemeral owner target.");
}

function quoteIdentifier(value){return `"${String(value).replaceAll('"','""')}"`;}

const suffix=randomBytes(6).toString("hex");
const databaseName=`contracttwin_upgrade_${suffix}`;
const maintenanceUrl=new URL(ownerUrl);maintenanceUrl.pathname="/postgres";
const admin=new Client(verifiedDatabaseConnectionConfig(maintenanceUrl.toString(),"contracttwin-prefix-upgrade-admin"));
let databaseCreated=false;
try{
  await admin.connect();
  await admin.query(`create database ${quoteIdentifier(databaseName)}`);
  databaseCreated=true;
  const databaseUrl=new URL(ownerUrl);databaseUrl.pathname=`/${databaseName}`;
  const client=new Client(verifiedDatabaseConnectionConfig(databaseUrl.toString(),"contracttwin-prefix-upgrade-fixture"));
  try{
    await client.connect();
    const migrations=await loadCanonicalMigrationSources(process.cwd());
    const manifest=await loadSchemaMigrationManifest();
    const committedPrefix=migrations.slice(0,10);
    assert.equal(committedPrefix.at(-1)?.filename,"010_release_target_binding.sql");
    await client.query("create table public.schema_migrations(filename text primary key,sha256 text not null,applied_at timestamptz not null default clock_timestamp())");
    for(const migration of committedPrefix){
      await client.query(migration.sql);
      await client.query("insert into public.schema_migrations(filename,sha256) values($1,$2)",[migration.filename,migration.sha256]);
    }
    const physicalBefore=(await client.query("select database_id::text database_id from public.release_database_identity where singleton=true")).rows[0]?.database_id;
    assert.match(physicalBefore,/^[0-9a-f-]{36}$/i);
    const priorReceipt={
      nonceSha256:randomBytes(32).toString("hex"),
      sourceSha:randomBytes(20).toString("hex")
    };
    await client.query(
      "insert into public.release_target_receipts(nonce_sha256,database_id,source_sha) values($1,$2,$3)",
      [priorReceipt.nonceSha256,physicalBefore,priorReceipt.sourceSha]
    );
    const releaseReceiptBefore=(await client.query(`
      select nonce_sha256,database_id::text database_id,source_sha,created_at::text created_at
        from public.release_target_receipts
       where nonce_sha256=$1
    `,[priorReceipt.nonceSha256])).rows[0];
    const prefixBefore=(await client.query("select filename,sha256 from public.schema_migrations order by filename")).rows;
    const prefixEvidence=await assertDatabaseSchemaMigrationReceiptPrefix(client,manifest,"Committed migration-010 fixture");
    assert.equal(prefixEvidence.rows.length,10,"an already-applied migration-010 database must be accepted as an exact receipt prefix");

    const externalDatabaseId=randomUUID();
    await client.query("begin");
    await client.query("select pg_catalog.set_config('contracttwin.expected_database_id',$1,true)",[externalDatabaseId]);
    for(const migration of migrations.slice(10)){
      await client.query(migration.sql);
      await client.query("insert into public.schema_migrations(filename,sha256) values($1,$2)",[migration.filename,migration.sha256]);
    }
    await client.query("commit");

    const completed=(await client.query("select filename,sha256 from public.schema_migrations order by filename")).rows;
    assertExactSchemaMigrationReceipts(completed,manifest,"Upgraded migration-010 fixture");
    assert.deepEqual(completed.slice(0,10),prefixBefore,"forward upgrade must not rewrite any committed migration receipt");
    const mapped=(await client.query(`
      select external.external_database_id::text external_database_id,
             external.release_database_id::text release_database_id,
             physical.database_id::text physical_database_id
        from public.release_database_external_identity external
        join public.release_database_identity physical on physical.database_id=external.release_database_id
       where external.singleton=true and physical.singleton=true
    `)).rows;
    assert.equal(mapped.length,1);
    assert.equal(mapped[0].external_database_id,externalDatabaseId);
    assert.equal(mapped[0].release_database_id,physicalBefore,"migration 014 must preserve the existing physical identity");
    assert.equal(mapped[0].physical_database_id,physicalBefore);
    const releaseReceiptAfter=(await client.query(`
      select receipt.nonce_sha256,receipt.database_id::text database_id,receipt.source_sha,receipt.created_at::text created_at,
             external.external_database_id::text external_database_id
        from public.release_target_receipts receipt
        join public.release_database_external_identity external on external.release_database_id=receipt.database_id
       where receipt.nonce_sha256=$1
    `,[priorReceipt.nonceSha256])).rows[0];
    assert.deepEqual(
      {
        nonce_sha256:releaseReceiptAfter.nonce_sha256,
        database_id:releaseReceiptAfter.database_id,
        source_sha:releaseReceiptAfter.source_sha,
        created_at:releaseReceiptAfter.created_at
      },
      releaseReceiptBefore,
      "forward identity mapping must not rewrite an existing release receipt"
    );
    assert.equal(releaseReceiptAfter.external_database_id,externalDatabaseId,"the preserved physical receipt must resolve through the new external identity mapping");
    await assert.rejects(
      ()=>client.query("update public.release_database_external_identity set external_database_id=$1 where singleton=true",[randomUUID()]),
      /external identity is immutable/,
      "a different logical ID must not rewrite an applied mapping"
    );
    const rerunPrefix=await assertDatabaseSchemaMigrationReceiptPrefix(client,manifest,"Idempotent upgraded fixture");
    assert.equal(rerunPrefix.rows.length,migrations.length);
    assertExactSchemaMigrationReceipts(rerunPrefix.rows,manifest,"Idempotent upgraded fixture");
  }finally{await client.end();}
  console.log("Migration prefix-upgrade integration passed: an exact 001-010 receipt prefix upgrades forward through 014 without rewriting migration 010, its physical identity, schema receipts, or a prior release receipt.");
}finally{
  if(databaseCreated){
    await admin.query("select pg_catalog.pg_terminate_backend(pid) from pg_catalog.pg_stat_activity where datname=$1 and pid<>pg_catalog.pg_backend_pid()",[databaseName]);
    await admin.query(`drop database ${quoteIdentifier(databaseName)}`);
  }
  await admin.end();
}
