import assert from "node:assert/strict";
import fs from "node:fs/promises";
import {createHash,randomUUID} from "node:crypto";
import {execFileSync} from "node:child_process";
import pg from "pg";
import {createTypeScriptLoader} from "../../../scripts/ts-test-loader.mjs";
import {fixture,p,text} from "../../../validation/docx/fixtures.mjs";

// This executable only accepts a fresh disposable LOCAL database. It does not
// read DATABASE_URL or any production provider credential. All storage/model
// calls are explicit in-memory doubles; PostgreSQL and application SQL are real.
const sha=value=>createHash("sha256").update(value).digest("hex");
const candidate=execFileSync("git",["rev-parse","HEAD"],{encoding:"utf8"}).trim();
const mime="application/vnd.openxmlformats-officedocument.wordprocessingml.document";
process.env.LEGAL_RELIANCE_ENABLED="false";
process.env.JOB_LEASE_RECOVERY_ENABLED="false";
process.env.BLOB_READ_WRITE_TOKEN="synthetic-local-boundary-only";
delete process.env.OPENAI_API_KEY;
const real=createTypeScriptLoader();
const {extractDocx}=real("lib/docxExtraction.ts");
const {assertDocxReceipt,createDocxReceipt}=real("lib/docxReceipt.ts");
const analysis=real("lib/analysisEngine.ts");
const terms=real("lib/termEngine.ts");
const source=await fixture();
const parsed=extractDocx(source);
assert.equal(parsed.evidence.analysisEligible,true);
assertDocxReceipt(createDocxReceipt(parsed.evidence,parsed.chunks),sha(Buffer.from(source)),parsed.chunks.map(c=>({chunk_index:c.chunkIndex,content:c.text,content_sha256:c.sha256})));
if(process.argv.includes("--verify-harness")){
  console.log(JSON.stringify({candidate,status:"HARNESS_INPUT_CHECK_PASS",postgresqlScenarios:"NOT_EXECUTED",fixtureSha256:sha(Buffer.from(source))}));
  process.exit(0);
}
const raw=process.env.LOCAL_DOCX_ACCEPTANCE_URL;
if(!raw)throw new Error("LOCAL_DOCX_ACCEPTANCE_URL is required; PostgreSQL scenarios were not executed.");
const url=new URL(raw);
if(!["postgres:","postgresql:"].includes(url.protocol)||!["127.0.0.1","localhost","[::1]"].includes(url.hostname)||!/^\/ct_docx_acceptance_[a-z0-9_]+$/.test(url.pathname)||url.search)
  throw new Error("Only a loopback disposable ct_docx_acceptance_* database with no URL options is permitted.");
if(process.env.LOCAL_DOCX_ACCEPTANCE_INIT!=="EMPTY_DISPOSABLE_DATABASE")
  throw new Error("LOCAL_DOCX_ACCEPTANCE_INIT=EMPTY_DISPOSABLE_DATABASE is required to initialize an empty local test database.");
