import {readFile} from "node:fs/promises";
import {resolve} from "node:path";
import pg from "pg";
import {verifiedDatabaseConnectionConfig} from "./database-connection-config.mjs";
import {parseEnvironmentFile} from "./production-env-check.mjs";
import {
  assertApprovedDatabaseEndpoints,
  assertBootstrapOwnedProductionTargetAnchor,
  assertProductionTargetAnchor,
  expectedProductionTargetAnchor
} from "./production-target-anchor.mjs";
import {
  assertHeldPreMigrationTargetChallenge,
  verifyPreMigrationTargetBinding
} from "./release-target-binding.mjs";
import {assertPristineProductionBootstrapTarget} from "./schema-migration-manifest.mjs";

const {Client}=pg;
const environmentFile=process.argv[2];
if(!environmentFile||process.argv.length!==3){
  throw new Error("Usage: node scripts/production-target-bootstrap.mjs <validated-production-env-file>");
}
const variables=parseEnvironmentFile(await readFile(resolve(environmentFile),"utf8"));
for(const protectedName of [
  "MIGRATION_DATABASE_URL",
  "PRODUCTION_DATABASE_BOOTSTRAP_URL",
  "EXPECTED_PRODUCTION_TARGET_TOKEN",
  "EXPECTED_PRODUCTION_DATABASE_ID",
  "EXPECTED_PRODUCTION_RUNTIME_DATABASE_ENDPOINT_SHA256",
  "EXPECTED_PRODUCTION_MIGRATION_DATABASE_ENDPOINT_SHA256",
  "EXPECTED_PRODUCTION_BOOTSTRAP_DATABASE_ENDPOINT_SHA256"
]){
  if(variables.has(protectedName))throw new Error(`${protectedName} must not be present in the pulled Vercel production environment.`);
}
for(const name of ["NODE_TLS_REJECT_UNAUTHORIZED","PGOPTIONS","PGSSLMODE"]){
  if(variables.has(name)||Object.hasOwn(process.env,name))throw new Error(`Production target bootstrap rejects inherited ${name}.`);
}

const runtimeConnectionString=variables.get("DATABASE_URL")||"";
const migrationConnectionString=process.env.MIGRATION_DATABASE_URL||"";
const bootstrapConnectionString=process.env.PRODUCTION_DATABASE_BOOTSTRAP_URL||"";
if(!runtimeConnectionString||!migrationConnectionString||!bootstrapConnectionString){
  throw new Error("Bootstrap, migration, and pulled runtime database credentials are required.");
}
if(new Set([runtimeConnectionString,migrationConnectionString,bootstrapConnectionString]).size!==3){
  throw new Error("Bootstrap, migration, and runtime database credentials must be distinct.");
}
const expectedAnchor=expectedProductionTargetAnchor({
  token:process.env.EXPECTED_PRODUCTION_TARGET_TOKEN||"",
  databaseId:process.env.EXPECTED_PRODUCTION_DATABASE_ID||"",
  runtimeEndpointSha256:process.env.EXPECTED_PRODUCTION_RUNTIME_DATABASE_ENDPOINT_SHA256||"",
  migrationEndpointSha256:process.env.EXPECTED_PRODUCTION_MIGRATION_DATABASE_ENDPOINT_SHA256||""
});
assertApprovedDatabaseEndpoints([runtimeConnectionString],expectedAnchor.runtimeEndpointSha256);
assertApprovedDatabaseEndpoints([migrationConnectionString],expectedAnchor.migrationEndpointSha256);
assertApprovedDatabaseEndpoints(
  [bootstrapConnectionString],
  process.env.EXPECTED_PRODUCTION_BOOTSTRAP_DATABASE_ENDPOINT_SHA256||""
);

function quoteIdentifier(value){return `"${String(value).replaceAll('"','""')}"`;}

async function verifyAnchoredReader({connectionString,applicationName,binding,expectedAnchor,allowedReaderNames,label}){
  const client=new Client(verifiedDatabaseConnectionConfig(connectionString,applicationName,{requireVerifiedTls:true}));
  let transactionOpen=false;
  try{
    await client.connect();
    await client.query("begin transaction read only");
    transactionOpen=true;
    await assertHeldPreMigrationTargetChallenge(client,{
      withinTransaction:true,
      encodedChallenge:binding.challenge,
      expectedFingerprint:binding.liveDatabaseFingerprint
    });
    await assertProductionTargetAnchor(client,{expectedAnchor,allowedReaderNames,label});
    await client.query("commit");
    transactionOpen=false;
  }finally{
    if(transactionOpen){try{await client.query("rollback");}catch{}}
    await client.end();
  }
}

