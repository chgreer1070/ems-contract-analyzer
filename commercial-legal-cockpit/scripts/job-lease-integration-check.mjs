import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import pg from "pg";
import ts from "typescript";
import {verifiedDatabaseConnectionConfig} from "./database-connection-config.mjs";

const {Pool}=pg;
if(!process.env.DATABASE_URL)throw new Error("DATABASE_URL is required for processing-job lease integration verification.");

const root=process.cwd();
function loadTypeScript(relativePath,mocks={}){
  const filename=path.join(root,relativePath);
  const output=ts.transpileModule(fs.readFileSync(filename,"utf8"),{
    compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true},
    fileName:filename
  }).outputText;
  const module={exports:{}};
  const localRequire=specifier=>{
    if(Object.hasOwn(mocks,specifier))return mocks[specifier];
    throw new Error(`Unexpected import ${specifier} while loading ${relativePath}`);
  };
  new Function("require","module","exports",output)(localRequire,module,module.exports);
  return module.exports;
}

const pool=new Pool({...verifiedDatabaseConnectionConfig(process.env.DATABASE_URL,"contracttwin-job-lease-integration"),max:6});
const withTransaction=async fn=>{
  const client=await pool.connect();
  try{await client.query("begin");const result=await fn(client);await client.query("commit");return result;}
  catch(error){await client.query("rollback");throw error;}
  finally{client.release();}
};
const dbMock={query:(sql,values=[])=>pool.query(sql,values),withTransaction};
const leaseModule=loadTypeScript("lib/jobLease.ts");
const safeErrors={
  safeOperationalFailure:(_error,message)=>({message,correlationId:"00000000-0000-4000-8000-000000000000"}),
  safePersistedFailureForDisplay:value=>value
};
const jobs=loadTypeScript("lib/jobs.ts",{"@/lib/db":dbMock,"@/lib/jobLease":leaseModule,"@/lib/safeErrors":safeErrors});
const runtime=loadTypeScript("lib/jobRuntime.ts",{"@/lib/db":dbMock,"@/lib/jobLease":leaseModule});

