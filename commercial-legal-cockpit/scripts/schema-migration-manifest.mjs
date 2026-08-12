import fs from "node:fs/promises";
import {MIGRATION_RECEIPT_ALGORITHM,loadCanonicalMigrationSources} from "./migration-source.mjs";

const manifestUrl=new URL("../lib/schema-migration-manifest.json",import.meta.url);
const MANIFEST_VERSION=2;
export const MIGRATION_ADVISORY_XACT_LOCK_QUERY="select pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('contracttwin-schema-migrations'))";

function evaluateManifestStructure(manifest){
  const errors=[];
  if(!manifest||typeof manifest!=="object")return ["migration manifest is not an object"];
  if(manifest.version!==MANIFEST_VERSION)errors.push(`migration manifest version must be ${MANIFEST_VERSION}`);
  if(manifest.receiptAlgorithm!==MIGRATION_RECEIPT_ALGORITHM)errors.push("migration manifest receipt algorithm is not canonical LF v1");
  if(!Array.isArray(manifest.migrations))return [...errors,"migration manifest does not contain a receipt array"];
  if(manifest.migrations.length===0)errors.push("migration manifest must not be empty");
  let previous="";
  for(const [index,row] of manifest.migrations.entries()){
    const filenameMatch=typeof row?.filename==="string"?row.filename.match(/^(\d{3})_[a-z0-9_]+\.sql$/u):null;
    if(!row||typeof row!=="object"||!filenameMatch)errors.push(`migration manifest filename is invalid at position ${index+1}`);
    else if(Number(filenameMatch[1])!==index+1)errors.push(`migration manifest sequence is not contiguous at position ${index+1}`);
    if(!/^[0-9a-f]{64}$/u.test(row?.sha256||""))errors.push(`migration manifest SHA-256 is invalid at position ${index+1}`);
    if(row?.filename&&row.filename<=previous)errors.push(`migration manifest is not strictly ordered at position ${index+1}`);
    previous=row?.filename||previous;
  }
  return errors;
}

export async function loadSchemaMigrationManifest(){
  const manifest=JSON.parse(await fs.readFile(manifestUrl,"utf8"));
  const errors=evaluateManifestStructure(manifest);
  if(errors.length)throw new Error(`Schema migration manifest is invalid: ${errors.join("; ")}`);
  return manifest;
}

export async function calculateRepositoryMigrationReceipts(root=process.cwd()){
  return (await loadCanonicalMigrationSources(root)).map(({filename,sha256})=>({filename,sha256}));
}

export function evaluateExactSchemaMigrationReceipts(rows,manifest){
  const expected=Array.isArray(manifest?.migrations)?manifest.migrations:[];
  const errors=evaluateManifestStructure(manifest);
  if(rows.length!==expected.length)errors.push(`migration receipt count ${rows.length} does not match ${expected.length}`);
  const length=Math.max(rows.length,expected.length);
  for(let index=0;index<length;index++){
    const actual=rows[index];
    const required=expected[index];
    if(!actual||!required||actual.filename!==required.filename||actual.sha256!==required.sha256){
      errors.push(`migration receipt mismatch at position ${index+1}`);
    }
  }
  return {ok:errors.length===0,errors,checkedCount:expected.length,manifestVersion:manifest?.version};
}

export function evaluateSchemaMigrationReceiptPrefix(rows,manifest){
  const expected=Array.isArray(manifest?.migrations)?manifest.migrations:[];
  const errors=evaluateManifestStructure(manifest);
  if(rows.length>expected.length)errors.push(`migration receipt count ${rows.length} exceeds ${expected.length}`);
  for(let index=0;index<rows.length;index++){
    const actual=rows[index];
    const required=expected[index];
    if(!actual||!required||actual.filename!==required.filename||actual.sha256!==required.sha256){
      errors.push(`migration receipt mismatch at position ${index+1}`);
    }
  }
  return {ok:errors.length===0,errors,checkedCount:rows.length,manifestVersion:manifest?.version};
}

export function assertExactSchemaMigrationReceipts(rows,manifest,label="Target"){
  const result=evaluateExactSchemaMigrationReceipts(rows,manifest);
  if(!result.ok)throw new Error(`${label} migration receipts are not exact: ${result.errors.join("; ")}`);
  return result;
}

export function assertSchemaMigrationReceiptPrefix(rows,manifest,label="Target"){
  const result=evaluateSchemaMigrationReceiptPrefix(rows,manifest);
  if(!result.ok)throw new Error(`${label} migration receipts are not an exact manifest prefix: ${result.errors.join("; ")}`);
  return result;
}

