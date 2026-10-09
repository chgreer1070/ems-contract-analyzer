import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import {pathToFileURL} from "node:url";
import {createHash,randomUUID} from "node:crypto";
import {execFileSync} from "node:child_process";
import {createTypeScriptLoader} from "../../../scripts/ts-test-loader.mjs";
import {fixture,p,text} from "../../../validation/docx/fixtures.mjs";

// Diagnostic only: an embedded WASM PostgreSQL engine with canonical SQL.
// No network, server connections, restricted runtime role or concurrency proof.
const location=process.env.DOCX_EMBEDDED_DIAGNOSTIC_PACKAGE;
if(!location||!path.isAbsolute(location))throw new Error("Provide an absolute scratch installation path for @electric-sql/pglite@0.4.1.");
const metadata=JSON.parse(await fs.readFile(path.join(location,"package.json"),"utf8"));
assert.equal(metadata.name,"@electric-sql/pglite");assert.equal(metadata.version,"0.4.1");
const {PGlite}=await import(pathToFileURL(path.join(location,"dist/index.js")));
const {pgcrypto}=await import(pathToFileURL(path.join(location,"dist/contrib/pgcrypto.js")));
const db=new PGlite({extensions:{pgcrypto}}),results=[];
const sha=value=>createHash("sha256").update(value).digest("hex");
const candidate=execFileSync("git",["rev-parse","HEAD"],{encoding:"utf8"}).trim();
const loader=createTypeScriptLoader(),{extractDocx}=loader("lib/docxExtraction.ts"),{createDocxReceipt}=loader("lib/docxReceipt.ts");
const adapt=result=>({...result,rowCount:result.affectedRows??result.rows.length});
const query=async(sql,values=[])=>adapt(await db.query(sql,values));
const dbAdapter={query,withTransaction:async fn=>db.transaction(tx=>fn({query:async(sql,values=[])=>adapt(await tx.query(sql,values))}))};
const jobs=createTypeScriptLoader({"@/lib/db":dbAdapter})("lib/jobs.ts");
const source=await fixture(),parsed=extractDocx(source),receipt=createDocxReceipt(parsed.evidence,parsed.chunks);
async function check(name,fn){try{const detail=await fn();results.push({name,status:"PASS",detail});console.log(`PASS ${name}`);}catch(error){results.push({name,status:"FAIL",code:error.code??null,message:error.message});console.log(`FAIL ${name}: ${error.message}`);}}
async function capturedFailure(fn){try{await fn();throw new Error("Expected database denial did not occur.");}catch(error){if(!error.code)throw error;return {code:error.code,message:error.message};}}
async function document(bytes=source){
  const customer=(await query("insert into customers(name) values('Synthetic embedded diagnostic') returning id")).rows[0];
  const matter=(await query("insert into matters(matter_number,customer_id,agreement_title,region,owner_user_id) values($1,$2,'Synthetic DOCX','LOCAL','synthetic-worker') returning id",[`EMBEDDED-${randomUUID()}`,customer.id])).rows[0];
  const hash=sha(Buffer.from(bytes));
  const doc=(await query("insert into documents(matter_id,filename,document_type,mime_type,size_bytes,blob_url,blob_pathname,sha256,server_sha256,integrity_status,security_scan_status,uploaded_by) values($1,'synthetic.docx','MSA','application/vnd.openxmlformats-officedocument.wordprocessingml.document',$2,'https://example.invalid/synthetic',$3,$4,$4,'SERVER_VERIFIED','CLEAN','synthetic-worker') returning *",[matter.id,bytes.byteLength,`embedded/${randomUUID()}.docx`,hash])).rows[0];
  const key=`embedded:${randomUUID()}`,job=(await query("insert into processing_jobs(matter_id,document_id,job_type,status,idempotency_key,created_by,locked_by,locked_at,lease_generation,last_heartbeat_at,lease_expires_at) values($1,$2,'EXTRACT','RUNNING',$3,'synthetic-worker','synthetic-worker',now(),1,now(),now()+interval '15 minutes') returning *",[doc.matter_id,doc.id,key])).rows[0];
  await query("update documents set extraction_job_id=$2 where id=$1",[doc.id,job.id]);
  const evidence=extractDocx(bytes);
  const chunks=[];
  for(const c of evidence.chunks)chunks.push((await query("insert into document_chunks(document_id,matter_id,chunk_index,content,content_sha256) values($1,$2,$3,$4,$5) returning *",[doc.id,doc.matter_id,c.chunkIndex,c.text,c.sha256])).rows[0]);
  const output=createDocxReceipt(evidence.evidence,evidence.chunks);
  await query("update documents set extraction_status=$2,extraction_method='DOCX_OOXML_EVIDENCE' where id=$1",[doc.id,evidence.evidence.analysisEligible?"EXTRACTED":"FAILED"]);
  await query("update processing_jobs set status=$2,output=$3,locked_by=null,locked_at=null,last_heartbeat_at=null,lease_expires_at=null,finished_at=now() where id=$1",[job.id,evidence.evidence.analysisEligible?"SUCCEEDED":"FAILED",JSON.stringify(output)]);
  return {doc,job,chunks,output,key};
}
async function term(source,reviewed=false,exact="Customer shall pay within 60 days of invoice."){
  const {doc,chunks}=source,chunk=chunks[0];
  const run=(await query("insert into analysis_runs(matter_id,document_id,run_type,status,model_name,prompt_version,schema_version,input_sha256,source_chunk_count,created_by) values($1,$2,'TERM_EXTRACTION','RUNNING','synthetic','synthetic.v1','synthetic.v1',$3,1,'synthetic-worker') returning id",[doc.matter_id,doc.id,sha(chunk.content_sha256)])).rows[0];
  const term=(await query("insert into contract_terms(matter_id,document_id,analysis_run_id,chunk_id,clause_family,term_type,exact_text,exact_text_sha256,normalized_statement,created_by) values($1,$2,$3,$4,'payment_terms','OBLIGATION',$5,$6,'Unapproved proposed text: synthetic','synthetic-worker') returning *",[doc.matter_id,doc.id,run.id,chunk.id,exact,sha(exact)])).rows[0];
  await query("update analysis_runs set status='SUCCEEDED',output_count=1,finished_at=now() where id=$1",[run.id]);
  if(reviewed)await query("update contract_terms set review_status='VALIDATED',reviewed_by='synthetic-reviewer',reviewed_at=now(),review_note='Synthetic embedded retention diagnostic only.' where id=$1",[term.id]);
  return term;
}
try{
  const migrations=[];
  for(const name of (await fs.readdir("db/migrations")).filter(f=>/^\d{3}_.*\.sql$/.test(f)).sort()){
    const sql=await fs.readFile(`db/migrations/${name}`,"utf8");await db.exec(sql);migrations.push({name,sha256:sha(sql)});
  }
  await query("insert into app_user_capabilities(user_id,capability,active,granted_by) values('synthetic-reviewer','LEGAL_COUNSEL_ATTEST',true,'synthetic-local-test-owner')");
  console.log(JSON.stringify({candidate,scope:"EMBEDDED_WASM_SQL_DIAGNOSTIC_NOT_SERVER_OR_TARGET_ACCEPTANCE",packageVersion:metadata.version,postgresqlVersion:(await query("select version() value")).rows[0].value,migrations,sourceSha256:receipt.docxEvidence.sourceSha256}));
  await check("successful receipt denies update/delete",async()=>{
    const s=await document(),update=await capturedFailure(()=>query("update processing_jobs set output='{}' where id=$1",[s.job.id])),deletion=await capturedFailure(()=>query("delete from processing_jobs where id=$1",[s.job.id]));
    assert.match(update.message,/immutable/);assert.match(deletion.message,/immutable/);return {update,deletion};
  });
  await check("blocked audit retains full receipt after actual enqueue reset",async()=>{
    const s=await document(await fixture({body:p(text("Unsupported ")+"<w:r><w:drawing/></w:r>")}));
    const audit=(await query("insert into audit_events(actor_user_id,actor_name,action,matter_id,entity_type,entity_id,metadata) values('synthetic-worker','Synthetic','DOCUMENT_EXTRACTION_BLOCKED',$1,'document',$2,$3) returning *",[s.doc.matter_id,s.doc.id,JSON.stringify({extractionJobId:s.job.id,blockedReceipt:s.output})])).rows[0];
    const reset=await jobs.enqueueJob({matterId:s.doc.matter_id,documentId:s.doc.id,jobType:"EXTRACT",idempotencyKey:s.key,createdBy:"synthetic-worker"});assert.equal(reset.status,"QUEUED");assert.deepEqual(reset.output,{});
    assert.deepEqual((await query("select metadata from audit_events where id=$1",[audit.id])).rows[0].metadata.blockedReceipt,s.output);
    const update=await capturedFailure(()=>query("update audit_events set metadata='{}' where id=$1",[audit.id])),deletion=await capturedFailure(()=>query("delete from audit_events where id=$1",[audit.id]));assert.match(update.message,/append-only/);assert.match(deletion.message,/append-only/);return {update,deletion};
  });
  for(const reviewed of [false,true])await check(`re-extraction chunk deletion diagnostic: ${reviewed?"reviewed":"unreviewed"} term`,async()=>{
    const s=await document(),t=await term(s,reviewed);await query("begin");
    const denied=await capturedFailure(()=>query("delete from document_chunks where document_id=$1",[s.doc.id]));await query("rollback");
    assert.match(denied.message,/RUNNING term-extraction run and source chunk/);
    assert.equal((await query("select chunk_id from contract_terms where id=$1",[t.id])).rows[0].chunk_id,s.chunks[0].id);
    return {releaseDefect:"DB-01",denied,historyRetained:true,safeReextractionProven:false};
  });
  await check("actual worker re-extraction leaves current generation unusable",async()=>{
    process.env.LEGAL_RELIANCE_ENABLED="false";process.env.JOB_LEASE_RECOVERY_ENABLED="false";process.env.BLOB_READ_WRITE_TOKEN="synthetic-local-boundary-only";
    const actualAnalysis=loader("lib/analysisEngine.ts"),actualTerms=loader("lib/termEngine.ts"),unexpected=()=>{throw new Error("Unexpected external operation.");};
    const worker=createTypeScriptLoader({
      "@/lib/db":dbAdapter,"@/lib/jobs-internal":{...jobs,pollAzureOcr:unexpected},
      "@vercel/blob":{get:async()=>({statusCode:200,stream:new Response(source).body})},
      "@/lib/analysisEngine":{...actualAnalysis,legalRelianceEnabled:false,analyzeContractText:unexpected},"@/lib/termEngine":{...actualTerms,extractTerms:unexpected},
      "@/lib/findings":{enrichFindings:unexpected},"@/lib/dependencyEngine":{inferDependencies:unexpected},"@/lib/precedenceEngine":{analyzePrecedence:unexpected},
      "@/lib/ocr":{azureOcrConfigured:()=>false,pollAzureOcr:unexpected,submitAzureOcr:unexpected},"@/lib/malwareScan":{scanBuffer:unexpected},
      "@/lib/readiness":{assertLegalRelianceReady:unexpected,legalRelianceEvidence:unexpected},"@/lib/safeErrors":{safeOperationalFailure:()=>({message:"Synthetic embedded processing failure."})}
    })("lib/jobProcessor.ts");
    const runtime=createTypeScriptLoader({"@/lib/db":dbAdapter})("lib/jobRuntime.ts");
    const s=await document(),t=await term(s,true),queued=await jobs.enqueueJob({matterId:s.doc.matter_id,documentId:s.doc.id,jobType:"EXTRACT",idempotencyKey:`embedded-reextract:${randomUUID()}`,createdBy:"synthetic-worker",maxAttempts:1});
    const claimed=await runtime.claimJob(queued.id,"synthetic-reextract-worker");assert.equal(claimed.status,"RUNNING");
    await assert.rejects(()=>worker.processJob(claimed));
    const current=(await query("select extraction_status,extraction_job_id from documents where id=$1",[s.doc.id])).rows[0],failed=await runtime.getJob(queued.id);
    assert.equal(current.extraction_status,"PENDING");assert.equal(current.extraction_job_id,queued.id);assert.equal(failed.status,"FAILED");
    assert.equal((await query("select status from processing_jobs where id=$1",[s.job.id])).rows[0].status,"SUCCEEDED");
    assert.equal((await query("select chunk_id from contract_terms where id=$1",[t.id])).rows[0].chunk_id,s.chunks[0].id);
    return {releaseDefect:"DB-01",current,jobStatus:failed.status,historicalReceiptStatus:"SUCCEEDED",reviewedChunkLinkRetained:true,externalBoundaries:"memory blob; model/OCR/readiness deny-only doubles"};
  });
  await check("quoted proposed text grounding diagnostic",async()=>{
    const exact='Customer shall pay the "approved price" within 60 days.',s=await document(await fixture({body:p(text(exact))}));
    const denied=await capturedFailure(()=>term(s,false,exact));assert.match(denied.message,/exact text must occur/);
    const views=JSON.parse(s.chunks[0].content.slice("CONTRACTTWIN_DOCX_EVIDENCE_V1\n".length));assert.equal(views.paragraph.proposedText,exact);
    return {releaseDefect:"DB-02",denied,actualProposedTextMatches:true};
  });
}finally{await db.close();}
console.log(JSON.stringify({candidate,scope:"EMBEDDED_WASM_SQL_DIAGNOSTIC_NOT_SERVER_OR_TARGET_ACCEPTANCE",results,serverConcurrency:"NOT_EXECUTED",restrictedRole:"NOT_EXECUTED",targetAcceptance:"NOT_EXECUTED"},null,2));
process.exitCode=results.some(r=>r.status!=="PASS")?1:0;