const suffix=randomUUID();
const leaseHolder=await pool.connect();
const priorRecoverySetting=process.env.JOB_LEASE_RECOVERY_ENABLED;
process.env.JOB_LEASE_RECOVERY_ENABLED="false";
try{
  const queued=await jobs.enqueueJob({jobType:"VALIDATION",idempotencyKey:`ci-job-lease-${suffix}`,createdBy:"ci-lease",maxAttempts:3});
  const first=await runtime.claimJob(queued.id,"lease-worker-a");
  assert.equal(first.status,"RUNNING");
  assert.equal(first.lease_generation,1);
  assert.ok(first.last_heartbeat_at&&first.lease_expires_at,"a claim must persist heartbeat and expiry evidence");

  const advisory=(await leaseHolder.query("select pg_try_advisory_lock(hashtextextended($1,0)) locked",[`processing-job:${queued.id}`])).rows[0];
  assert.equal(advisory.locked,true,"fixture must hold a legacy processor advisory lock");
  await pool.query("update processing_jobs set last_heartbeat_at=now()-interval '2 seconds',lease_expires_at=now()-interval '1 second' where id=$1",[queued.id]);
  await assert.rejects(()=>jobs.heartbeatJob(first),error=>error instanceof jobs.JobLeaseLostError,"an expired generation must not renew itself before takeover");
  const rolloutBlockedTakeover=await runtime.claimJob(queued.id,"lease-worker-b");
  assert.equal(rolloutBlockedTakeover,null,"expired takeover must remain disabled until every pre-fencing worker is drained");
  process.env.JOB_LEASE_RECOVERY_ENABLED="true";
  const second=await runtime.claimJob(queued.id,"lease-worker-b");
  assert.equal(second.status,"RUNNING");
  assert.equal(second.locked_by,"lease-worker-b");
  assert.equal(advisory.locked,true,"a legacy session lock remains held during the takeover proof");
  assert.equal(second.lease_generation,2,"stale takeover must issue a new monotonic fence generation");

  await assert.rejects(()=>jobs.heartbeatJob(first),error=>error instanceof jobs.JobLeaseLostError,"a stale generation must not renew the current lease");
  await jobs.heartbeatJob(second);
  await pool.query("update processing_jobs set locked_at=now()-interval '20 minutes' where id=$1",[queued.id]);
  await assert.rejects(
    ()=>pool.query("update processing_jobs set status='RUNNING',attempts=attempts+1,locked_by='legacy-live-stealer',locked_at=now(),error_message='Recovered stale execution lock' where id=$1",[queued.id]),
    /Legacy processing-job owner takeover is disabled/,
    "exact pre-fencing stale-recovery SQL must not steal a live generation merely because locked_at aged"
  );
  const afterLegacyStealAttempt=await runtime.getJob(queued.id);
  assert.equal(afterLegacyStealAttempt.locked_by,"lease-worker-b");
  assert.equal(afterLegacyStealAttempt.lease_generation,2);
  await assert.rejects(()=>jobs.completeJob(first,{publisher:"stale"}),error=>error instanceof jobs.JobLeaseLostError,"a stale generation must not publish terminal state");
  const stillRunning=await runtime.getJob(queued.id);
  assert.equal(stillRunning.status,"RUNNING");
  assert.equal(stillRunning.lease_generation,2);

  let monotonicError;
  try{await pool.query("update processing_jobs set lease_generation=lease_generation-1 where id=$1",[queued.id]);}catch(error){monotonicError=error;}
  assert.match(String(monotonicError?.message||""),/cannot decrease/,"database trigger must reject a decreasing fence generation");

  await jobs.completeJob(second,{publisher:"current"});
  const succeeded=await runtime.getJob(queued.id);
  assert.equal(succeeded.status,"SUCCEEDED");
  assert.equal(succeeded.locked_by,null);
  assert.equal(succeeded.last_heartbeat_at,null);
  assert.equal(succeeded.lease_expires_at,null);

  const legacyQueued=await jobs.enqueueJob({jobType:"VALIDATION",idempotencyKey:`ci-job-legacy-lease-${suffix}`,createdBy:"ci-lease",maxAttempts:3});
  process.env.JOB_LEASE_RECOVERY_ENABLED="false";
  const legacyClaim=(await pool.query(`update processing_jobs
    set status='RUNNING',attempts=attempts+1,locked_by='legacy-worker',locked_at=now(),started_at=coalesce(started_at,now())
    where id=$1 returning status,lease_generation,last_heartbeat_at,lease_expires_at`,[legacyQueued.id])).rows[0];
  assert.equal(legacyClaim.status,"RUNNING");
  assert.equal(legacyClaim.lease_generation,1,"the expand bridge must normalize a pre-fencing worker claim into a generation");
  assert.ok(legacyClaim.last_heartbeat_at&&legacyClaim.lease_expires_at,"the expand bridge must supply complete lease evidence");
  await pool.query("update processing_jobs set last_heartbeat_at=now()-interval '2 seconds',lease_expires_at=now()-interval '1 second' where id=$1",[legacyQueued.id]);
  const legacyOverlap=await runtime.claimJob(legacyQueued.id,"new-worker-during-expand");
  assert.equal(legacyOverlap,null,"the new bundle must not recover a legacy in-flight job during the drain phase");
  await assert.rejects(
    ()=>pool.query("update processing_jobs set status='RUNNING',attempts=attempts+1,locked_by='other-legacy-worker',locked_at=now(),error_message='Recovered stale execution lock' where id=$1",[legacyQueued.id]),
    /Legacy processing-job owner takeover is disabled/,
    "legacy stale-owner takeover must remain disabled even after expiry until all old publishers drain"
  );
  const legacyComplete=(await pool.query(`update processing_jobs
    set status='SUCCEEDED',output='{"publisher":"legacy"}'::jsonb,error_message=null,finished_at=now(),locked_by=null,locked_at=null
    where id=$1 returning status,last_heartbeat_at,lease_expires_at`,[legacyQueued.id])).rows[0];
  assert.equal(legacyComplete.status,"SUCCEEDED");
  assert.equal(legacyComplete.last_heartbeat_at,null,"the expand bridge must normalize a legacy terminal write");
  assert.equal(legacyComplete.lease_expires_at,null);
  process.env.JOB_LEASE_RECOVERY_ENABLED="true";

  const dependencyKey=`dependency:ci:${suffix}`;
  const failedChild=(await pool.query(`insert into processing_jobs(job_type,status,idempotency_key,created_by,attempts,max_attempts,error_message,finished_at) values('DEPENDENCY','FAILED',$1,'ci-lease',3,3,'fixture failure',now()) returning id`,[dependencyKey])).rows[0];
  const retriedChild=await jobs.enqueueJob({jobType:"DEPENDENCY",idempotencyKey:dependencyKey,createdBy:"ci-lease",input:{termAnalysisRunId:randomUUID()},maxAttempts:3});
  assert.equal(retriedChild.id,failedChild.id,"retry-aware enqueue must retain the dependency job identity");
  assert.equal(retriedChild.status,"QUEUED");
  assert.equal(retriedChild.attempts,0);
  const claimedRetry=await runtime.claimJob(retriedChild.id,"lease-worker-c");
  assert.equal(claimedRetry.status,"RUNNING","a failed dependency child must be runnable after common enqueue reactivation");
  await jobs.continueJob(claimedRetry,{retryGeneration:1},0);
  const waiting=await runtime.getJob(retriedChild.id);
  assert.equal(waiting.status,"WAITING_EXTERNAL");
  assert.equal(waiting.locked_by,null);
  assert.equal(waiting.lease_expires_at,null);

  const operationUrl="https://example.invalid/azure/operation-42";
  const external=await jobs.enqueueJob({jobType:"OCR",idempotencyKey:`ci-job-external-${suffix}`,createdBy:"ci-lease",maxAttempts:3});
  const externalSubmit=await runtime.claimJob(external.id,"lease-worker-external-a");
  await jobs.waitExternal(externalSubmit,operationUrl,{sourceSha256:"a".repeat(64)},1);
  await pool.query("update processing_jobs set next_attempt_at=now() where id=$1",[external.id]);
  const externalPoll=await runtime.claimJob(external.id,"lease-worker-external-b");
  assert.equal(externalPoll.external_operation_url,operationUrl);
  await jobs.failJob(externalPoll,new Error("transient polling transport failure"),true,true);
  const resumable=await runtime.getJob(external.id);
  assert.equal(resumable.status,"QUEUED");
  assert.equal(resumable.external_operation_url,operationUrl,"transient polling failures must resume the same external operation");
  await pool.query("update processing_jobs set next_attempt_at=now() where id=$1",[external.id]);
  const rejectedPoll=await runtime.claimJob(external.id,"lease-worker-external-c");
  await jobs.failJob(rejectedPoll,new Error("provider declared the operation failed"),true,false);
  const replaceable=await runtime.getJob(external.id);
  assert.equal(replaceable.status,"QUEUED");
  assert.equal(replaceable.external_operation_url,null,"provider-declared failed operations must be replaced on retry");
}finally{
  if(priorRecoverySetting===undefined)delete process.env.JOB_LEASE_RECOVERY_ENABLED;else process.env.JOB_LEASE_RECOVERY_ENABLED=priorRecoverySetting;
  try{await leaseHolder.query("select pg_advisory_unlock_all()");}finally{leaseHolder.release();await pool.end();}
}

console.log("PostgreSQL processing-job concurrency, fencing, heartbeat, and dependency retry controls passed.");
