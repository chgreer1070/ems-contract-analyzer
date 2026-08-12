import {betterAuth} from "better-auth";
import {getMigrations} from "better-auth/db/migration";
import pg from "pg";
import {assertTrustedMigrationTarget,verifiedDatabaseConnectionConfig} from "./database-connection-config.mjs";
import {
  assertDatabaseSchemaMigrationReceiptPrefix,
  assertSchemaMigrationManifestMatchesRepository,
  MIGRATION_ADVISORY_XACT_LOCK_QUERY
} from "./schema-migration-manifest.mjs";
import {assertHeldPreMigrationTargetChallenge} from "./release-target-binding.mjs";

const {Pool}=pg;
if(!process.env.DATABASE_URL)throw new Error("DATABASE_URL is required.");
const manifest=await assertSchemaMigrationManifestMatchesRepository(process.cwd());

// Better Auth's Kysely migrator may reserve connections independently of the
// client that holds ContractTwin's migration advisory lock. Validate every
// reserved pg client against the parent schema gate's still-held live target
// challenge before Kysely can introspect or execute DDL.
class TargetBoundMigrationPool extends Pool{
  connect(callback){
    if(typeof callback==="function"){
      return super.connect((error,client,release)=>{
        if(error){callback(error);return;}
        assertHeldPreMigrationTargetChallenge(client)
          .then(()=>callback(null,client,release),bindingError=>{
            release(bindingError);
            callback(bindingError);
          });
      });
    }
    return super.connect().then(async client=>{
      try{
        await assertHeldPreMigrationTargetChallenge(client);
        return client;
      }catch(error){
        client.release(error);
        throw error;
      }
    });
  }
}

const pool=new TargetBoundMigrationPool({
  ...verifiedDatabaseConnectionConfig(process.env.DATABASE_URL,"contracttwin-auth-migrator",{requireVerifiedTls:process.env.APP_ENV==="production"})
});

let targetClient;
let transactionOpen=false;
try{
  targetClient=await pool.connect();
  await assertTrustedMigrationTarget(targetClient);
  await targetClient.query("begin");
  transactionOpen=true;
  await assertHeldPreMigrationTargetChallenge(targetClient,{withinTransaction:true});
  await targetClient.query(MIGRATION_ADVISORY_XACT_LOCK_QUERY);
  await assertDatabaseSchemaMigrationReceiptPrefix(targetClient,manifest,"Pre-auth database");
  const migrationAuth=betterAuth({database:pool});
  const {toBeCreated,toBeAdded,compileMigrations}=await getMigrations(migrationAuth.options);
  console.log(`Better Auth schema: ${toBeCreated.length} tables to create, ${toBeAdded.length} fields/indexes to add.`);
  if(toBeCreated.length||toBeAdded.length){
    const compiledAuthMigrationSql=await compileMigrations();
    if(!compiledAuthMigrationSql.trim())throw new Error("Better Auth returned an empty migration plan for pending schema changes.");
    await assertHeldPreMigrationTargetChallenge(targetClient,{withinTransaction:true});
    await targetClient.query(compiledAuthMigrationSql);
  }
  await assertHeldPreMigrationTargetChallenge(targetClient,{withinTransaction:true});
  await assertDatabaseSchemaMigrationReceiptPrefix(targetClient,manifest,"Post-auth database");
  await assertTrustedMigrationTarget(targetClient);
  await targetClient.query("commit");
  transactionOpen=false;
  console.log("Better Auth schema migration complete.");
}finally{
  if(targetClient&&transactionOpen){try{await targetClient.query("rollback");}catch{}}
  targetClient?.release();
  await pool.end();
}
