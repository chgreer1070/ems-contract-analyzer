import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

const root=process.cwd();
const read=relativePath=>fs.readFileSync(path.join(root,relativePath),"utf8");

function loadPureTypeScript(relativePath){
  const filename=path.join(root,relativePath);
  const output=ts.transpileModule(read(relativePath),{
    compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022},
    fileName:filename
  }).outputText;
  const module={exports:{}};
  new Function("require","module","exports",output)(specifier=>{throw new Error(`Unexpected pure-module import ${specifier}`);},module,module.exports);
  return module.exports;
}

const lease=loadPureTypeScript("lib/jobLease.ts");
assert.equal(lease.jobLeaseDurationSeconds(undefined),900);
assert.equal(lease.jobLeaseDurationSeconds("not-a-number"),900);
assert.equal(lease.jobLeaseDurationSeconds(1),60);
assert.equal(lease.jobLeaseDurationSeconds(7200),3600);
assert.equal(lease.jobLeaseDurationSeconds(181.9),181);
assert.equal(lease.jobHeartbeatIntervalMillis(60),20_000);
assert.equal(lease.jobHeartbeatIntervalMillis(900),30_000);
assert.equal(lease.jobLeaseRecoveryEnabled(undefined),false,"expired-lease recovery must default off for expand-compatible rollout");
assert.equal(lease.jobLeaseRecoveryEnabled("false"),false);
assert.equal(lease.jobLeaseRecoveryEnabled("true"),true);

const migration=read("db/migrations/012_processing_job_lease_fencing.sql");
for(const required of [
  "lease_generation",
  "last_heartbeat_at",
  "lease_expires_at",
  "processing_jobs_lease_state_check",
  "enforce_processing_job_lease_fence",
  "trg_processing_job_lease_fence",
  "idx_processing_jobs_expired_running_lease"
])assert.match(migration,new RegExp(required),`lease migration must contain ${required}`);
assert.match(migration,/lease_generation < old\.lease_generation/,"database fence generation must be monotonic");
assert.match(migration,/old\.status <> 'RUNNING' and new\.status = 'RUNNING'[\s\S]*old\.lease_generation \+ 1/,"every new RUNNING lease must advance one generation");
assert.match(migration,/Expand-compatible bridge for workers deployed before lease fencing[\s\S]*new\.last_heartbeat_at :=[\s\S]*new\.lease_expires_at :=/,"the expansion migration must normalize a legacy claim before contract enforcement");
assert.match(migration,/set search_path = pg_catalog, public, pg_temp/,"lease trigger must use a controlled search path");

const runtime=read("lib/jobRuntime.ts");
assert.match(runtime,/jobLeaseRecoveryEnabled\(\)/,"stale takeover must remain disabled until pre-fencing workers are drained");
assert.ok((runtime.match(/lease_expires_at<=now\(\)/g)||[]).length>=2,"PostgreSQL time must authorize both expired takeover and exhausted-lease failure");
assert.doesNotMatch(runtime,/function leaseExpired/,"application clock must not adjudicate lease expiry");
assert.doesNotMatch(runtime,/advisory_lock|advisory_xact_lock/,"an expired lease must not be blocked by a hung worker's session advisory lock");
assert.match(runtime,/locked_by is not distinct from \$3 and lease_generation=\$5/,"stale takeover must bind the prior owner and generation");
assert.match(runtime,/lease_generation=lease_generation\+1/,"every claim must advance the fence generation");

const jobs=read("lib/jobs.ts");
assert.match(jobs,/where id=\$1 and status='RUNNING' and locked_by=\$2 and lease_generation=\$3/g,"heartbeat and publication must bind exact status, owner, and generation");
assert.ok((jobs.match(/lease_expires_at>now\(\)/g)||[]).length>=3,"heartbeat, assertion, and terminal publication must all reject an expired lease");
assert.doesNotMatch(jobs,/advisory_lock|advisory_xact_lock/,"row locking and monotonic generation CAS must be the claim authority");
assert.match(jobs,/last_heartbeat_at=now\(\), lease_expires_at=now\(\) \+ make_interval/,"heartbeats must preserve expiry evidence");
assert.match(jobs,/class JobLeaseLostError/,"lost ownership must have an explicit non-retry publication error");
assert.match(jobs,/on conflict \(idempotency_key\) do update set[\s\S]*status=case when processing_jobs\.status in \('FAILED','CANCELLED'\) then 'QUEUED'/,"idempotent enqueue must reactivate a failed dependency child");
assert.match(jobs,/operationUrl: retry && preserveExternalOperation \? job\.external_operation_url : null/,"retry must explicitly preserve only a resumable external operation");

const processor=read("lib/jobProcessor.ts");
assert.doesNotMatch(processor,/update processing_jobs set status=/,"processor domain transactions must use the common fenced transition primitive");
assert.ok((processor.match(/assertJobLease\(client,job\)/g)||[]).length>=13,"every domain-publication transaction must assert the current fence");
assert.doesNotMatch(processor,/advisory_lock|advisory_unlock/,"process-lifetime advisory locks must not defeat expired-lease recovery");
assert.match(processor,/await heartbeatJob\(job\)/,"processor must verify that its exact lease is still live before work begins");
assert.match(processor,/error instanceof JobLeaseLostError[\s\S]*throw/,"a stale processor must not publish a retry or terminal failure");
assert.match(processor,/result\.status==="failed"\) throw new ExternalOperationRejectedError[\s\S]*failJob\(job,error,retryable,!\(error instanceof ExternalOperationRejectedError\)\)/,"provider-declared failed operations must be replaced while transient polling failures resume");

const pipeline=read("workflows/full-contract-pipeline.ts");
assert.match(pipeline,/createDependencyStage[\s\S]*enqueueJob/,"pipeline retries must pass dependency children through common retry-aware enqueue semantics");
assert.match(pipeline,/dependency:\$\{input\.matterId\}:\$\{termAnalysisRunId\}/,"dependency retries must retain the exact term-run generation key");

console.log("Processing-job lease fencing and retry controls passed.");
