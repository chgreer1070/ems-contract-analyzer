import pg from "pg";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import {verifiedDatabaseConnectionConfig} from "./database-connection-config.mjs";

const {Client}=pg;

export const RUNTIME_DATABASE_PRINCIPAL_QUERY=`
with identities as materialized (
  select r.oid,r.rolname,r.rolsuper,r.rolcreaterole,r.rolcreatedb,r.rolreplication,r.rolbypassrls
    from pg_catalog.pg_roles r where r.rolname in (session_user,current_user)
),
dangerous_roles(role_name) as (
  values ('pg_database_owner'),('pg_read_all_data'),('pg_write_all_data'),
         ('pg_read_server_files'),('pg_write_server_files'),('pg_execute_server_program'),
         ('pg_signal_backend'),('pg_checkpoint'),('pg_maintain'),('pg_create_subscription')
),
owner_roles(owner_oid) as (
  select d.datdba from pg_catalog.pg_database d where d.datname=pg_catalog.current_database()
  union select n.nspowner from pg_catalog.pg_namespace n
  union select c.relowner from pg_catalog.pg_class c
  union select p.proowner from pg_catalog.pg_proc p
),
application_functions as (
  select p.oid,n.nspname,p.proname,pg_catalog.pg_get_function_identity_arguments(p.oid) identity_arguments,
         p.prosecdef,
         (select e.extname from pg_catalog.pg_depend d join pg_catalog.pg_extension e on e.oid=d.refobjid
           where d.classid='pg_catalog.pg_proc'::pg_catalog.regclass and d.objid=p.oid and d.deptype='e') extension_name
    from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid=p.pronamespace
   where p.oid>=16384
),
approved_runtime_functions(nspname,proname,identity_arguments,extension_name) as (
  values ('public','canonical_jsonb_text','input_value jsonb',null::text),
         ('public','lock_documents_for_legal_publication','source_documents uuid[]',null::text),
         ('public','executive_snapshot_receipt_verified','snapshot_id uuid',null::text),
         ('public','digest','bytea, text','pgcrypto')
),
public_tables as (
  select c.oid,c.relname from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid=c.relnamespace
   where n.nspname='public' and c.relkind in ('r','p')
),
public_sequences as (
  select c.oid,c.relname from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid=c.relnamespace
   where n.nspname='public' and c.relkind='S'
),
protected_release_tables(relname) as (
  values ('release_database_identity'),('release_target_receipts')
)
select session_user::text session_user_name,current_user::text current_user_name,
       session_user=current_user identities_match,
       not exists(select 1 from identities i where i.rolsuper or i.rolcreaterole or i.rolcreatedb or i.rolreplication or i.rolbypassrls) role_attributes_safe,
       not exists(select 1 from identities i join pg_catalog.pg_roles r on r.oid<>i.oid and pg_catalog.pg_has_role(i.oid,r.oid,'MEMBER')) role_membership_safe,
       not exists(select 1 from identities i cross join owner_roles o where pg_catalog.pg_has_role(i.oid,o.owner_oid,'MEMBER')) owner_membership_safe,
       not exists(select 1 from identities i join dangerous_roles d on true join pg_catalog.pg_roles r on r.rolname=d.role_name where pg_catalog.pg_has_role(i.oid,r.oid,'MEMBER')) dangerous_membership_safe,
       not exists(select 1 from identities i where pg_catalog.has_database_privilege(i.rolname,pg_catalog.current_database(),'CREATE')) database_create_safe,
       not exists(select 1 from identities i where pg_catalog.has_database_privilege(i.rolname,pg_catalog.current_database(),'TEMP')) database_temp_safe,
       not exists(select 1 from identities i cross join pg_catalog.pg_namespace n where pg_catalog.has_schema_privilege(i.rolname,n.oid,'CREATE')) schema_create_safe,
       not exists(
         select 1 from identities i cross join application_functions f
          where pg_catalog.has_function_privilege(i.rolname,f.oid,'EXECUTE') and (
            f.prosecdef or not exists(
              select 1 from approved_runtime_functions a
               where a.nspname=f.nspname and a.proname=f.proname and a.identity_arguments=f.identity_arguments
                 and a.extension_name is not distinct from f.extension_name
            )
          )
       ) application_function_execute_safe,
       not exists(
         select 1 from identities i cross join approved_runtime_functions a
          where not exists(
            select 1 from application_functions f
             where f.nspname=a.nspname and f.proname=a.proname and f.identity_arguments=a.identity_arguments
               and f.extension_name is not distinct from a.extension_name
               and not f.prosecdef and pg_catalog.has_function_privilege(i.rolname,f.oid,'EXECUTE')
          )
       ) approved_runtime_functions_ready,
       not exists(
         select 1 from identities i cross join public_tables t
           where t.relname not in ('schema_migrations','release_database_identity','release_target_receipts') and (
            not pg_catalog.has_table_privilege(i.rolname,t.oid,'SELECT') or
            not pg_catalog.has_table_privilege(i.rolname,t.oid,'INSERT') or
            not pg_catalog.has_table_privilege(i.rolname,t.oid,'UPDATE') or
            not pg_catalog.has_table_privilege(i.rolname,t.oid,'DELETE')
          )
       ) application_table_dml_ready,
       not exists(
         select 1 from identities i cross join public_sequences s where
           not pg_catalog.has_sequence_privilege(i.rolname,s.oid,'USAGE') or
           not pg_catalog.has_sequence_privilege(i.rolname,s.oid,'SELECT') or
           pg_catalog.has_sequence_privilege(i.rolname,s.oid,'UPDATE')
       ) application_sequence_privileges_safe,
       not exists(select 1 from identities i cross join public_tables t where pg_catalog.has_table_privilege(i.rolname,t.oid,'TRIGGER')) table_trigger_safe,
       not exists(select 1 from identities i cross join public_tables t where pg_catalog.has_table_privilege(i.rolname,t.oid,'TRUNCATE')) table_truncate_safe,
       not exists(select 1 from identities i cross join public_tables t where
         pg_catalog.has_table_privilege(i.rolname,t.oid,'REFERENCES') or
         pg_catalog.has_any_column_privilege(i.rolname,t.oid,'REFERENCES')
       ) table_references_safe,
       not exists(select 1 from identities i cross join public_tables t where pg_catalog.has_table_privilege(i.rolname,t.oid,'MAINTAIN')) table_maintain_safe,
       pg_catalog.current_setting('session_replication_role')='origin' replication_mode_safe,
       not exists(select 1 from identities i where pg_catalog.has_parameter_privilege(i.rolname,'session_replication_role','SET')) replication_parameter_safe,
       exists(select 1 from public_tables t where t.relname='schema_migrations') and not exists(
         select 1 from identities i cross join public_tables t
          where t.relname='schema_migrations' and (
            not pg_catalog.has_table_privilege(i.rolname,t.oid,'SELECT') or
            pg_catalog.has_table_privilege(i.rolname,t.oid,'INSERT') or pg_catalog.has_table_privilege(i.rolname,t.oid,'UPDATE') or
            pg_catalog.has_table_privilege(i.rolname,t.oid,'DELETE') or pg_catalog.has_table_privilege(i.rolname,t.oid,'TRUNCATE') or
            pg_catalog.has_table_privilege(i.rolname,t.oid,'TRIGGER') or pg_catalog.has_table_privilege(i.rolname,t.oid,'REFERENCES') or
            pg_catalog.has_table_privilege(i.rolname,t.oid,'MAINTAIN') or
            pg_catalog.has_any_column_privilege(i.rolname,t.oid,'INSERT') or
            pg_catalog.has_any_column_privilege(i.rolname,t.oid,'UPDATE') or
            pg_catalog.has_any_column_privilege(i.rolname,t.oid,'REFERENCES')
          )
        ) migration_receipts_read_only,
        not exists(
          select 1 from protected_release_tables p where not exists(
            select 1 from public_tables t where t.relname=p.relname
          )
        ) and not exists(
          select 1 from identities i cross join public_tables t
           where t.relname in ('release_database_identity','release_target_receipts') and (
             not pg_catalog.has_table_privilege(i.rolname,t.oid,'SELECT') or
             pg_catalog.has_table_privilege(i.rolname,t.oid,'INSERT') or pg_catalog.has_table_privilege(i.rolname,t.oid,'UPDATE') or
             pg_catalog.has_table_privilege(i.rolname,t.oid,'DELETE') or pg_catalog.has_table_privilege(i.rolname,t.oid,'TRUNCATE') or
             pg_catalog.has_table_privilege(i.rolname,t.oid,'TRIGGER') or pg_catalog.has_table_privilege(i.rolname,t.oid,'REFERENCES') or
             pg_catalog.has_table_privilege(i.rolname,t.oid,'MAINTAIN') or
             pg_catalog.has_any_column_privilege(i.rolname,t.oid,'INSERT') or
             pg_catalog.has_any_column_privilege(i.rolname,t.oid,'UPDATE') or
             pg_catalog.has_any_column_privilege(i.rolname,t.oid,'REFERENCES')
           )
        ) release_control_tables_read_only
`;

