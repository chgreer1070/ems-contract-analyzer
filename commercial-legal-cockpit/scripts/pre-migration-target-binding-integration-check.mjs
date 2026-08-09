import assert from "node:assert/strict";
import pg from "pg";
import {
  assertHeldPreMigrationTargetChallenge,
  verifyPreMigrationTargetBinding
} from "./release-target-binding.mjs";
import {verifiedDatabaseConnectionConfig} from "./database-connection-config.mjs";

const {Client}=pg;
const migrationConnectionString=process.env.DATABASE_URL||"";
const runtimeConnectionString=process.env.RUNTIME_DATABASE_URL||"";
if(!migrationConnectionString||!runtimeConnectionString){
  throw new Error("Owner and restricted-runtime database URLs are required for live target-binding fixtures.");
}

function withDatabase(connectionString,databaseName){
  const url=new URL(connectionString);
  url.pathname=`/${encodeURIComponent(databaseName)}`;
  return url.toString();
}

async function publicRelationCount(connectionString,label){
  const client=new Client(verifiedDatabaseConnectionConfig(connectionString,label));
  try{
    await client.connect();
    return Number((await client.query(`
      select count(*)::int count
        from pg_catalog.pg_class c
        join pg_catalog.pg_namespace n on n.oid OPERATOR(pg_catalog.=) c.relnamespace
       where n.nspname OPERATOR(pg_catalog.=) 'public'
         and c.relkind OPERATOR(pg_catalog.=) any(array['r','p','v','m','S','f']::"char"[])
    `)).rows[0].count);
  }finally{await client.end();}
}

const binding=await verifyPreMigrationTargetBinding({
  migrationConnectionString,
  runtimeConnectionString,
  requireVerifiedTls:false
});
try{
  const checkedClient=new Client(verifiedDatabaseConnectionConfig(
    migrationConnectionString,
    "contracttwin-live-target-fixture"
  ));
  try{
    await checkedClient.connect();
    await assertHeldPreMigrationTargetChallenge(checkedClient,{
      encodedChallenge:binding.challenge,
      expectedFingerprint:binding.liveDatabaseFingerprint
    });
  }finally{await checkedClient.end();}
}finally{await binding.release();}

const crossedRuntimeConnectionString=withDatabase(runtimeConnectionString,"postgres");
const crossedCountBefore=await publicRelationCount(crossedRuntimeConnectionString,"contracttwin-crossed-target-before");
await assert.rejects(
  ()=>verifyPreMigrationTargetBinding({
    migrationConnectionString,
    runtimeConnectionString:crossedRuntimeConnectionString,
    requireVerifiedTls:false
  }),
  /Pre-migration target binding failed/
);
assert.equal(
  await publicRelationCount(crossedRuntimeConnectionString,"contracttwin-crossed-target-after"),
  crossedCountBefore,
  "crossed target rejection must not persist schema changes"
);

console.log("Pre-migration live-target integration passed: distinct roles on the exact database succeed; a crossed logical database fails without persistent mutation.");
