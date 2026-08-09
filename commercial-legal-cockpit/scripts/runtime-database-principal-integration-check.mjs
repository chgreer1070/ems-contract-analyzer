import assert from "node:assert/strict";
import {randomBytes,randomUUID} from "node:crypto";
import pg from "pg";
import {RUNTIME_DATABASE_PRINCIPAL_QUERY,evaluateRuntimeDatabasePrincipal} from "./runtime-database-principal.mjs";
import {verifiedDatabaseConnectionConfig} from "./database-connection-config.mjs";

const {Client}=pg;
if(!process.env.RUNTIME_DATABASE_URL)throw new Error("RUNTIME_DATABASE_URL is required for restricted-runtime integration verification.");
if(!process.env.CONTROL_DATABASE_URL)throw new Error("CONTROL_DATABASE_URL is required for disposable role-topology fixtures.");
if(process.env.CI!=="true"||process.env.GITHUB_ACTIONS!=="true"||process.env.CI_DATABASE_CONTROL_FIXTURE!=="disposable-postgres-service"){
  throw new Error("Runtime role-topology integration is restricted to the marked disposable GitHub Actions PostgreSQL service.");
}
const controlUrl=new URL(process.env.CONTROL_DATABASE_URL);
if(!["localhost","127.0.0.1","[::1]"].includes(controlUrl.hostname)||decodeURIComponent(controlUrl.pathname)!=="/contracttwin"){
  throw new Error("Runtime role-topology integration refused a non-loopback or non-ephemeral owner target.");
}
const runtimeUrl=new URL(process.env.RUNTIME_DATABASE_URL);
const runtimeRole=decodeURIComponent(runtimeUrl.username);
if(!runtimeRole)throw new Error("Restricted runtime URL must identify its exact database role.");
function quoteIdentifier(value){return `"${String(value).replaceAll('"','""')}"`;}
function quoteLiteral(value){return `'${String(value).replaceAll("'","''")}'`;}
const client=new Client(verifiedDatabaseConnectionConfig(process.env.RUNTIME_DATABASE_URL,"contracttwin-runtime-principal-negative-fixtures",{requireVerifiedTls:process.env.APP_ENV==="production"||process.env.VERCEL_ENV==="production"}));
const controlClient=new Client(verifiedDatabaseConnectionConfig(process.env.CONTROL_DATABASE_URL,"contracttwin-runtime-principal-role-topology"));
const unexpectedRole=`contracttwin_unexpected_runtime_member_${randomBytes(6).toString("hex")}`;
const unexpectedPassword=randomBytes(32).toString("base64url");
let unexpectedRoleCreated=false;

async function expectPrivilegeDenied(name,sql){
  await client.query(`savepoint ${name}`);let observed;
  try{await client.query(sql);}catch(error){observed=error;}
  finally{await client.query(`rollback to savepoint ${name}`);await client.query(`release savepoint ${name}`);}
  assert.equal(observed?.code,"42501",`${name} must fail with insufficient_privilege; observed=${observed?.message||"no error"}`);
}