export const REQUIRED_RUNTIME_DATABASE_PRINCIPAL_FIELDS=[
  "identities_match","role_attributes_safe","role_membership_safe","owner_membership_safe","dangerous_membership_safe",
  "database_create_safe","database_temp_safe","schema_create_safe","application_function_execute_safe",
  "approved_runtime_functions_ready","application_table_dml_ready","application_sequence_privileges_safe",
  "table_trigger_safe","table_truncate_safe","table_references_safe","table_maintain_safe",
  "replication_mode_safe","replication_parameter_safe","migration_receipts_read_only","release_control_tables_read_only"
];

export function evaluateRuntimeDatabasePrincipal(row){
  const errors=[];
  if(!row)errors.push("runtime database principal evidence is missing");
  else for(const field of REQUIRED_RUNTIME_DATABASE_PRINCIPAL_FIELDS){if(row[field]!==true)errors.push(`runtime database principal failed ${field}`);}
  return {ok:errors.length===0,errors,checkedCount:REQUIRED_RUNTIME_DATABASE_PRINCIPAL_FIELDS.length};
}

export async function inspectRuntimeDatabasePrincipal(connectionString){
  const client=new Client(verifiedDatabaseConnectionConfig(connectionString,"contracttwin-runtime-principal-verifier",{requireVerifiedTls:process.env.APP_ENV==="production"||process.env.VERCEL_ENV==="production"}));
  try{await client.connect();const result=await client.query(RUNTIME_DATABASE_PRINCIPAL_QUERY);return evaluateRuntimeDatabasePrincipal(result.rows[0]);}
  finally{await client.end();}
}

async function main(){
  if(!process.env.DATABASE_URL)throw new Error("DATABASE_URL is required for runtime database-principal verification.");
  const result=await inspectRuntimeDatabasePrincipal(process.env.DATABASE_URL);
  if(!result.ok)throw new Error(`Runtime database principal is unsafe: ${result.errors.join("; ")}`);
  console.log(`Runtime database-principal verification passed ${result.checkedCount} least-privilege controls.`);
}

if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
  main().catch(error=>{console.error(error instanceof Error?error.message:"Runtime database-principal verification failed.");process.exitCode=1;});
}