const binding=await verifyPreMigrationTargetBinding({
  migrationConnectionString,
  runtimeConnectionString,
  requireVerifiedTls:true
});
const bootstrapClient=new Client(verifiedDatabaseConnectionConfig(
  bootstrapConnectionString,
  "contracttwin-production-target-bootstrap",
  {requireVerifiedTls:true}
));
let bootstrapTransactionOpen=false;
let anchorCreated=false;
try{
  await bootstrapClient.connect();
  await bootstrapClient.query("begin");
  bootstrapTransactionOpen=true;
  await assertHeldPreMigrationTargetChallenge(bootstrapClient,{
    withinTransaction:true,
    encodedChallenge:binding.challenge,
    expectedFingerprint:binding.liveDatabaseFingerprint
  });
  const bootstrapIdentity=(await bootstrapClient.query(`
    select
      session_user::text session_user_name,
      current_user::text current_user_name,
      pg_catalog.pg_is_in_recovery() in_recovery,
      pg_catalog.current_setting('transaction_read_only') transaction_read_only,
      pg_catalog.has_database_privilege(current_user,pg_catalog.current_database(),'CREATE') database_create,
      not (role_record.rolsuper or role_record.rolcreaterole or role_record.rolcreatedb or role_record.rolreplication or role_record.rolbypassrls) role_attributes_safe,
      not exists(
        select 1
          from pg_catalog.pg_roles other_role
         where other_role.oid OPERATOR(pg_catalog.<>) role_record.oid
           and pg_catalog.pg_has_role(role_record.oid,other_role.oid,'MEMBER')
      ) role_membership_safe
    from pg_catalog.pg_roles role_record
    where role_record.rolname OPERATOR(pg_catalog.=) current_user
  `)).rows[0];
  if(
    !bootstrapIdentity?.session_user_name||
    bootstrapIdentity.session_user_name!==bootstrapIdentity.current_user_name||
    [binding.migrationPrincipal,binding.runtimePrincipal].includes(bootstrapIdentity.session_user_name)||
    bootstrapIdentity.in_recovery!==false||
    bootstrapIdentity.transaction_read_only!=="off"||
    bootstrapIdentity.database_create!==true||
    bootstrapIdentity.role_attributes_safe!==true||
    bootstrapIdentity.role_membership_safe!==true
  ){
    throw new Error("Production target bootstrap identity is ambiguous, reused, read-only, or lacks narrow schema-creation authority.");
  }
  const allowedReaderNames=[binding.migrationPrincipal,binding.runtimePrincipal];
  const existingControlSchema=(await bootstrapClient.query("select pg_catalog.to_regnamespace('contracttwin_control')::text schema_name")).rows[0];
  if(existingControlSchema?.schema_name){
    await assertBootstrapOwnedProductionTargetAnchor(bootstrapClient,{
      expectedAnchor,allowedReaderNames,label:"Existing production target bootstrap"
    });
    await assertPristineProductionBootstrapTarget(
      bootstrapClient,
      "Existing production target bootstrap database",
      {requireExternalAnchor:true}
    );
    await bootstrapClient.query("rollback");
    bootstrapTransactionOpen=false;
  }else{
    await assertPristineProductionBootstrapTarget(bootstrapClient,"Production target bootstrap database");
    const migrationRole=quoteIdentifier(binding.migrationPrincipal);
    const runtimeRole=quoteIdentifier(binding.runtimePrincipal);
    await bootstrapClient.query("create schema contracttwin_control authorization current_user");
    await bootstrapClient.query("revoke all privileges on schema contracttwin_control from public");
    await bootstrapClient.query(`revoke all privileges on schema contracttwin_control from ${migrationRole},${runtimeRole}`);
    await bootstrapClient.query(`grant usage on schema contracttwin_control to ${migrationRole},${runtimeRole}`);
    await bootstrapClient.query(`
      create table contracttwin_control.production_target_binding(
        singleton boolean primary key default true,
        target_token_sha256 text not null unique check (target_token_sha256 ~ '^[0-9a-f]{64}$'),
        database_id uuid not null unique,
        runtime_endpoint_sha256 text not null check (runtime_endpoint_sha256 ~ '^[0-9a-f]{64}$'),
        migration_endpoint_sha256 text not null check (migration_endpoint_sha256 ~ '^[0-9a-f]{64}$'),
        created_at timestamptz not null default clock_timestamp(),
        constraint production_target_binding_singleton_check check (singleton)
      )
    `);
    await bootstrapClient.query(
      "insert into contracttwin_control.production_target_binding(singleton,target_token_sha256,database_id,runtime_endpoint_sha256,migration_endpoint_sha256) values(true,$1,$2::uuid,$3,$4)",
      [expectedAnchor.tokenSha256,expectedAnchor.databaseId,expectedAnchor.runtimeEndpointSha256,expectedAnchor.migrationEndpointSha256]
    );
    await bootstrapClient.query("revoke all privileges on table contracttwin_control.production_target_binding from public");
    await bootstrapClient.query(`revoke all privileges on table contracttwin_control.production_target_binding from ${migrationRole},${runtimeRole}`);
    await bootstrapClient.query(`grant select on table contracttwin_control.production_target_binding to ${migrationRole},${runtimeRole}`);
    await assertBootstrapOwnedProductionTargetAnchor(bootstrapClient,{
      expectedAnchor,allowedReaderNames,label:"New production target bootstrap"
    });
    await bootstrapClient.query("commit");
    bootstrapTransactionOpen=false;
    anchorCreated=true;
  }

  await verifyAnchoredReader({
    connectionString:migrationConnectionString,
    applicationName:"contracttwin-bootstrap-migrator-verifier",
    binding,expectedAnchor,allowedReaderNames,
    label:"Bootstrapped migration credential target"
  });
  await verifyAnchoredReader({
    connectionString:runtimeConnectionString,
    applicationName:"contracttwin-bootstrap-runtime-verifier",
    binding,expectedAnchor,allowedReaderNames,
    label:"Bootstrapped runtime credential target"
  });
  console.log(`Production target anchor ${anchorCreated?"created":"already exact"} and independently verified; no application/auth migration or deployment was performed.`);
}finally{
  if(bootstrapTransactionOpen){try{await bootstrapClient.query("rollback");}catch{}}
  await bootstrapClient.end();
  await binding.release();
}
