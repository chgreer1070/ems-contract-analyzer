import { createHash } from "node:crypto";
import fs from "node:fs/promises";

export const CRITICAL_DATABASE_CONTROLS_QUERY = `
with configured as materialized (
  select set_config('search_path','pg_catalog',true) applied
)
select 'trigger'::text kind,c.relname::text table_name,t.tgname::text object_name,
       p.proname::text function_name,t.tgenabled::text enabled,t.tgisinternal is_internal,
       null::text identity_arguments,null::text result_type,null::text volatility,
       null::text constraint_type,null::boolean validated,null::boolean is_unique,
       null::boolean is_valid,null::boolean is_ready,null::text data_type,
       null::boolean is_nullable,pg_get_triggerdef(t.oid,false)::text definition,
       pg_get_functiondef(p.oid)::text function_definition,null::text server_version_num
  from pg_trigger t
  join pg_class c on c.oid=t.tgrelid
  join pg_namespace n on n.oid=c.relnamespace
  join pg_proc p on p.oid=t.tgfoid
 cross join configured
 where n.nspname='public'
union all
select 'function'::text,null::text,p.proname::text,null::text,null::text,null::boolean,
       pg_get_function_identity_arguments(p.oid)::text,pg_get_function_result(p.oid)::text,
       p.provolatile::text,null::text,null::boolean,null::boolean,null::boolean,null::boolean,
       null::text,null::boolean,pg_get_functiondef(p.oid)::text,null::text,null::text
  from pg_proc p
  join pg_namespace n on n.oid=p.pronamespace
 cross join configured
 where n.nspname='public' and p.prokind='f'
union all
select 'constraint'::text,c.relname::text,co.conname::text,null::text,null::text,null::boolean,
       null::text,null::text,null::text,co.contype::text,co.convalidated,
       null::boolean,null::boolean,null::boolean,null::text,null::boolean,
       pg_get_constraintdef(co.oid,false)::text,null::text,null::text
  from pg_constraint co
  join pg_class c on c.oid=co.conrelid
  join pg_namespace n on n.oid=c.relnamespace
 cross join configured
 where n.nspname='public'
union all
select 'index'::text,t.relname::text,i.relname::text,null::text,null::text,null::boolean,
       null::text,null::text,null::text,null::text,null::boolean,ix.indisunique,
       ix.indisvalid,ix.indisready,null::text,null::boolean,
       pg_get_indexdef(ix.indexrelid,0,false)::text,null::text,null::text
  from pg_index ix
  join pg_class i on i.oid=ix.indexrelid
  join pg_class t on t.oid=ix.indrelid
  join pg_namespace n on n.oid=t.relnamespace
 cross join configured
 where n.nspname='public'
union all
select 'column'::text,c.relname::text,a.attname::text,null::text,null::text,null::boolean,
       null::text,null::text,null::text,null::text,null::boolean,null::boolean,
       null::boolean,null::boolean,format_type(a.atttypid,a.atttypmod)::text,
       (not a.attnotnull),null::text,null::text,null::text
  from pg_attribute a
  join pg_class c on c.oid=a.attrelid
  join pg_namespace n on n.oid=c.relnamespace
 cross join configured
 where n.nspname='public' and c.relkind in ('r','p') and a.attnum>0 and not a.attisdropped
union all
select 'rule'::text,c.relname::text,r.rulename::text,null::text,null::text,null::boolean,
       null::text,null::text,null::text,null::text,null::boolean,null::boolean,
       null::boolean,null::boolean,null::text,null::boolean,
       pg_get_ruledef(r.oid,false)::text,null::text,null::text
  from pg_rewrite r
  join pg_class c on c.oid=r.ev_class
  join pg_namespace n on n.oid=c.relnamespace
 cross join configured
 where n.nspname='public' and not (r.rulename='_RETURN' and c.relkind in ('v','m'))
union all
select 'server'::text,null::text,'postgresql'::text,null::text,null::text,null::boolean,
       null::text,null::text,null::text,null::text,null::boolean,null::boolean,
       null::boolean,null::boolean,null::text,null::boolean,null::text,null::text,
       current_setting('server_version_num')::text
  from configured
`;

export async function loadCriticalDatabaseControlManifest() {
  return JSON.parse(await fs.readFile(new URL("../lib/critical-database-controls.json", import.meta.url), "utf8"));
}

function tableObjectKey(table, name) {
  return `${table ?? ""}\u0000${name}`;
}

function objectMaps(rows) {
  return {
    columnRows:new Map(rows.filter(row=>row.kind==="column").map(row=>[tableObjectKey(row.table_name,row.object_name),row])),
    triggerRows:new Map(rows.filter(row=>row.kind==="trigger").map(row=>[tableObjectKey(row.table_name,row.object_name),row])),
    functionRows:rows.filter(row=>row.kind==="function"),
    constraintRows:new Map(rows.filter(row=>row.kind==="constraint").map(row=>[tableObjectKey(row.table_name,row.object_name),row])),
    indexRows:new Map(rows.filter(row=>row.kind==="index").map(row=>[tableObjectKey(row.table_name,row.object_name),row]))
  };
}