try{
  await client.connect();
  await controlClient.connect();
  const evidence=(await client.query(RUNTIME_DATABASE_PRINCIPAL_QUERY)).rows[0];
  const evaluated=evaluateRuntimeDatabasePrincipal(evidence);
  assert.equal(evaluated.ok,true,`runtime principal preflight failed: ${evaluated.errors.join("; ")}`);

  await controlClient.query(`create role ${quoteIdentifier(unexpectedRole)} login password ${quoteLiteral(unexpectedPassword)} noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls`);
  unexpectedRoleCreated=true;
  await controlClient.query(`grant ${quoteIdentifier(runtimeRole)} to ${quoteIdentifier(unexpectedRole)}`);
  const driftedEvidence=(await client.query(RUNTIME_DATABASE_PRINCIPAL_QUERY)).rows[0];
  const driftedEvaluation=evaluateRuntimeDatabasePrincipal(driftedEvidence);
  assert.equal(driftedEvidence.inbound_role_membership_safe,false,"runtime evidence must expose an unexpected non-superuser that can assume the protected runtime role");
  assert.equal(driftedEvaluation.ok,false,"continuous runtime principal health must fail closed on inbound role membership drift");

  const unexpectedUrl=new URL(process.env.CONTROL_DATABASE_URL);
  unexpectedUrl.username=unexpectedRole;
  unexpectedUrl.password=unexpectedPassword;
  const unexpectedClient=new Client(verifiedDatabaseConnectionConfig(unexpectedUrl.toString(),"contracttwin-runtime-principal-inbound-proof"));
  try{
    await unexpectedClient.connect();
    await unexpectedClient.query("begin");
    await unexpectedClient.query(`set role ${quoteIdentifier(runtimeRole)}`);
    const escaped=(await unexpectedClient.query("insert into public.customers(name) values($1) returning name",[`Inbound role proof ${randomUUID()}`])).rows[0];
    assert.match(escaped.name,/^Inbound role proof /,"an unexpected member can assume runtime and exercise legal-data DML, proving why health must reject the topology");
    await unexpectedClient.query("rollback");
  }finally{await unexpectedClient.end();}
  await controlClient.query(`revoke ${quoteIdentifier(runtimeRole)} from ${quoteIdentifier(unexpectedRole)}`);
  const repairedEvaluation=evaluateRuntimeDatabasePrincipal((await client.query(RUNTIME_DATABASE_PRINCIPAL_QUERY)).rows[0]);
  assert.equal(repairedEvaluation.ok,true,"runtime health must recover after the unexpected inbound membership is removed");

  await client.query("begin");
  try{
    await expectPrivilegeDenied("sp_runtime_disable_trigger","alter table public.agreement_versions disable trigger trg_agreement_execution_controls");
    await expectPrivilegeDenied("sp_runtime_create_trigger","create trigger zzz_runtime_forbidden_trigger before update on public.agreement_versions for each row execute function public.enforce_agreement_execution_controls()");
    await expectPrivilegeDenied("sp_runtime_temp_shadow","create temp table processing_jobs(id uuid)");
    await expectPrivilegeDenied("sp_runtime_system_schema_create","create function pg_catalog.contracttwin_runtime_escape() returns integer language sql as 'select 1'");
    await expectPrivilegeDenied("sp_runtime_replication_role","set local session_replication_role='replica'");
    await expectPrivilegeDenied("sp_runtime_migration_write","update public.schema_migrations set sha256=sha256");
    await expectPrivilegeDenied("sp_runtime_unapproved_pgcrypto","select public.hmac('a'::bytea,'b'::bytea,'sha256')");
    await expectPrivilegeDenied("sp_runtime_release_receipt_forge",`insert into public.release_target_receipts(nonce_sha256,database_id,source_sha) select '${"0".repeat(64)}',database_id,'${"0".repeat(40)}' from public.release_database_identity where singleton=true`);
    await expectPrivilegeDenied("sp_runtime_release_identity_write","update public.release_database_identity set database_id=database_id where singleton=true");
    await expectPrivilegeDenied("sp_runtime_release_external_identity_write","update public.release_database_external_identity set external_database_id=external_database_id where singleton=true");
    await expectPrivilegeDenied("sp_runtime_release_receipt_truncate","truncate table public.release_target_receipts");
    await client.query("select filename,sha256 from public.schema_migrations order by filename limit 1");
    await client.query("select database_id from public.release_database_identity where singleton=true");
    await client.query("select external_database_id,release_database_id from public.release_database_external_identity where singleton=true");
    await client.query("select source_sha,nonce_sha256 from public.release_target_receipts order by created_at desc limit 1");
    const canonical=(await client.query("select public.canonical_jsonb_text($1::jsonb) canonical",[{b:2,a:1}])).rows[0]?.canonical;
    assert.equal(canonical,'{"a":1,"b":2}',"restricted runtime must execute the approved immutable canonicalization helper");
    await client.query("select public.lock_documents_for_legal_publication(array[]::uuid[])");
    const missingReceipt=(await client.query("select public.executive_snapshot_receipt_verified($1::uuid) verified",[randomUUID()])).rows[0]?.verified;
    assert.equal(missingReceipt,false,"restricted runtime must execute the approved fail-closed snapshot receipt helper");
    const marker=`Runtime CRUD ${randomUUID()}`;
    const customer=(await client.query("insert into public.customers(name) values($1) returning id,name",[marker])).rows[0];
    assert.equal(customer.name,marker,"restricted runtime must retain allowed application INSERT");
    const updated=(await client.query("update public.customers set name=$2 where id=$1 returning name",[customer.id,`${marker} updated`])).rows[0];
    assert.equal(updated.name,`${marker} updated`,"restricted runtime must retain allowed application UPDATE");
    const deleted=await client.query("delete from public.customers where id=$1",[customer.id]);
    assert.equal(deleted.rowCount,1,"restricted runtime must retain allowed application DELETE");
  }finally{await client.query("rollback");}
}finally{
  await client.end();
  if(unexpectedRoleCreated){
    try{await controlClient.query(`revoke ${quoteIdentifier(runtimeRole)} from ${quoteIdentifier(unexpectedRole)}`);}catch{}
    try{await controlClient.query(`drop role ${quoteIdentifier(unexpectedRole)}`);}catch{}
  }
  await controlClient.end();
}

console.log("Restricted runtime database fixtures passed: inbound role escalation is detected, owner/DDL and other control bypasses are denied, and exact application DML/sequence/helper-function privileges remain available.");
