import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { Client } from "pg";
import {verifiedDatabaseConnectionConfig} from "./database-connection-config.mjs";

if(!process.env.DATABASE_URL)throw new Error("DATABASE_URL is required for target-schema drift verification.");

function runVerifier(){
  return new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,[path.resolve("scripts/verify-target-schema.mjs")],{
      cwd:process.cwd(),env:process.env,stdio:["ignore","pipe","pipe"],shell:false
    });
    let stdout="";let stderr="";
    child.stdout.on("data",chunk=>{stdout+=chunk;});
    child.stderr.on("data",chunk=>{stderr+=chunk;});
    child.on("error",reject);
    child.on("exit",code=>resolve({code,stdout,stderr}));
  });
}

const healthy=await runVerifier();
assert.equal(healthy.code,0,`healthy target-schema verification failed: ${healthy.stderr||healthy.stdout}`);

const client=new Client(verifiedDatabaseConnectionConfig(process.env.DATABASE_URL,"contracttwin-schema-drift-negative-fixture"));
let triggerDisabled=false;
let weakenedFunction=false;
let unexpectedTriggerCreated=false;
let unexpectedFunctionCreated=false;
let unexpectedRuleCreated=false;
let unexpectedTableCreated=false;
let originalFunctionDefinition="";
try{
  await client.connect();
  const receiptsBefore=(await client.query("select filename,sha256 from schema_migrations order by filename")).rows;
  try{
    await client.query("alter table agreement_versions disable trigger trg_agreement_execution_controls");
    triggerDisabled=true;
    const receiptsWhileDisabled=(await client.query("select filename,sha256 from schema_migrations order by filename")).rows;
    assert.deepEqual(receiptsWhileDisabled,receiptsBefore,"the disabled-trigger fixture must leave migration receipts intact");
    const disabledResult=await runVerifier();
    assert.notEqual(disabledResult.code,0,"target-schema gate must fail while the critical execution trigger is disabled");
    assert.match(`${disabledResult.stderr}\n${disabledResult.stdout}`,/invalid trigger public\.agreement_versions\.trg_agreement_execution_controls/);
  }finally{
    if(triggerDisabled){await client.query("alter table agreement_versions enable trigger trg_agreement_execution_controls");triggerDisabled=false;}
  }

  try{
    await client.query("create function public.contracttwin_test_unexpected_trigger() returns trigger language plpgsql as $$ begin new.role:='ADMIN'; return new; end; $$");
    unexpectedFunctionCreated=true;
    await client.query("create trigger zzz_test_unexpected_trigger before insert or update on app_user_roles for each row execute function public.contracttwin_test_unexpected_trigger()");
    unexpectedTriggerCreated=true;
    const receiptsWithUnexpectedTrigger=(await client.query("select filename,sha256 from schema_migrations order by filename")).rows;
    assert.deepEqual(receiptsWithUnexpectedTrigger,receiptsBefore,"the unexpected-trigger fixture must leave migration receipts intact");
    const unexpectedResult=await runVerifier();
    assert.notEqual(unexpectedResult.code,0,"target-schema gate must fail on an unexpected trigger on a public table with no expected triggers");
    assert.match(`${unexpectedResult.stderr}\n${unexpectedResult.stdout}`,/unexpected trigger public\.app_user_roles\.zzz_test_unexpected_trigger/);
  }finally{
    if(unexpectedTriggerCreated){await client.query("drop trigger zzz_test_unexpected_trigger on app_user_roles");unexpectedTriggerCreated=false;}
    if(unexpectedFunctionCreated){await client.query("drop function public.contracttwin_test_unexpected_trigger()");unexpectedFunctionCreated=false;}
  }

  try{
    await client.query("create rule zzz_test_unexpected_rule as on update to app_user_roles do also update app_user_capabilities set active=false where user_id=new.user_id");
    unexpectedRuleCreated=true;
    const receiptsWithUnexpectedRule=(await client.query("select filename,sha256 from schema_migrations order by filename")).rows;
    assert.deepEqual(receiptsWithUnexpectedRule,receiptsBefore,"the unexpected-rule fixture must leave migration receipts intact");
    const unexpectedRuleResult=await runVerifier();
    assert.notEqual(unexpectedRuleResult.code,0,"target-schema gate must fail on an unexpected user rewrite rule");
    assert.match(`${unexpectedRuleResult.stderr}\n${unexpectedRuleResult.stdout}`,/unexpected rewrite rule public\.app_user_roles\.zzz_test_unexpected_rule/);
  }finally{
    if(unexpectedRuleCreated){await client.query("drop rule zzz_test_unexpected_rule on app_user_roles");unexpectedRuleCreated=false;}
  }

  try{
    await client.query("create table public.zzz_test_unexpected_table(id integer)");
    unexpectedTableCreated=true;
    const receiptsWithUnexpectedTable=(await client.query("select filename,sha256 from schema_migrations order by filename")).rows;
    assert.deepEqual(receiptsWithUnexpectedTable,receiptsBefore,"the unexpected-table fixture must leave migration receipts intact");
    const unexpectedTableResult=await runVerifier();
    assert.notEqual(unexpectedTableResult.code,0,"target-schema gate must fail on an unexpected public table");
    assert.match(`${unexpectedTableResult.stderr}\n${unexpectedTableResult.stdout}`,/unexpected public table\(s\): zzz_test_unexpected_table/);
  }finally{
    if(unexpectedTableCreated){await client.query("drop table public.zzz_test_unexpected_table");unexpectedTableCreated=false;}
  }

  originalFunctionDefinition=(await client.query("select pg_get_functiondef('public.enforce_agreement_execution_controls()'::regprocedure) definition")).rows[0]?.definition??"";
  assert.match(originalFunctionDefinition,/CREATE OR REPLACE FUNCTION public\.enforce_agreement_execution_controls\(\)/i);
  try{
    await client.query("create or replace function public.enforce_agreement_execution_controls() returns trigger language plpgsql as $$ begin return new; end; $$");
    weakenedFunction=true;
    const receiptsWhileWeakened=(await client.query("select filename,sha256 from schema_migrations order by filename")).rows;
    assert.deepEqual(receiptsWhileWeakened,receiptsBefore,"the same-name weakened-function fixture must leave migration receipts intact");
    const weakenedResult=await runVerifier();
    assert.notEqual(weakenedResult.code,0,"target-schema gate must fail when a critical function keeps its name but loses its controls");
    assert.match(`${weakenedResult.stderr}\n${weakenedResult.stdout}`,/critical database object definition fingerprint mismatch/);
  }finally{
    if(weakenedFunction){await client.query(originalFunctionDefinition);weakenedFunction=false;}
  }
  const receiptsAfter=(await client.query("select filename,sha256 from schema_migrations order by filename")).rows;
  assert.deepEqual(receiptsAfter,receiptsBefore,"schema-drift fixtures must not alter migration receipts");
}finally{
  if(triggerDisabled)await client.query("alter table agreement_versions enable trigger trg_agreement_execution_controls");
  if(unexpectedTriggerCreated)await client.query("drop trigger zzz_test_unexpected_trigger on app_user_roles");
  if(unexpectedFunctionCreated)await client.query("drop function public.contracttwin_test_unexpected_trigger()");
  if(unexpectedRuleCreated)await client.query("drop rule zzz_test_unexpected_rule on app_user_roles");
  if(unexpectedTableCreated)await client.query("drop table public.zzz_test_unexpected_table");
  if(weakenedFunction&&originalFunctionDefinition)await client.query(originalFunctionDefinition);
  await client.end();
}

const restored=await runVerifier();
assert.equal(restored.code,0,`restored target-schema verification failed: ${restored.stderr||restored.stdout}`);
console.log("Target-schema drift check passed: intact migration receipts cannot mask a disabled trigger, an unexpected trigger on any public table, an unexpected public rewrite rule/table, or a same-name weakened function; every fixture restored the target.");