export function calculateCriticalDatabaseControlFingerprint(rows,manifest) {
  const {columnRows,triggerRows,functionRows,constraintRows,indexRows}=objectMaps(rows);
  const serverVersionNumber=Number(rows.find(row=>row.kind==="server")?.server_version_num??0);
  const serverMajor=Math.floor(serverVersionNumber/10000);
  const material={
    postgresMajor:serverMajor,
    rules:manifest.rules,
    columns:manifest.columns.map(expected=>{
      const actual=columnRows.get(tableObjectKey(expected.table,expected.name));
      return {table:expected.table,name:expected.name,type:actual?.data_type??null,nullable:actual?.is_nullable??null};
    }),
    triggers:manifest.triggers.map(expected=>{
      const actual=triggerRows.get(tableObjectKey(expected.table,expected.name));
      return {table:expected.table,name:expected.name,function:actual?.function_name??null,enabled:actual?.enabled??null,internal:actual?.is_internal??null,definition:actual?.definition??null,functionDefinition:actual?.function_definition??null};
    }),
    functions:manifest.functions.map(expected=>{
      const actual=functionRows.find(row=>row.object_name===expected.name&&row.identity_arguments===expected.identityArguments);
      return {name:expected.name,identityArguments:expected.identityArguments,result:actual?.result_type??null,volatility:actual?.volatility??null,definition:actual?.definition??null};
    }),
    constraints:manifest.constraints.map(expected=>{
      const actual=constraintRows.get(tableObjectKey(expected.table,expected.name));
      return {table:expected.table,name:expected.name,type:actual?.constraint_type??null,validated:actual?.validated??null,definition:actual?.definition??null};
    }),
    indexes:manifest.indexes.map(expected=>{
      const actual=indexRows.get(tableObjectKey(expected.table,expected.name));
      return {table:expected.table,name:expected.name,unique:actual?.is_unique??null,valid:actual?.is_valid??null,ready:actual?.is_ready??null,definition:actual?.definition??null};
    })
  };
  return createHash("sha256").update(JSON.stringify(material),"utf8").digest("hex");
}

export function evaluateCriticalDatabaseControls(rows,manifest) {
  const errors=[];
  const {columnRows,triggerRows,functionRows,constraintRows,indexRows}=objectMaps(rows);
  const serverVersionNumber=Number(rows.find(row=>row.kind==="server")?.server_version_num??0);
  const serverMajor=Math.floor(serverVersionNumber/10000);
  if(serverMajor!==manifest.postgresMajor)errors.push(`PostgreSQL major ${serverMajor||"unknown"} does not match required major ${manifest.postgresMajor}`);
  const expectedTriggerKeys=new Set(manifest.triggers.map(trigger=>tableObjectKey(trigger.table,trigger.name)));
  for(const actual of rows.filter(row=>row.kind==="trigger"&&row.is_internal===false&&row.table_name!==null)){
    if(!expectedTriggerKeys.has(tableObjectKey(actual.table_name,actual.object_name)))errors.push(`unexpected trigger public.${actual.table_name}.${actual.object_name}`);
  }
  for(const actual of rows.filter(row=>row.kind==="rule"))errors.push(`unexpected rewrite rule public.${actual.table_name}.${actual.object_name}`);

  for(const expected of manifest.columns){
    const actual=columnRows.get(tableObjectKey(expected.table,expected.name));
    if(!actual)errors.push(`missing column public.${expected.table}.${expected.name}`);
    else if(actual.data_type!==expected.type||actual.is_nullable!==expected.nullable)errors.push(`invalid column public.${expected.table}.${expected.name}`);
  }
  for(const expected of manifest.triggers){
    const actual=triggerRows.get(tableObjectKey(expected.table,expected.name));
    if(!actual)errors.push(`missing trigger public.${expected.table}.${expected.name}`);
    else if(actual.is_internal!==false||actual.enabled!=="O"||actual.function_name!==expected.function)errors.push(`invalid trigger public.${expected.table}.${expected.name}`);
  }
  for(const expected of manifest.functions){
    const actual=functionRows.find(row=>row.object_name===expected.name&&row.identity_arguments===expected.identityArguments);
    if(!actual)errors.push(`missing function public.${expected.name}(${expected.identityArguments})`);
    else if(actual.result_type!==expected.result||actual.volatility!==expected.volatility)errors.push(`invalid function public.${expected.name}(${expected.identityArguments})`);
  }
  for(const expected of manifest.constraints){
    const actual=constraintRows.get(tableObjectKey(expected.table,expected.name));
    if(!actual)errors.push(`missing constraint public.${expected.table}.${expected.name}`);
    else if(actual.constraint_type!==expected.type||actual.validated!==expected.validated)errors.push(`invalid constraint public.${expected.table}.${expected.name}`);
  }
  for(const expected of manifest.indexes){
    const actual=indexRows.get(tableObjectKey(expected.table,expected.name));
    if(!actual)errors.push(`missing index public.${expected.table}.${expected.name}`);
    else if(actual.is_unique!==expected.unique||actual.is_valid!==true||actual.is_ready!==true)errors.push(`invalid index public.${expected.table}.${expected.name}`);
  }

  const actualDefinitionSha256=calculateCriticalDatabaseControlFingerprint(rows,manifest);
  if(!/^[0-9a-f]{64}$/.test(manifest.schemaDefinitionSha256))errors.push("critical database manifest lacks a generated PostgreSQL definition fingerprint");
  else if(actualDefinitionSha256!==manifest.schemaDefinitionSha256)errors.push("critical database object definition fingerprint mismatch");
  return {ok:errors.length===0,errors,checkedCount:manifest.columns.length+manifest.rules.length+manifest.triggers.length+manifest.functions.length+manifest.constraints.length+manifest.indexes.length,manifestVersion:manifest.version,postgresMajor:serverMajor,actualDefinitionSha256};
}

export async function inspectCriticalDatabaseControls(client,manifest){
  const effectiveManifest=manifest??await loadCriticalDatabaseControlManifest();
  const result=await client.query(CRITICAL_DATABASE_CONTROLS_QUERY);
  return evaluateCriticalDatabaseControls(result.rows,effectiveManifest);
}

export function assertCriticalDatabaseControls(result){
  if(!result.ok)throw new Error(`Critical database-control drift detected: ${result.errors.join("; ")}`);
  return result;
}