const pool=new pg.Pool({connectionString:raw,max:8,ssl:false,application_name:"contracttwin-docx-local-acceptance",connectionTimeoutMillis:5000,statement_timeout:15000});
const results=[];
const boundary={blobs:new Map(),modelCalls:0,pauseBlob:null,interruptComplete:false,pausePublication:null};
const db={query:(sql,values=[])=>pool.query(sql,values),withTransaction:async fn=>{
  const client=await pool.connect();
  try{
    await client.query("begin");
    const wrapped={query:async(sql,values=[])=>{
      if(boundary.pausePublication&&sql.startsWith("select id,matter_id")&&sql.endsWith("for update"))await boundary.pausePublication();
      return client.query(sql,values);
    }};
    const result=await fn(wrapped);await client.query("commit");return result;
  }catch(error){await client.query("rollback");throw error;}finally{client.release();}
}};
const safeErrors={safeOperationalFailure:()=>({message:"Synthetic local processing failure."}),safePersistedFailureForDisplay:value=>value};
const loader=createTypeScriptLoader({"@/lib/db":db,"@/lib/safeErrors":safeErrors});
const jobs=loader("lib/jobs.ts"),runtime=loader("lib/jobRuntime.ts");
const unexpected=()=>{throw new Error("Unexpected external or consequential operation.");};
const jobsBoundary={...jobs,pollAzureOcr:unexpected,completeJob:async(job,output)=>{
  if(boundary.interruptComplete){boundary.interruptComplete=false;throw new Error("Synthetic interruption before receipt seal.");}
  return jobs.completeJob(job,output);
}};
const {processJob}=createTypeScriptLoader({
  "@/lib/db":db,"@/lib/safeErrors":safeErrors,"@/lib/jobs-internal":jobsBoundary,
  "@vercel/blob":{get:async pathname=>{if(boundary.pauseBlob)await boundary.pauseBlob(pathname);const bytes=boundary.blobs.get(pathname);assert.ok(bytes);return {statusCode:200,stream:new Response(bytes).body};}},
  "@/lib/analysisEngine":{...analysis,legalRelianceEnabled:false,analyzeContractText:async()=>{boundary.modelCalls++;return {findings:[],rejectedUngroundedFindings:0,modelName:"synthetic-boundary-double",mode:"model"};}},
  "@/lib/termEngine":{...terms,extractTerms:async()=>{boundary.modelCalls++;return {terms:[],rejectedUngrounded:0,modelName:"synthetic-boundary-double"};}},
  "@/lib/findings":{enrichFindings:async findings=>findings},
  "@/lib/dependencyEngine":{inferDependencies:unexpected},"@/lib/precedenceEngine":{analyzePrecedence:unexpected},
  "@/lib/ocr":{azureOcrConfigured:()=>false,pollAzureOcr:unexpected,submitAzureOcr:unexpected},
  "@/lib/malwareScan":{scanBuffer:unexpected},"@/lib/readiness":{assertLegalRelianceReady:unexpected,legalRelianceEvidence:unexpected}
})("lib/jobProcessor.ts");
async function check(name,fn){try{const detail=await fn();results.push({name,status:"PASS",detail});console.log(`PASS ${name}`);}catch(error){results.push({name,status:"FAIL",errorCode:error.code??null,message:error.message});console.log(`FAIL ${name}: ${error.message}`);}}
async function document(bytes=source){
  const customer=(await pool.query("insert into customers(name) values('Synthetic local acceptance') returning id")).rows[0];
  const matter=(await pool.query("insert into matters(matter_number,customer_id,agreement_title,region,owner_user_id) values($1,$2,'Synthetic DOCX','LOCAL','synthetic-worker') returning id",[`LOCAL-${randomUUID()}`,customer.id])).rows[0];
  const pathname=`synthetic-local/${randomUUID()}.docx`,hash=sha(Buffer.from(bytes));boundary.blobs.set(pathname,bytes);
  return (await pool.query("insert into documents(matter_id,filename,document_type,mime_type,size_bytes,blob_url,blob_pathname,sha256,server_sha256,integrity_status,security_scan_status,uploaded_by) values($1,'synthetic.docx','MSA',$2,$3,'https://example.invalid/synthetic',$4,$5,$5,'SERVER_VERIFIED','CLEAN','synthetic-worker') returning *",[matter.id,mime,bytes.byteLength,pathname,hash])).rows[0];
}
async function enqueue(doc,type="EXTRACT",maxAttempts=1){const key=`local:${type}:${randomUUID()}`;return {...await jobs.enqueueJob({matterId:doc.matter_id,documentId:doc.id,jobType:type,idempotencyKey:key,createdBy:"synthetic-worker",input:{requestedBy:"synthetic-worker"},maxAttempts}),idempotency_key:key};}
async function run(queued){const claim=await runtime.claimJob(queued.id,`local-worker-${randomUUID()}`);assert.equal(claim.status,"RUNNING");await processJob(claim);return runtime.getJob(claim.id);}
async function extracted(){const doc=await document(),job=await run(await enqueue(doc));assert.equal(job.status,"SUCCEEDED");return {doc,job};}
function gate(){let release,entered;return {ready:new Promise(r=>entered=r),wait:()=>{entered();return new Promise(r=>release=r);},release:()=>release()};}
async function insertTerm(doc,reviewed=false,exactText="Customer shall pay within 60 days of invoice."){
  const chunk=(await pool.query("select * from document_chunks where document_id=$1 order by chunk_index",[doc.id])).rows[0];
  const run=(await pool.query("insert into analysis_runs(matter_id,document_id,run_type,status,model_name,prompt_version,schema_version,input_sha256,source_chunk_count,created_by) values($1,$2,'TERM_EXTRACTION','RUNNING','synthetic-boundary-double','synthetic.v1','synthetic.v1',$3,1,'synthetic-worker') returning id",[doc.matter_id,doc.id,sha(chunk.content_sha256)])).rows[0];
  const term=(await pool.query("insert into contract_terms(matter_id,document_id,analysis_run_id,chunk_id,clause_family,term_type,exact_text,exact_text_sha256,normalized_statement,created_by) values($1,$2,$3,$4,'payment_terms','OBLIGATION',$5,$6,'Unapproved proposed text: synthetic payment term','synthetic-worker') returning *",[doc.matter_id,doc.id,run.id,chunk.id,exactText,sha(exactText)])).rows[0];
  await pool.query("update analysis_runs set status='SUCCEEDED',output_count=1,finished_at=now() where id=$1",[run.id]);
  if(reviewed)await pool.query("update contract_terms set review_status='VALIDATED',reviewed_by='synthetic-reviewer',reviewed_at=now(),review_note='Synthetic local retention test only.' where id=$1",[term.id]);
  return {term,chunk,run};
}
try{
  const tables=(await pool.query("select tablename from pg_tables where schemaname='public'")).rows;
  assert.equal(tables.length,0,"Refuse to migrate a nonempty database, even if it has the disposable prefix.");
  const migrationDir="db/migrations",files=(await fs.readdir(migrationDir)).filter(f=>/^\d{3}_.*\.sql$/.test(f)).sort();
  assert.equal(files.length,14,"Unexpected migration set; review harness against the new revision.");
  const migrations=[];
  for(const name of files){const sql=await fs.readFile(`${migrationDir}/${name}`,"utf8");await pool.query(sql);migrations.push({name,sha256:sha(sql)});}
  const version=(await pool.query("select version() value")).rows[0].value;
  console.log(JSON.stringify({candidate,scope:"DISPOSABLE_LOCAL_POSTGRESQL_NOT_APPROVED_TARGET",version,migrations}));
  await pool.query("insert into app_user_capabilities(user_id,capability,active,granted_by) values('synthetic-reviewer','LEGAL_COUNSEL_ATTEST',true,'synthetic-local-test-owner')");
  await check("successful receipt immutability and binary preservation",async()=>{
    const {doc,job}=await extracted();const before=JSON.stringify(job.output);
    await assert.rejects(()=>pool.query("update processing_jobs set output='{}' where id=$1",[job.id]),/immutable/);
    await assert.rejects(()=>pool.query("delete from processing_jobs where id=$1",[job.id]),/immutable/);
    assert.equal(JSON.stringify((await runtime.getJob(job.id)).output),before);
    assert.equal(sha(Buffer.from(boundary.blobs.get(doc.blob_pathname))),doc.sha256);
  });
  await check("blocked receipt survives retry reset and audit mutation attempts",async()=>{
    const doc=await document(await fixture({body:p(text("Unsupported drawing ")+"<w:r><w:drawing/></w:r>")})),queued=await enqueue(doc),job=await run(queued);
    assert.equal(job.status,"FAILED");
    const audit=(await pool.query("select * from audit_events where entity_id=$1 and action='DOCUMENT_EXTRACTION_BLOCKED'",[doc.id])).rows[0];
    assert.deepEqual(audit.metadata.blockedReceipt.docxEvidence,job.output.docxEvidence);
    const reset=await jobs.enqueueJob({matterId:doc.matter_id,documentId:doc.id,jobType:"EXTRACT",idempotencyKey:queued.idempotency_key,createdBy:"synthetic-worker"});
    assert.equal(reset.id,job.id);assert.equal(reset.status,"QUEUED");assert.deepEqual(reset.output,{});
    assert.equal((await pool.query("select count(*)::int n from document_chunks where document_id=$1",[doc.id])).rows[0].n,0);
    await assert.rejects(()=>pool.query("update audit_events set metadata='{}' where id=$1",[audit.id]),/append-only/);
    await assert.rejects(()=>pool.query("delete from audit_events where id=$1",[audit.id]),/append-only/);
    assert.deepEqual((await pool.query("select metadata from audit_events where id=$1",[audit.id])).rows[0].metadata,audit.metadata);
  });
  await check("interruption after chunks but before sealed receipt denies analysis",async()=>{
    const doc=await document();boundary.interruptComplete=true;
    await assert.rejects(async()=>run(await enqueue(doc)));
    const current=(await pool.query("select * from documents where id=$1",[doc.id])).rows[0];assert.equal(current.extraction_status,"EXTRACTED");
    const before=boundary.modelCalls;await assert.rejects(async()=>run(await enqueue(doc,"ANALYZE")));assert.equal(boundary.modelCalls,before);
    assert.equal((await pool.query("select count(*)::int n from analysis_runs where document_id=$1",[doc.id])).rows[0].n,0);
  });
  await check("competing extraction workers refuse stale publication",async()=>{
    const doc=await document(),a=await enqueue(doc),b=await enqueue(doc),pause=gate();let first=true;
    boundary.pauseBlob=async()=>{if(first){first=false;await pause.wait();}};
    const old=run(a);await pause.ready;const latest=await run(b);assert.equal(latest.status,"SUCCEEDED");pause.release();await assert.rejects(()=>old);boundary.pauseBlob=null;
    assert.equal((await pool.query("select extraction_job_id from documents where id=$1",[doc.id])).rows[0].extraction_job_id,b.id);
    assert.equal((await runtime.getJob(b.id)).status,"SUCCEEDED");
  });
  await check("stale execution lease refuses heartbeat and output publication",async()=>{
    const doc=await document(),job=await runtime.claimJob((await enqueue(doc)).id,"synthetic-old-worker");
    await pool.query("update processing_jobs set last_heartbeat_at=now()-interval '2 seconds',lease_expires_at=now()-interval '1 second' where id=$1",[job.id]);
    await assert.rejects(()=>jobs.heartbeatJob(job),e=>e instanceof jobs.JobLeaseLostError);
    await assert.rejects(()=>jobs.completeJob(job,{forged:true}),e=>e instanceof jobs.JobLeaseLostError);
    assert.equal((await runtime.getJob(job.id)).status,"RUNNING");
  });
  await check("re-extraction succeeds before terms and retains successful historical receipt",async()=>{
    const {doc,job}=await extracted(),old=JSON.stringify(job.output),next=await run(await enqueue(doc));assert.equal(next.status,"SUCCEEDED");assert.equal(JSON.stringify((await runtime.getJob(job.id)).output),old);
  });
  for(const reviewed of [false,true])await check(`safe re-extraction with ${reviewed?"human-reviewed":"unreviewed"} term retains source linkage`,async()=>{
    const {doc,job}=await extracted(),saved=await insertTerm(doc,reviewed);let failure;
    try{await run(await enqueue(doc));}catch(error){failure=error;}
    const term=(await pool.query("select * from contract_terms where id=$1",[saved.term.id])).rows[0],current=(await pool.query("select * from documents where id=$1",[doc.id])).rows[0];
    assert.equal(term.chunk_id,saved.chunk.id);assert.equal((await runtime.getJob(job.id)).status,"SUCCEEDED");
    if(failure)throw new Error(`RELEASE DEFECT: re-extraction failed with retained term; source state=${current.extraction_status}; historical review retained but current usable generation invalidated.`);
    assert.equal(current.extraction_status,"EXTRACTED");
  });
  await check("publication serialized with a concurrently started extraction",async()=>{
    const {doc}=await extracted(),analysisJob=await enqueue(doc,"ANALYZE");await run(analysisJob);await run(analysisJob);
    const pause=gate();boundary.pausePublication=async()=>{boundary.pausePublication=null;await pause.wait();};
    const final=run(analysisJob);await pause.ready;
    const next=await enqueue(doc),blobPause=gate();boundary.pauseBlob=()=>blobPause.wait();const extracting=run(next);await blobPause.ready;
    pause.release();await assert.rejects(()=>final);blobPause.release();await extracting;boundary.pauseBlob=null;
    assert.equal((await pool.query("select count(*)::int n from analysis_runs where document_id=$1 and status='SUCCEEDED'",[doc.id])).rows[0].n,0);
  });
  await check("real proposed quotation marks are accepted by database grounding",async()=>{
    const exact='Customer shall pay the "approved price" within 60 days.',doc=await document(await fixture({body:p(text(exact))}));await run(await enqueue(doc));
    await insertTerm(doc,false,exact);
  });
}finally{await pool.end();}
console.log(JSON.stringify({candidate,scope:"DISPOSABLE_LOCAL_POSTGRESQL_NOT_APPROVED_TARGET",results},null,2));
process.exitCode=results.some(r=>r.status!=="PASS")?1:0;
