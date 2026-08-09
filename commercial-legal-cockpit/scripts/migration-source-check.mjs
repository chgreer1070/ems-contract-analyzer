import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import {canonicalizeMigrationSource,MIGRATION_RECEIPT_ALGORITHM} from "./migration-source.mjs";
import {
  assertDatabaseSchemaMigrationReceiptPrefix,
  assertPristineProductionBootstrapTarget,
  assertSchemaMigrationManifestMatchesRepository,
  evaluateSchemaMigrationReceiptPrefix,
  loadSchemaMigrationManifest
} from "./schema-migration-manifest.mjs";

const lf=canonicalizeMigrationSource(Buffer.from("select 1;\nselect 2;\n","utf8"),"LF fixture");
const crlf=canonicalizeMigrationSource(Buffer.from("select 1;\r\nselect 2;\r\n","utf8"),"CRLF fixture");
const cr=canonicalizeMigrationSource(Buffer.from("select 1;\rselect 2;\r","utf8"),"CR fixture");
assert.equal(crlf.sql,lf.sql,"CRLF migration execution text must canonicalize to LF");
assert.equal(cr.sql,lf.sql,"CR migration execution text must canonicalize to LF");
assert.equal(crlf.sha256,lf.sha256,"CRLF and LF migration receipts must be identical");
assert.equal(cr.sha256,lf.sha256,"CR and LF migration receipts must be identical");
assert.throws(()=>canonicalizeMigrationSource(Buffer.from([0xef,0xbb,0xbf,0x73]),"BOM fixture"),/without a byte-order mark/);
assert.throws(()=>canonicalizeMigrationSource(Buffer.from([0xc3,0x28]),"invalid UTF-8 fixture"),/valid UTF-8/);
assert.throws(()=>canonicalizeMigrationSource(Buffer.from("select\u0000 1;","utf8"),"NUL fixture"),/NUL/);

const manifest=await loadSchemaMigrationManifest();
assert.equal(manifest.version,2);
assert.equal(manifest.receiptAlgorithm,MIGRATION_RECEIPT_ALGORITHM);
await assertSchemaMigrationManifestMatchesRepository(process.cwd());
assert.equal(evaluateSchemaMigrationReceiptPrefix([],manifest).ok,true,"an empty database is a valid migration prefix");
assert.equal(evaluateSchemaMigrationReceiptPrefix(manifest.migrations.slice(0,5),manifest).ok,true,"an exact applied prefix is valid");
assert.equal(evaluateSchemaMigrationReceiptPrefix(manifest.migrations.filter((_,index)=>index!==2),manifest).ok,false,"a migration gap must fail before execution");
assert.equal(evaluateSchemaMigrationReceiptPrefix(manifest.migrations.map((row,index)=>index===0?{...row,sha256:"0".repeat(64)}:row),manifest).ok,false,"a legacy or forged receipt must fail before execution");

const emptyQueries=[];
const emptyTarget={query:async sql=>{
  emptyQueries.push(sql);
  if(sql.includes("to_regclass"))return {rows:[{relation_name:null}]};
  throw new Error(`Unexpected empty-target query: ${sql}`);
}};
const emptyResult=await assertDatabaseSchemaMigrationReceiptPrefix(emptyTarget,manifest,"Empty fixture");
assert.deepEqual(emptyResult,{historyExists:false,rows:[]},"an empty target must pass without creating migration history");
assert.ok(emptyQueries.every(sql=>/^select\b/iu.test(sql)),"empty-target preflight must remain read-only");

const pristineQueries=[];
const pristineTarget={query:async sql=>{
  pristineQueries.push(sql);
  return {rows:[{extra_schema_count:0,user_relation_count:0,user_routine_count:0,user_type_count:0,non_default_extension_count:0,anchor_relation_count:0}]};
}};
await assertPristineProductionBootstrapTarget(pristineTarget,"Pristine fixture");
await assert.rejects(()=>assertPristineProductionBootstrapTarget(pristineTarget,"Unanchored production fixture",{requireExternalAnchor:true}),/separately approved production target anchor/);
const anchoredPristineTarget={query:async()=>({rows:[{extra_schema_count:0,user_relation_count:0,user_routine_count:0,user_type_count:0,non_default_extension_count:0,anchor_relation_count:1}]})};
await assertPristineProductionBootstrapTarget(anchoredPristineTarget,"Anchored production fixture",{requireExternalAnchor:true});
assert.ok(pristineQueries.every(sql=>/^\s*select\b/iu.test(sql)),"production bootstrap proof must remain read-only");
const occupiedTarget={query:async()=>({rows:[{extra_schema_count:0,user_relation_count:1,user_routine_count:0,user_type_count:0,non_default_extension_count:0}]})};
await assert.rejects(()=>assertPristineProductionBootstrapTarget(occupiedTarget,"Occupied fixture"),/not a pristine dedicated database/);

