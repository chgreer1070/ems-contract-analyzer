import assert from "node:assert/strict";
import {
  assertApprovedDatabaseEndpoints,
  databaseEndpointSha256,
  evaluateProductionTargetAnchor,
  expectedProductionTargetAnchor,
  hashProductionTargetToken
} from "./production-target-anchor.mjs";

const token="a".repeat(64);
const databaseId="123e4567-e89b-42d3-a456-426614174000";
const migrationUrl="postgresql://migration:secret@db.example.com:5432/contracttwin?sslmode=verify-full";
const runtimeUrl="postgresql://runtime:different@DB.EXAMPLE.COM/contracttwin?sslmode=verify-full";
const endpointSha256=databaseEndpointSha256(migrationUrl);
assert.equal(databaseEndpointSha256(runtimeUrl),endpointSha256,"credential details and hostname case must not change the approved endpoint descriptor");
assertApprovedDatabaseEndpoints([migrationUrl,runtimeUrl],endpointSha256);
assert.throws(
  ()=>assertApprovedDatabaseEndpoints([migrationUrl,"postgresql://runtime:secret@staging.example.com/contracttwin"],endpointSha256),
  /externally approved endpoint descriptor/
);
assert.throws(
  ()=>databaseEndpointSha256("postgresql://runtime:secret@db.example.com/contracttwin?host=staging.example.com"),
  /may not override host through query parameters/,
  "endpoint approval must hash the same host that node-postgres will use"
);
assert.throws(()=>hashProductionTargetToken("short"),/64 lowercase hexadecimal/);

const expectedAnchor=expectedProductionTargetAnchor({
  token,databaseId,
  runtimeEndpointSha256:endpointSha256,
  migrationEndpointSha256:endpointSha256
});
const allowedReaderNames=["contracttwin_migrator","contracttwin_runtime"];
const evidence={
  singleton:true,
  target_token_sha256:hashProductionTargetToken(token),
  database_id:databaseId,
  runtime_endpoint_sha256:endpointSha256,
  migration_endpoint_sha256:endpointSha256,
  schema_owner:"contracttwin_bootstrap",
  table_owner:"contracttwin_bootstrap",
  session_user_name:"contracttwin_migrator",
  current_user_name:"contracttwin_migrator",
  schema_usage:true,
  schema_create:false,
  table_select:true,
  table_insert:false,
  table_update:false,
  table_delete:false,
  table_truncate:false,
  table_references:false,
  table_trigger:false,
  table_maintain:false,
  scope_clean:true,
  column_acl_clean:true,
  schema_owner_membership_safe:true,
  table_owner_membership_safe:true,
  role_attributes_safe:true,
  role_membership_safe:true
};
const schemaAclRows=allowedReaderNames.map(grantee=>({grantee,privilege_type:"USAGE",is_grantable:false}));
const tableAclRows=allowedReaderNames.map(grantee=>({grantee,privilege_type:"SELECT",is_grantable:false}));
const ownerMembershipRows=allowedReaderNames.map(reader_name=>({reader_name,schema_owner_member:false,table_owner_member:false}));
const routineMembershipRows=[];
const inboundMembershipRows=[];
assert.equal(evaluateProductionTargetAnchor({evidence,schemaAclRows,tableAclRows,ownerMembershipRows,routineMembershipRows,inboundMembershipRows,expectedAnchor,allowedReaderNames}).ok,true);
assert.equal(evaluateProductionTargetAnchor({evidence:{...evidence,database_id:"223e4567-e89b-42d3-a456-426614174000"},schemaAclRows,tableAclRows,ownerMembershipRows,routineMembershipRows,inboundMembershipRows,expectedAnchor,allowedReaderNames}).ok,false,"a mismatched approved database identity must fail");
assert.equal(evaluateProductionTargetAnchor({evidence:{...evidence,table_update:true},schemaAclRows,tableAclRows,ownerMembershipRows,routineMembershipRows,inboundMembershipRows,expectedAnchor,allowedReaderNames}).ok,false,"routine target readers must not mutate the anchor");
assert.equal(evaluateProductionTargetAnchor({evidence,schemaAclRows:[...schemaAclRows,{grantee:"unexpected_role",privilege_type:"USAGE",is_grantable:false}],tableAclRows,ownerMembershipRows,routineMembershipRows,inboundMembershipRows,expectedAnchor,allowedReaderNames}).ok,false,"unexpected anchor readers must fail");
assert.equal(evaluateProductionTargetAnchor({evidence,schemaAclRows:schemaAclRows.map((row,index)=>index===0?{...row,is_grantable:true}:row),tableAclRows,ownerMembershipRows,routineMembershipRows,inboundMembershipRows,expectedAnchor,allowedReaderNames}).ok,false,"routine readers must not receive grant options on the anchor");
assert.equal(evaluateProductionTargetAnchor({evidence:{...evidence,schema_owner_membership_safe:false},schemaAclRows,tableAclRows,ownerMembershipRows,routineMembershipRows,inboundMembershipRows,expectedAnchor,allowedReaderNames}).ok,false,"routine readers must not be able to SET ROLE to the anchor owner");
assert.equal(evaluateProductionTargetAnchor({evidence,schemaAclRows,tableAclRows,ownerMembershipRows:ownerMembershipRows.map((row,index)=>index===0?{...row,table_owner_member:true}:row),routineMembershipRows,inboundMembershipRows,expectedAnchor,allowedReaderNames}).ok,false,"bootstrap verification must reject owner-role membership for either routine reader");
assert.equal(evaluateProductionTargetAnchor({evidence,schemaAclRows,tableAclRows,ownerMembershipRows,routineMembershipRows:[{reader_name:allowedReaderNames[1],member_of:allowedReaderNames[0]}],inboundMembershipRows,expectedAnchor,allowedReaderNames}).ok,false,"routine readers must not SET ROLE to one another");
assert.equal(evaluateProductionTargetAnchor({evidence,schemaAclRows,tableAclRows,ownerMembershipRows,routineMembershipRows,inboundMembershipRows:[{protected_role:evidence.schema_owner,unexpected_member:"unexpected_operator"}],expectedAnchor,allowedReaderNames}).ok,false,"unexpected roles must not inherit a protected owner or routine role");

console.log("Production target anchor checks passed: external token, endpoint, database ID, separate ownership, and read-only ACLs fail closed.");
