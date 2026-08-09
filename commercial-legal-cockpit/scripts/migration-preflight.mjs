import pg from "pg";
import {assertTrustedMigrationTarget,verifiedDatabaseConnectionConfig} from "./database-connection-config.mjs";
import {
  assertDatabaseSchemaMigrationReceiptPrefix,
  assertPristineProductionBootstrapTarget,
  assertSchemaMigrationManifestMatchesRepository,
  MIGRATION_ADVISORY_XACT_LOCK_QUERY
} from "./schema-migration-manifest.mjs";
import {assertHeldPreMigrationTargetChallenge} from "./release-target-binding.mjs";

const {Client}=pg;
if(!process.env.DATABASE_URL)throw new Error("DATABASE_URL is required.");
const manifest=await assertSchemaMigrationManifestMatchesRepository(process.cwd());
const client=new Client(verifiedDatabaseConnectionConfig(process.env.DATABASE_URL,"contracttwin-migration-preflight",{requireVerifiedTls:process.env.APP_ENV==="production"}));
await client.connect();
let transactionOpen=false;
try{
  await assertTrustedMigrationTarget(client);
  await client.query("begin transaction read only");
  transactionOpen=true;
  await assertHeldPreMigrationTargetChallenge(client,{withinTransaction:true});
  await client.query(MIGRATION_ADVISORY_XACT_LOCK_QUERY);
  const result=await assertDatabaseSchemaMigrationReceiptPrefix(client,manifest,"Preflight database");
  if(process.env.APP_ENV==="production"&&result.rows.length===0){
    if(result.historyExists)throw new Error("Production bootstrap rejects an empty pre-existing migration-history table.");
    await assertPristineProductionBootstrapTarget(client,"Production bootstrap database",{requireExternalAnchor:true});
  }
  await assertTrustedMigrationTarget(client);
  await client.query("commit");
  transactionOpen=false;
  console.log(`Migration preflight passed: ${result.rows.length} existing receipt(s) form an exact canonical-LF manifest prefix; no schema mutation was performed.`);
}finally{
  if(transactionOpen){try{await client.query("rollback");}catch{}}
  await client.end();
}