const legacyQueries=[];
const legacyTarget={query:async sql=>{
  legacyQueries.push(sql);
  if(sql.includes("to_regclass"))return {rows:[{relation_name:"schema_migrations"}]};
  if(sql.includes("from public.schema_migrations"))return {rows:[{filename:"001_app.sql",sha256:"bd70d350653be6dafb85dc9e4303a45f3f7e5e439636839121965e21ce48e4fd"}]};
  throw new Error(`Unexpected legacy-target query: ${sql}`);
}};
await assert.rejects(()=>assertDatabaseSchemaMigrationReceiptPrefix(legacyTarget,manifest,"Legacy fixture"),/not an exact manifest prefix/);
assert.ok(legacyQueries.every(sql=>/^select\b/iu.test(sql)),"legacy-target rejection must occur through read-only queries");

const migrateSource=await fs.readFile(path.resolve("scripts/migrate.mjs"),"utf8");
const occursBefore=(before,after)=>{
  const beforeIndex=migrateSource.indexOf(before);
  const afterIndex=migrateSource.indexOf(after);
  return beforeIndex>=0&&afterIndex>=0&&beforeIndex<afterIndex;
};
assert.ok(migrateSource.includes("loadCanonicalMigrationSources"),"migrator must load canonical migration sources");
assert.ok(migrateSource.includes("client.query(migration.sql)"),"migrator must execute the canonical text that produced the receipt");
assert.ok(occursBefore("assertExactSchemaMigrationReceipts(repositoryReceipts","await client.connect()"),"repository receipts must be verified before any database connection or mutation");
assert.ok(occursBefore("assertHeldPreMigrationTargetChallenge(client,{withinTransaction:true})","await client.query(MIGRATION_ADVISORY_XACT_LOCK_QUERY)"),"production live-target proof must be rechecked in the app migrator transaction before migration locking or mutation");
assert.ok(occursBefore("assertHeldPreMigrationTargetChallenge(client,{withinTransaction:true})","client.query(migration.sql)"),"each exact app migration transaction must recheck the held live-target proof before DDL");
assert.ok(occursBefore("await client.query(MIGRATION_ADVISORY_XACT_LOCK_QUERY)","assertDatabaseSchemaMigrationReceiptPrefix(client"),"migration history inspection and DDL must share the transaction-scoped advisory lock");
assert.ok(occursBefore("set_config('contracttwin.expected_database_id'","for(const migration of migrations)"),"production migration must expose the externally approved logical database ID before forward identity-mapping DDL");
assert.ok(occursBefore("assertDatabaseSchemaMigrationReceiptPrefix(client","create table public.schema_migrations"),"existing or empty receipt history must be verified before migration-history creation");
assert.ok(occursBefore("assertDatabaseSchemaMigrationReceiptPrefix(client","for(const migration of migrations)"),"database receipt history must be an exact prefix before any migration executes");