export async function assertDatabaseSchemaMigrationReceiptPrefix(client,manifest,label="Target"){
  const historyRelation=await client.query("select pg_catalog.to_regclass('public.schema_migrations')::text as relation_name");
  const historyExists=Boolean(historyRelation.rows[0]?.relation_name);
  const rows=historyExists
    ?(await client.query("select filename,sha256 from public.schema_migrations order by filename")).rows
    :[];
  assertSchemaMigrationReceiptPrefix(rows,manifest,label);
  return {historyExists,rows};
}

export async function assertPristineProductionBootstrapTarget(client,label="Target",{requireExternalAnchor=false}={}){
  const evidence=(await client.query(`
    select
      (select count(*)::int
         from pg_catalog.pg_namespace n
        where n.nspname OPERATOR(pg_catalog.!~) '^pg_'
          and n.nspname OPERATOR(pg_catalog.<>) 'information_schema'
          and n.nspname OPERATOR(pg_catalog.<>) 'public'
          and n.nspname OPERATOR(pg_catalog.<>) 'contracttwin_control') extra_schema_count,
      (select count(*)::int
         from pg_catalog.pg_class c
         join pg_catalog.pg_namespace n on n.oid OPERATOR(pg_catalog.=) c.relnamespace
        where n.nspname OPERATOR(pg_catalog.!~) '^pg_'
          and n.nspname OPERATOR(pg_catalog.<>) 'information_schema'
          and not (
            n.nspname OPERATOR(pg_catalog.=) 'contracttwin_control'
            and (
              (c.relname OPERATOR(pg_catalog.=) 'production_target_binding' and c.relkind OPERATOR(pg_catalog.=) 'r')
              or (
                c.relkind OPERATOR(pg_catalog.=) 'i'
                and exists(
                  select 1
                    from pg_catalog.pg_index i
                    join pg_catalog.pg_class anchored on anchored.oid OPERATOR(pg_catalog.=) i.indrelid
                   where i.indexrelid OPERATOR(pg_catalog.=) c.oid
                     and anchored.relnamespace OPERATOR(pg_catalog.=) n.oid
                     and anchored.relname OPERATOR(pg_catalog.=) 'production_target_binding'
                )
              )
            )
          )) user_relation_count,
      (select count(*)::int
         from pg_catalog.pg_proc p
         join pg_catalog.pg_namespace n on n.oid OPERATOR(pg_catalog.=) p.pronamespace
        where n.nspname OPERATOR(pg_catalog.!~) '^pg_'
          and n.nspname OPERATOR(pg_catalog.<>) 'information_schema') user_routine_count,
      (select count(*)::int
         from pg_catalog.pg_type t
         join pg_catalog.pg_namespace n on n.oid OPERATOR(pg_catalog.=) t.typnamespace
        where n.nspname OPERATOR(pg_catalog.!~) '^pg_'
          and n.nspname OPERATOR(pg_catalog.<>) 'information_schema'
          and t.typtype OPERATOR(pg_catalog.=) any(array['c','d','e','m','r']::"char"[])
          and not (
            n.nspname OPERATOR(pg_catalog.=) 'contracttwin_control'
            and t.typname OPERATOR(pg_catalog.=) 'production_target_binding'
            and t.typtype OPERATOR(pg_catalog.=) 'c'
          )) user_type_count,
      (select count(*)::int
         from pg_catalog.pg_extension e
        where e.extname OPERATOR(pg_catalog.<>) 'plpgsql') non_default_extension_count,
      (select count(*)::int
         from pg_catalog.pg_class c
         join pg_catalog.pg_namespace n on n.oid OPERATOR(pg_catalog.=) c.relnamespace
        where n.nspname OPERATOR(pg_catalog.=) 'contracttwin_control'
          and c.relname OPERATOR(pg_catalog.=) 'production_target_binding'
          and c.relkind OPERATOR(pg_catalog.=) 'r') anchor_relation_count
  `)).rows[0];
  const fields=[
    "extra_schema_count",
    "user_relation_count",
    "user_routine_count",
    "user_type_count",
    "non_default_extension_count"
  ];
  const occupied=fields.filter(field=>evidence?.[field]!==0);
  if(occupied.length){
    throw new Error(`${label} is not a pristine dedicated database: ${occupied.join(", ")}`);
  }
  if(requireExternalAnchor&&evidence?.anchor_relation_count!==1){
    throw new Error(`${label} does not contain the separately approved production target anchor.`);
  }
  return evidence;
}

export async function assertSchemaMigrationManifestMatchesRepository(root=process.cwd()){
  const manifest=await loadSchemaMigrationManifest();
  const calculated=await calculateRepositoryMigrationReceipts(root);
  assertExactSchemaMigrationReceipts(calculated,manifest,"Repository");
  return manifest;
}
