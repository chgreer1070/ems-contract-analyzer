// pg_catalog remains implicitly first for name resolution when it is omitted;
// public remains the explicit creation target for trusted migrations.
export const SAFE_DATABASE_STARTUP_OPTIONS="-c search_path=public,pg_temp";

export function verifiedDatabaseConnectionConfig(connectionString,applicationName,{requireVerifiedTls=false}={}){
  let parsed;
  try{parsed=new URL(connectionString);}catch{throw new Error("Database connection URL is invalid.");}
  if(!["postgres:","postgresql:"].includes(parsed.protocol))throw new Error("Database connection URL must use PostgreSQL.");
  if(parsed.searchParams.has("options"))throw new Error("Database connection URL may not override the controlled startup search path.");
  if(requireVerifiedTls){
    if(process.env.NODE_TLS_REJECT_UNAUTHORIZED!==undefined||process.env.PGOPTIONS!==undefined||process.env.PGSSLMODE!==undefined){
      throw new Error("Production database connections reject inherited TLS or PostgreSQL option overrides.");
    }
    const sslModes=parsed.searchParams.getAll("sslmode").map(value=>value.toLowerCase());
    if(sslModes.length!==1||sslModes[0]!=="verify-full"){
      throw new Error("Production database connections require sslmode=verify-full.");
    }
  }
  return {connectionString,application_name:applicationName,options:SAFE_DATABASE_STARTUP_OPTIONS,enableChannelBinding:true};
}

export async function assertTrustedMigrationTarget(client){
  const evidence=(await client.query(`
    select
      session_user OPERATOR(pg_catalog.=) current_user identities_match,
      pg_catalog.pg_get_userbyid(d.datdba) OPERATOR(pg_catalog.=) current_user database_owner,
      (n.nspowner OPERATOR(pg_catalog.=) d.datdba or pg_catalog.pg_get_userbyid(n.nspowner) OPERATOR(pg_catalog.=) 'pg_database_owner') trusted_public_owner,
      pg_catalog.has_schema_privilege(current_user,n.oid,'USAGE') public_usage,
      pg_catalog.has_schema_privilege(current_user,n.oid,'CREATE') public_create,
      not exists(
        select 1
          from pg_catalog.aclexplode(coalesce(n.nspacl,pg_catalog.acldefault('n',n.nspowner))) acl
         where acl.privilege_type OPERATOR(pg_catalog.=) 'CREATE'
           and acl.grantee OPERATOR(pg_catalog.<>) d.datdba
           and acl.grantee OPERATOR(pg_catalog.<>) n.nspowner
      ) public_create_exclusive,
      not exists(
        select 1 from pg_catalog.pg_class c join pg_catalog.pg_namespace cn on cn.oid=c.relnamespace
         where cn.nspname OPERATOR(pg_catalog.=) 'public' and c.relowner OPERATOR(pg_catalog.<>) d.datdba
      ) and not exists(
        select 1 from pg_catalog.pg_proc p join pg_catalog.pg_namespace pn on pn.oid=p.pronamespace
         where pn.nspname OPERATOR(pg_catalog.=) 'public' and p.proowner OPERATOR(pg_catalog.<>) d.datdba
      ) public_objects_trusted,
      pg_catalog.current_schema() OPERATOR(pg_catalog.=) 'public' public_is_creation_schema,
      not exists(
        select 1 from pg_catalog.pg_class c join pg_catalog.pg_namespace cn on cn.oid=c.relnamespace
         where cn.nspname OPERATOR(pg_catalog.=) 'pg_catalog' and c.oid OPERATOR(pg_catalog.>=) 16384
      ) and not exists(
        select 1 from pg_catalog.pg_proc p join pg_catalog.pg_namespace pn on pn.oid=p.pronamespace
         where pn.nspname OPERATOR(pg_catalog.=) 'pg_catalog' and p.oid OPERATOR(pg_catalog.>=) 16384
      ) pg_catalog_unpolluted
    from pg_catalog.pg_database d
    join pg_catalog.pg_namespace n on n.nspname OPERATOR(pg_catalog.=) 'public'
   where d.datname OPERATOR(pg_catalog.=) pg_catalog.current_database()
  `)).rows[0];
  const required=["identities_match","database_owner","trusted_public_owner","public_usage","public_create","public_create_exclusive","public_objects_trusted","public_is_creation_schema","pg_catalog_unpolluted"];
  const failed=required.filter(field=>evidence?.[field]!==true);
  if(failed.length)throw new Error(`Migration target failed trusted public-schema controls: ${failed.join(", ")}`);
}