const authMigrateSource=await fs.readFile(path.resolve("scripts/auth-migrate.mjs"),"utf8");
const authOccursBefore=(before,after)=>{
  const beforeIndex=authMigrateSource.indexOf(before);
  const afterIndex=authMigrateSource.indexOf(after);
  return beforeIndex>=0&&afterIndex>=0&&beforeIndex<afterIndex;
};
assert.ok(authOccursBefore("assertSchemaMigrationManifestMatchesRepository(process.cwd())","const pool=new TargetBoundMigrationPool"),"repository receipt preflight must precede auth database access");
assert.ok(authOccursBefore("await targetClient.query(MIGRATION_ADVISORY_XACT_LOCK_QUERY)","assertDatabaseSchemaMigrationReceiptPrefix(targetClient"),"auth target preflight and DDL must share the transaction-scoped advisory lock");
assert.ok(authOccursBefore("assertDatabaseSchemaMigrationReceiptPrefix(targetClient","getMigrations(migrationAuth.options)"),"legacy target rejection must precede Better Auth migration planning or mutation");
assert.ok(authOccursBefore("assertDatabaseSchemaMigrationReceiptPrefix(targetClient","targetClient.query(compiledAuthMigrationSql)"),"legacy target rejection must precede Better Auth mutation");
assert.ok(authOccursBefore("assertHeldPreMigrationTargetChallenge(targetClient,{withinTransaction:true})","targetClient.query(compiledAuthMigrationSql)"),"Better Auth DDL transaction must recheck the held live-target proof on its exact connection");
assert.ok(authOccursBefore("targetClient.query(MIGRATION_ADVISORY_XACT_LOCK_QUERY)","targetClient.query(compiledAuthMigrationSql)"),"Better Auth DDL must hold the transaction-scoped schema lock on its exact connection");
assert.match(authMigrateSource,/class TargetBoundMigrationPool extends Pool/,"Better Auth migration must wrap every independently reserved pg client");
assert.match(authMigrateSource,/super\.connect\(\)\.then\(async client=>\{\s*try\{\s*await assertHeldPreMigrationTargetChallenge\(client\)/s,"promise-based Better Auth connections must validate the held target before use");
assert.match(authMigrateSource,/super\.connect\(\(error,client,release\)=>\{[\s\S]*assertHeldPreMigrationTargetChallenge\(client\)[\s\S]*callback\(null,client,release\)/,"callback-based Better Auth connections must validate the held target before use");

const packageManifest=JSON.parse(await fs.readFile(path.resolve("package.json"),"utf8"));
assert.match(packageManifest.scripts["db:migrate"],/^npm run db:migrate:preflight && npm run db:migrate:app && npm run db:migrate:auth$/u,"database migration orchestration must commit the canonical app receipt history before independently retryable auth mutation");
const productionGateSource=await fs.readFile(path.resolve("scripts/production-schema-gate.mjs"),"utf8");
const preMigrationBindingCall='await verifyPreMigrationTargetBinding({';
assert.ok(productionGateSource.indexOf(preMigrationBindingCall)>=0,"production schema gate must run the live cross-credential target proof");
assert.ok(productionGateSource.indexOf(preMigrationBindingCall)<productionGateSource.indexOf('run("db:migrate:preflight"'),"live cross-credential target proof must precede migration preflight");
assert.ok(productionGateSource.indexOf(preMigrationBindingCall)<productionGateSource.indexOf('run("db:migrate"'),"live cross-credential target proof must precede every schema mutation path");
assert.ok(productionGateSource.indexOf("expectedProductionTargetAnchor")<productionGateSource.indexOf(preMigrationBindingCall),"external production target material must be validated before the live target proof");
assert.ok(productionGateSource.indexOf("assertApprovedDatabaseEndpoints")<productionGateSource.indexOf(preMigrationBindingCall),"externally approved endpoint binding must precede every production database connection");
assert.ok(productionGateSource.indexOf('run("db:migrate"')<productionGateSource.indexOf("preMigrationBinding.release()"),"live cross-credential proof must remain held until schema work completes");
assert.ok(productionGateSource.indexOf('run("db:migrate:preflight"')<productionGateSource.indexOf('run("db:migrate"'),"production schema gate must explicitly preflight before migration orchestration");
const releaseBindingSource=await fs.readFile(path.resolve("scripts/release-target-binding.mjs"),"utf8");
const establishStart=releaseBindingSource.indexOf("export async function establishReleaseTargetBinding");
assert.ok(establishStart>=0,"release target binding implementation must exist");
const establishSource=releaseBindingSource.slice(establishStart);
const bindingOccursBefore=(before,after)=>{
  const beforeIndex=establishSource.indexOf(before);
  const afterIndex=establishSource.indexOf(after);
  return beforeIndex>=0&&afterIndex>=0&&beforeIndex<afterIndex;
};
assert.ok(bindingOccursBefore('await migrationClient.query("begin")','await grantReleaseControlReadAccess'),"runtime grants must execute in an explicit migrator transaction");
assert.ok(bindingOccursBefore("withinTransaction:true",'await grantReleaseControlReadAccess'),"runtime grants must follow a held-target proof on the exact mutator transaction");
assert.ok(bindingOccursBefore("MIGRATION_ADVISORY_XACT_LOCK_QUERY",'await grantReleaseControlReadAccess'),"runtime grants and release receipts must share the schema advisory transaction lock");
assert.ok(bindingOccursBefore('await grantReleaseControlReadAccess','await migrationClient.query("commit")'),"runtime grants must commit only through the proved migrator transaction");
assert.ok(bindingOccursBefore('insert into public.release_target_receipts','await migrationClient.query("commit")'),"release receipt insertion must commit only through the proved migrator transaction");
assert.ok(bindingOccursBefore('await runtimeClient.query("begin transaction read only")','const runtimeDatabaseRows='),"runtime release readback must remain in one pinned read-only transaction");
assert.ok(bindingOccursBefore('const runtimeDatabaseRows=','await runtimeClient.query("commit")'),"runtime identity and receipt readback must complete before its proved transaction commits");
const preflightSource=await fs.readFile(path.resolve("scripts/migration-preflight.mjs"),"utf8");
assert.doesNotMatch(preflightSource,/\b(?:create|alter|drop|insert|update|delete|truncate)\b/iu,"migration preflight must not contain schema or data mutation statements");

console.log(`Migration source checks passed: ${manifest.migrations.length} receipts use ${MIGRATION_RECEIPT_ALGORITHM} and CRLF/LF inputs produce identical execution text and hashes.`);
