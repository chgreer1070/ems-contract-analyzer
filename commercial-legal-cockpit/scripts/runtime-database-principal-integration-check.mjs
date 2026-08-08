import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import pg from "pg";
import {RUNTIME_DATABASE_PRINCIPAL_QUERY,evaluateRuntimeDatabasePrincipal} from "./runtime-database-principal.mjs";
import {verifiedDatabaseConnectionConfig} from "./database-connection-config.mjs";

const {Client}=pg;
if(!process.env.RUNTIME_DATABASE_URL)throw new Error("RUNTIME_DATABASE_URL is required for restricted-runtime integration verification.");
const client=new Client(verifiedDatabaseConnectionConfig(process.env.RUNTIME_DATABASE_URL,"contracttwin-runtime-principal-negative-fixtures",{requireVerifiedTls:process.env.APP_ENV==="production"||process.env.VERCEL_ENV==="production"}));

async function expectPrivilegeDenied(name,sql){
  await client.query(`savepoint ${name}`);let observed;
  try{await client.query(sql);}catch(error){observed=error;}
  finally{await client.query(`rollback to savepoint ${name}`);await client.query(`release savepoint ${name}`);}
  assert.equal(observed?.code,"42501",`${name} must fail with insufficient_privilege; observed=${observed?.message||"no error"}`);
}

try{
  await client.connect();
  const evidence=(await client.query(RUNTIME_DATABASE_PRINCIPAL_QUERY)).rows[0];
  const evaluated=evaluateRuntimeDatabasePrincipal(evidence);
  assert.equal(evaluated.ok,true,`runtime principal preflight failed: ${evaluated.errors.join("; ")}`);
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
    await expectPrivilegeDenied("sp_runtime_release_receipt_truncate","truncate table public.release_target_receipts");
    await client.query("select filename,sha256 from public.schema_migrations order by filename limit 1");
    await client.query("select database_id from public.release_database_identity where singleton=true");
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
}finally{await client.end();}

console.log("Restricted runtime database fixtures passed: owner/DDL, system-schema creation, trigger creation, temp shadowing, replication-role changes, unapproved function execution, and migration writes are denied while exact application DML/sequence/helper-function privileges remain available.");
