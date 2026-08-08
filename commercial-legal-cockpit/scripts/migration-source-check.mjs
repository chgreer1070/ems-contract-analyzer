import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import {canonicalizeMigrationSource,MIGRATION_RECEIPT_ALGORITHM} from "./migration-source.mjs";
import {
  assertDatabaseSchemaMigrationReceiptPrefix,
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
assert.ok(occursBefore("await client.query(MIGRATION_ADVISORY_LOCK_QUERY)","assertDatabaseSchemaMigrationReceiptPrefix(client"),"migration history inspection must be serialized by the advisory lock");
assert.ok(occursBefore("assertDatabaseSchemaMigrationReceiptPrefix(client","create table public.schema_migrations"),"existing or empty receipt history must be verified before migration-history creation");
assert.ok(occursBefore("assertDatabaseSchemaMigrationReceiptPrefix(client","for(const migration of migrations)"),"database receipt history must be an exact prefix before any migration executes");

const authMigrateSource=await fs.readFile(path.resolve("scripts/auth-migrate.mjs"),"utf8");
const authOccursBefore=(before,after)=>{
  const beforeIndex=authMigrateSource.indexOf(before);
  const afterIndex=authMigrateSource.indexOf(after);
  return beforeIndex>=0&&afterIndex>=0&&beforeIndex<afterIndex;
};
assert.ok(authOccursBefore("assertSchemaMigrationManifestMatchesRepository(process.cwd())","new Pool"),"repository receipt preflight must precede auth database access");
assert.ok(authOccursBefore("await targetClient.query(MIGRATION_ADVISORY_LOCK_QUERY)","assertDatabaseSchemaMigrationReceiptPrefix(targetClient"),"auth target preflight must hold the migration advisory lock");
assert.ok(authOccursBefore("assertDatabaseSchemaMigrationReceiptPrefix(targetClient","getMigrations(migrationAuth.options)"),"legacy target rejection must precede Better Auth migration planning or mutation");
assert.ok(authOccursBefore("assertDatabaseSchemaMigrationReceiptPrefix(targetClient","await runMigrations()"),"legacy target rejection must precede Better Auth mutation");

const packageManifest=JSON.parse(await fs.readFile(path.resolve("package.json"),"utf8"));
assert.match(packageManifest.scripts["db:migrate"],/^npm run db:migrate:preflight && npm run db:migrate:auth && npm run db:migrate:app$/u,"database migration orchestration must preflight before auth mutation");
const productionGateSource=await fs.readFile(path.resolve("scripts/production-schema-gate.mjs"),"utf8");
assert.ok(productionGateSource.indexOf('run("db:migrate:preflight"')<productionGateSource.indexOf('run("db:migrate"'),"production schema gate must explicitly preflight before migration orchestration");
const preflightSource=await fs.readFile(path.resolve("scripts/migration-preflight.mjs"),"utf8");
assert.doesNotMatch(preflightSource,/\b(?:create|alter|drop|insert|update|delete|truncate)\b/iu,"migration preflight must not contain schema or data mutation statements");

console.log(`Migration source checks passed: ${manifest.migrations.length} receipts use ${MIGRATION_RECEIPT_ALGORITHM} and CRLF/LF inputs produce identical execution text and hashes.`);
