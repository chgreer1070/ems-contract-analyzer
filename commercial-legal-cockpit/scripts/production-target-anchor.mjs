import {createHash} from "node:crypto";

export const PRODUCTION_TARGET_TOKEN_PATTERN=/^[0-9a-f]{64}$/u;
export const PRODUCTION_DATABASE_ID_PATTERN=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
export const PRODUCTION_DATABASE_ENDPOINT_SHA256_PATTERN=/^[0-9a-f]{64}$/u;

const TARGET_ANCHOR_RELATION="contracttwin_control.production_target_binding";
const FORBIDDEN_ENDPOINT_QUERY_OVERRIDES=["host","port","database","db","user","password","options"];

function sha256(value){
  return createHash("sha256").update(value,"utf8").digest("hex");
}

export function hashProductionTargetToken(token){
  if(!PRODUCTION_TARGET_TOKEN_PATTERN.test(token||"")){
    throw new Error("Expected production target token must be 64 lowercase hexadecimal characters.");
  }
  return sha256(token);
}

export function normalizedDatabaseEndpoint(connectionString){
  let parsed;
  try{parsed=new URL(connectionString);}catch{throw new Error("Production database endpoint URL is invalid.");}
  if(!["postgres:","postgresql:"].includes(parsed.protocol)){
    throw new Error("Production database endpoint must use PostgreSQL.");
  }
  const forbiddenOverride=FORBIDDEN_ENDPOINT_QUERY_OVERRIDES.find(name=>parsed.searchParams.has(name));
  if(forbiddenOverride){
    throw new Error(`Production database endpoint may not override ${forbiddenOverride} through query parameters.`);
  }
  const hostname=parsed.hostname.toLowerCase().replace(/\.$/u,"");
  const port=parsed.port||"5432";
  let databaseName;
  try{databaseName=decodeURI(parsed.pathname.replace(/^\//u,""));}
  catch{throw new Error("Production database name is not valid URL encoding.");}
  if(!hostname||!databaseName||!/^[0-9]+$/u.test(port)||Number(port)<1||Number(port)>65535){
    throw new Error("Production database endpoint host, port, or database name is invalid.");
  }
  return {hostname,port:String(Number(port)),databaseName};
}

export function databaseEndpointSha256(connectionString){
  const endpoint=normalizedDatabaseEndpoint(connectionString);
  return sha256(JSON.stringify([endpoint.hostname,endpoint.port,endpoint.databaseName]));
}

export function assertApprovedDatabaseEndpoints(connectionStrings,expectedEndpointSha256){
  if(!PRODUCTION_DATABASE_ENDPOINT_SHA256_PATTERN.test(expectedEndpointSha256||"")){
    throw new Error("Expected production database endpoint SHA-256 is missing or malformed.");
  }
  for(const connectionString of connectionStrings){
    if(databaseEndpointSha256(connectionString)!==expectedEndpointSha256){
      throw new Error("A production database credential does not match the externally approved endpoint descriptor.");
    }
  }
}

export function expectedProductionTargetAnchor({token,databaseId,runtimeEndpointSha256,migrationEndpointSha256}){
  if(!PRODUCTION_DATABASE_ID_PATTERN.test(databaseId||"")){
    throw new Error("Expected production database ID is missing or malformed.");
  }
  if(
    !PRODUCTION_DATABASE_ENDPOINT_SHA256_PATTERN.test(runtimeEndpointSha256||"")||
    !PRODUCTION_DATABASE_ENDPOINT_SHA256_PATTERN.test(migrationEndpointSha256||"")
  ){
    throw new Error("Expected production runtime or migration database endpoint SHA-256 is missing or malformed.");
  }
  return {
    tokenSha256:hashProductionTargetToken(token),
    databaseId,
    runtimeEndpointSha256,
    migrationEndpointSha256
  };
}

export function evaluateProductionTargetAnchor({
  evidence,
  schemaAclRows,
  tableAclRows,
  ownerMembershipRows,
  routineMembershipRows,
  inboundMembershipRows,
  expectedAnchor,
  allowedReaderNames
}){
  const errors=[];
  const allowedReaders=new Set(allowedReaderNames||[]);
  if(evidence?.singleton!==true)errors.push("production target anchor singleton is invalid");
  if(evidence?.target_token_sha256!==expectedAnchor?.tokenSha256)errors.push("production target token hash does not match");
  if(evidence?.database_id!==expectedAnchor?.databaseId)errors.push("production target database ID does not match");
  if(evidence?.runtime_endpoint_sha256!==expectedAnchor?.runtimeEndpointSha256)errors.push("production target runtime endpoint descriptor does not match");
  if(evidence?.migration_endpoint_sha256!==expectedAnchor?.migrationEndpointSha256)errors.push("production target migration endpoint descriptor does not match");
  if(!evidence?.schema_owner||evidence.schema_owner!==evidence?.table_owner)errors.push("production target anchor ownership is inconsistent");
  if(allowedReaders.has(evidence?.schema_owner))errors.push("production target anchor owner must be separate from routine database principals");
  if(!allowedReaders.has(evidence?.current_user_name)||evidence?.session_user_name!==evidence?.current_user_name){
    errors.push("production target reader identity is unexpected or ambiguous");
  }
  for(const field of ["schema_usage","table_select","scope_clean","column_acl_clean","schema_owner_membership_safe","table_owner_membership_safe","role_attributes_safe","role_membership_safe"]){
    if(evidence?.[field]!==true)errors.push(`production target anchor ${field} control failed`);
  }
  for(const field of ["schema_create","table_insert","table_update","table_delete","table_truncate","table_references","table_trigger","table_maintain"]){
    if(evidence?.[field]!==false)errors.push(`production target anchor ${field} privilege is not denied`);
  }
  const expectedSchemaAcl=new Set([...allowedReaders].map(grantee=>`${grantee}:USAGE:false`));
  const expectedTableAcl=new Set([...allowedReaders].map(grantee=>`${grantee}:SELECT:false`));
  const actualSchemaAcl=(schemaAclRows||[]).map(row=>`${row.grantee}:${row.privilege_type}:${String(row.is_grantable)}`);
  const actualTableAcl=(tableAclRows||[]).map(row=>`${row.grantee}:${row.privilege_type}:${String(row.is_grantable)}`);
  if(actualSchemaAcl.length!==expectedSchemaAcl.size||actualSchemaAcl.some(row=>!expectedSchemaAcl.has(row))){
    errors.push("production target anchor schema grants are not the exact reader ACL");
  }
  if(actualTableAcl.length!==expectedTableAcl.size||actualTableAcl.some(row=>!expectedTableAcl.has(row))){
    errors.push("production target anchor table grants are not the exact reader ACL");
  }
  const actualOwnerMemberships=(ownerMembershipRows||[]).filter(row=>allowedReaders.has(row.reader_name));
  if(
    actualOwnerMemberships.length!==allowedReaders.size||
    actualOwnerMemberships.some(row=>row.schema_owner_member!==false||row.table_owner_member!==false)
  ){
    errors.push("routine database principals must not be direct or transitive members of the production target anchor owner role");
  }
  if((routineMembershipRows||[]).length!==0){
    errors.push("routine database principals must not have direct or transitive role memberships other than the migrator's implicit pg_database_owner membership");
  }
  if((inboundMembershipRows||[]).length!==0){
    errors.push("unexpected roles must not be direct or transitive members of the target-anchor owner or routine database principals");
  }
  return {ok:errors.length===0,errors};
}

async function loadProductionTargetAnchorEvidence(client,label,allowedReaderNames){
  const relation=(await client.query("select pg_catalog.to_regclass('contracttwin_control.production_target_binding')::text relation_name")).rows[0];
  if(relation?.relation_name!==TARGET_ANCHOR_RELATION){
    throw new Error(`${label} is not externally anchored; run the separate approved target-bootstrap workflow first.`);
  }
  const evidenceRows=(await client.query(`
    select
      b.singleton,
      b.target_token_sha256,
      b.database_id::text database_id,
      b.runtime_endpoint_sha256,
      b.migration_endpoint_sha256,
      pg_catalog.pg_get_userbyid(n.nspowner)::text schema_owner,
      pg_catalog.pg_get_userbyid(c.relowner)::text table_owner,
      session_user::text session_user_name,
      current_user::text current_user_name,
      not pg_catalog.pg_has_role(current_user,pg_catalog.pg_get_userbyid(n.nspowner),'MEMBER') schema_owner_membership_safe,
      not pg_catalog.pg_has_role(current_user,pg_catalog.pg_get_userbyid(c.relowner),'MEMBER') table_owner_membership_safe,
      not (role_record.rolsuper or role_record.rolcreaterole or role_record.rolcreatedb or role_record.rolreplication or role_record.rolbypassrls) role_attributes_safe,
      not exists(
        select 1
          from pg_catalog.pg_roles other_role
         where other_role.oid OPERATOR(pg_catalog.<>) role_record.oid
           and other_role.rolname OPERATOR(pg_catalog.<>) 'pg_database_owner'
           and pg_catalog.pg_has_role(role_record.oid,other_role.oid,'MEMBER')
      ) role_membership_safe,
      pg_catalog.has_schema_privilege(current_user,n.oid,'USAGE') schema_usage,
      pg_catalog.has_schema_privilege(current_user,n.oid,'CREATE') schema_create,
      pg_catalog.has_table_privilege(current_user,c.oid,'SELECT') table_select,
      pg_catalog.has_table_privilege(current_user,c.oid,'INSERT') table_insert,
      pg_catalog.has_table_privilege(current_user,c.oid,'UPDATE') table_update,
      pg_catalog.has_table_privilege(current_user,c.oid,'DELETE') table_delete,
      pg_catalog.has_table_privilege(current_user,c.oid,'TRUNCATE') table_truncate,
      pg_catalog.has_table_privilege(current_user,c.oid,'REFERENCES') table_references,
      pg_catalog.has_table_privilege(current_user,c.oid,'TRIGGER') table_trigger,
      pg_catalog.has_table_privilege(current_user,c.oid,'MAINTAIN') table_maintain,
      not exists(
        select 1 from pg_catalog.pg_proc p where p.pronamespace OPERATOR(pg_catalog.=) n.oid
      ) and not exists(
        select 1
          from pg_catalog.pg_class other
         where other.relnamespace OPERATOR(pg_catalog.=) n.oid
           and other.oid OPERATOR(pg_catalog.<>) c.oid
           and not (
             other.relkind OPERATOR(pg_catalog.=) 'i'
             and exists(select 1 from pg_catalog.pg_index i where i.indexrelid OPERATOR(pg_catalog.=) other.oid and i.indrelid OPERATOR(pg_catalog.=) c.oid)
           )
      ) scope_clean,
      not exists(
        select 1 from pg_catalog.pg_attribute a
         where a.attrelid OPERATOR(pg_catalog.=) c.oid and a.attacl is not null
      ) column_acl_clean
    from contracttwin_control.production_target_binding b
    join pg_catalog.pg_namespace n on n.nspname OPERATOR(pg_catalog.=) 'contracttwin_control'
    join pg_catalog.pg_class c on c.relnamespace OPERATOR(pg_catalog.=) n.oid and c.relname OPERATOR(pg_catalog.=) 'production_target_binding' and c.relkind OPERATOR(pg_catalog.=) 'r'
    join pg_catalog.pg_roles role_record on role_record.rolname OPERATOR(pg_catalog.=) current_user
  `)).rows;
  if(evidenceRows.length!==1)throw new Error(`${label} anchor must contain exactly one row.`);
  const schemaAclRows=(await client.query(`
    select coalesce(r.rolname,'PUBLIC')::text grantee,
           acl.privilege_type::text privilege_type,
           acl.is_grantable
      from pg_catalog.pg_namespace n
      cross join lateral pg_catalog.aclexplode(coalesce(n.nspacl,pg_catalog.acldefault('n',n.nspowner))) acl
      left join pg_catalog.pg_roles r on r.oid OPERATOR(pg_catalog.=) acl.grantee
     where n.nspname OPERATOR(pg_catalog.=) 'contracttwin_control'
       and acl.grantee OPERATOR(pg_catalog.<>) n.nspowner
  `)).rows;
  const tableAclRows=(await client.query(`
    select coalesce(r.rolname,'PUBLIC')::text grantee,
           acl.privilege_type::text privilege_type,
           acl.is_grantable
      from pg_catalog.pg_class c
      join pg_catalog.pg_namespace n on n.oid OPERATOR(pg_catalog.=) c.relnamespace
      cross join lateral pg_catalog.aclexplode(coalesce(c.relacl,pg_catalog.acldefault('r',c.relowner))) acl
      left join pg_catalog.pg_roles r on r.oid OPERATOR(pg_catalog.=) acl.grantee
     where n.nspname OPERATOR(pg_catalog.=) 'contracttwin_control'
       and c.relname OPERATOR(pg_catalog.=) 'production_target_binding'
       and acl.grantee OPERATOR(pg_catalog.<>) c.relowner
  `)).rows;
  const ownerMembershipRows=(await client.query(`
    select reader.rolname::text reader_name,
           pg_catalog.pg_has_role(reader.oid,n.nspowner,'MEMBER') schema_owner_member,
           pg_catalog.pg_has_role(reader.oid,c.relowner,'MEMBER') table_owner_member
      from pg_catalog.pg_namespace n
      join pg_catalog.pg_class c on c.relnamespace OPERATOR(pg_catalog.=) n.oid
       and c.relname OPERATOR(pg_catalog.=) 'production_target_binding'
       and c.relkind OPERATOR(pg_catalog.=) 'r'
      join pg_catalog.pg_roles reader on reader.rolname OPERATOR(pg_catalog.=) any($1::text[])
     where n.nspname OPERATOR(pg_catalog.=) 'contracttwin_control'
     order by reader.rolname
  `,[allowedReaderNames])).rows;
  const routineMembershipRows=(await client.query(`
    select reader.rolname::text reader_name,
           member_role.rolname::text member_of
      from pg_catalog.pg_roles reader
      cross join pg_catalog.pg_roles member_role
     where reader.rolname OPERATOR(pg_catalog.=) any($1::text[])
       and member_role.oid OPERATOR(pg_catalog.<>) reader.oid
       and member_role.rolname OPERATOR(pg_catalog.<>) 'pg_database_owner'
       and pg_catalog.pg_has_role(reader.oid,member_role.oid,'MEMBER')
     order by reader.rolname,member_role.rolname
  `,[allowedReaderNames])).rows;
  const inboundMembershipRows=(await client.query(`
    with protected_roles as (
      select owner_role.oid,owner_role.rolname::text protected_role
        from pg_catalog.pg_namespace n
        join pg_catalog.pg_roles owner_role on owner_role.oid=n.nspowner
       where n.nspname OPERATOR(pg_catalog.=) 'contracttwin_control'
      union
      select routine_role.oid,routine_role.rolname::text
        from pg_catalog.pg_roles routine_role
       where routine_role.rolname OPERATOR(pg_catalog.=) any($1::text[])
    )
    select protected.protected_role,
           candidate.rolname::text unexpected_member
      from protected_roles protected
      cross join pg_catalog.pg_roles candidate
     where candidate.oid OPERATOR(pg_catalog.<>) protected.oid
       and candidate.rolsuper=false
       and pg_catalog.pg_has_role(candidate.oid,protected.oid,'MEMBER')
     order by protected.protected_role,candidate.rolname
  `,[allowedReaderNames])).rows;
  return {evidence:evidenceRows[0],schemaAclRows,tableAclRows,ownerMembershipRows,routineMembershipRows,inboundMembershipRows};
}

function assertAnchorInputs(expectedAnchor,allowedReaderNames,label){
  if(!expectedAnchor||!Array.isArray(allowedReaderNames)||allowedReaderNames.length!==2||new Set(allowedReaderNames).size!==2){
    throw new Error(`${label} anchor verification requires two distinct routine reader principals.`);
  }
}

export async function assertProductionTargetAnchor(client,{expectedAnchor,allowedReaderNames,label="Production target"}){
  assertAnchorInputs(expectedAnchor,allowedReaderNames,label);
  const {evidence,schemaAclRows,tableAclRows,ownerMembershipRows,routineMembershipRows,inboundMembershipRows}=await loadProductionTargetAnchorEvidence(client,label,allowedReaderNames);
  const evaluated=evaluateProductionTargetAnchor({evidence,schemaAclRows,tableAclRows,ownerMembershipRows,routineMembershipRows,inboundMembershipRows,expectedAnchor,allowedReaderNames});
  if(!evaluated.ok)throw new Error(`${label} anchor verification failed: ${evaluated.errors.join("; ")}`);
  return evidence;
}

export async function assertBootstrapOwnedProductionTargetAnchor(client,{expectedAnchor,allowedReaderNames,label="Production target bootstrap"}){
  assertAnchorInputs(expectedAnchor,allowedReaderNames,label);
  const {evidence,schemaAclRows,tableAclRows,ownerMembershipRows,routineMembershipRows,inboundMembershipRows}=await loadProductionTargetAnchorEvidence(client,label,allowedReaderNames);
  const errors=[];
  if(evidence?.singleton!==true)errors.push("production target anchor singleton is invalid");
  if(evidence?.target_token_sha256!==expectedAnchor.tokenSha256)errors.push("production target token hash does not match");
  if(evidence?.database_id!==expectedAnchor.databaseId)errors.push("production target database ID does not match");
  if(evidence?.runtime_endpoint_sha256!==expectedAnchor.runtimeEndpointSha256)errors.push("production target runtime endpoint descriptor does not match");
  if(evidence?.migration_endpoint_sha256!==expectedAnchor.migrationEndpointSha256)errors.push("production target migration endpoint descriptor does not match");
  if(!evidence?.schema_owner||evidence.schema_owner!==evidence?.table_owner||evidence.schema_owner!==evidence?.current_user_name){
    errors.push("production target bootstrap does not own the exact marker schema and table");
  }
  if(evidence?.session_user_name!==evidence?.current_user_name||allowedReaderNames.includes(evidence?.current_user_name)){
    errors.push("production target bootstrap identity is reused or ambiguous");
  }
  if(evidence?.scope_clean!==true||evidence?.column_acl_clean!==true){
    errors.push("production target bootstrap scope or column ACL is not exact");
  }
  if(evidence?.role_attributes_safe!==true||evidence?.role_membership_safe!==true){
    errors.push("production target bootstrap role has unsafe cluster authority or role membership");
  }
  const expectedSchemaAcl=new Set(allowedReaderNames.map(grantee=>`${grantee}:USAGE:false`));
  const expectedTableAcl=new Set(allowedReaderNames.map(grantee=>`${grantee}:SELECT:false`));
  const actualSchemaAcl=schemaAclRows.map(row=>`${row.grantee}:${row.privilege_type}:${String(row.is_grantable)}`);
  const actualTableAcl=tableAclRows.map(row=>`${row.grantee}:${row.privilege_type}:${String(row.is_grantable)}`);
  if(actualSchemaAcl.length!==expectedSchemaAcl.size||actualSchemaAcl.some(row=>!expectedSchemaAcl.has(row))){
    errors.push("production target bootstrap schema ACL is not exact");
  }
  if(actualTableAcl.length!==expectedTableAcl.size||actualTableAcl.some(row=>!expectedTableAcl.has(row))){
    errors.push("production target bootstrap table ACL is not exact");
  }
  if(
    ownerMembershipRows.length!==allowedReaderNames.length||
    ownerMembershipRows.some(row=>!allowedReaderNames.includes(row.reader_name)||row.schema_owner_member!==false||row.table_owner_member!==false)
  ){
    errors.push("routine database principals must not be direct or transitive members of the production target bootstrap owner role");
  }
  if(routineMembershipRows.length!==0){
    errors.push("routine database principals must not have direct or transitive role memberships other than the migrator's implicit pg_database_owner membership");
  }
  if(inboundMembershipRows.length!==0){
    errors.push("unexpected roles must not be direct or transitive members of the target-anchor owner or routine database principals");
  }
  if(errors.length)throw new Error(`${label} anchor verification failed: ${errors.join("; ")}`);
  return evidence;
}
