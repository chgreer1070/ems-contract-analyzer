import assert from "node:assert/strict";
import { createTypeScriptLoader } from "./ts-test-loader.mjs";
import { fixture, p, text } from "../validation/docx/fixtures.mjs";

const real=createTypeScriptLoader(),{sha256}=real("lib/docxReceipt.ts"),analysis=real("lib/analysisEngine.ts");
// Storage is entirely doubled below. Never pass a real credential to the double.
process.env.BLOB_READ_WRITE_TOKEN="synthetic-never-sent";
const MIME="application/vnd.openxmlformats-officedocument.wordprocessingml.document",documentId="00000000-0000-4000-8000-000000000001",matterId="00000000-0000-4000-8000-000000000002",extractId="00000000-0000-4000-8000-000000000003";
let cases=0;
async function check(name,run){await run();cases++;console.log(`PASS ${name}`);}
const unexpected=()=>{throw new Error("Unexpected external processing or consequential action.");};

function harness(bytes){
  const hash=sha256(Buffer.from(bytes));
  const state={doc:{id:documentId,matter_id:matterId,filename:"synthetic.docx",document_type:"MSA",mime_type:MIME,blob_pathname:"synthetic/source.docx",sha256:hash,server_sha256:hash,integrity_status:"SERVER_VERIFIED",extraction_status:"PENDING",extraction_method:null,extraction_job_id:null,security_scan_status:"CLEAN",deletion_status:"ACTIVE"},chunks:[],receipt:null,sql:[],blockedAudit:null,status:null,output:null,retryable:null,modelCalls:0,run:null};
  const query=async(sql,values=[])=>{
    state.sql.push(sql);
    if(sql.includes("DOCUMENT_EXTRACTION_BLOCKED"))state.blockedAudit=JSON.parse(values[4]);
    if(sql.startsWith("select")&&sql.includes("from documents where id="))return {rows:[{...state.doc}]};
    if(sql.startsWith("select")&&sql.includes("from document_chunks"))return {rows:state.chunks.map(c=>({...c}))};
    if(sql.startsWith("select")&&sql.includes("from processing_jobs"))return {rows:state.receipt?[state.receipt]:[]};
    if(sql.startsWith("select")&&sql.includes("from analysis_runs where id="))return {rows:state.run?[state.run]:[]};
    if(sql.startsWith("update documents set extraction_job_id=")){state.doc.extraction_job_id=values[1];state.doc.extraction_status="PENDING";}
    if(sql.startsWith("update documents set extraction_status='FAILED'")){state.doc.extraction_status="FAILED";state.doc.extraction_method=values[1];}
    if(sql.startsWith("update documents set extraction_status='EXTRACTED'")){state.doc.extraction_status="EXTRACTED";state.doc.extraction_method=values[1];}
    if(sql.startsWith("delete from document_chunks"))state.chunks=[];
    if(sql.startsWith("insert into document_chunks"))state.chunks.push({id:`chunk-${values[3]}`,page_number:values[2],chunk_index:values[3],content:values[4],content_sha256:values[5]});
    if(sql.startsWith("insert into analysis_runs")){
      const isTerm=sql.includes("'TERM_EXTRACTION'");
      state.run={id:"run-1",matter_id:matterId,document_id:documentId,run_type:isTerm?"TERM_EXTRACTION":"CLAUSE_RISK",status:"RUNNING",input_sha256:values[isTerm?5:4],source_chunk_count:values[isTerm?6:5]};return {rows:[{id:"run-1"}],rowCount:1};
    }
    if(sql.startsWith("update analysis_runs set status='SUCCEEDED'"))state.run.status="SUCCEEDED";
    return {rows:[{id:documentId}],rowCount:1};
  };
  const publish=(job,value)=>{state.status=value.status;state.output=value.output??null;if(job.job_type==="EXTRACT")state.receipt={status:value.status,output:value.output};};
  const jobs={
    JobLeaseLostError:class extends Error{},assertJobLease:async()=>{},heartbeatJob:async()=>{},
    transitionJobWithFence:async(client,job,value)=>publish(job,value),completeJob:async(job,output)=>publish(job,{status:"SUCCEEDED",output}),continueJob:async(job,output)=>publish(job,{status:"WAITING_EXTERNAL",output}),
    failJob:async(job,error,retryable)=>{state.retryable=retryable;state.status="FAILED";return {message:error.message};},
    enqueueJobWithClient:unexpected,waitExternal:unexpected,pollAzureOcr:unexpected
  };
  const mocks={
    "@vercel/blob":{get:async()=>({statusCode:200,stream:new Response(bytes).body})},
    "@/lib/db":{query,withTransaction:async fn=>fn({query})},
    "@/lib/jobs-internal":jobs,
    "@/lib/analysisEngine":{...analysis,legalRelianceEnabled:false,analyzeContractText:async()=>{state.modelCalls++;return {findings:[],modelName:"synthetic-boundary-double",mode:"rules",rejectedUngroundedFindings:0};}},
    "@/lib/findings":{enrichFindings:async findings=>findings},
    "@/lib/dependencyEngine":{inferDependencies:unexpected},"@/lib/precedenceEngine":{analyzePrecedence:unexpected},
    "@/lib/termEngine":{extractTerms:unexpected},"@/lib/ocr":{azureOcrConfigured:()=>true,pollAzureOcr:unexpected,submitAzureOcr:unexpected},
    "@/lib/malwareScan":{scanBuffer:unexpected},"@/lib/readiness":{assertLegalRelianceReady:unexpected,legalRelianceEvidence:unexpected},
    "@/lib/safeErrors":{safeOperationalFailure:()=>({message:"Safe synthetic failure."})}
  };
  const {processJob}=createTypeScriptLoader(mocks)("lib/jobProcessor.ts");
  const job=type=>({id:type==="EXTRACT"?extractId:"00000000-0000-4000-8000-000000000004",job_type:type,document_id:documentId,matter_id:matterId,input:{requestedBy:"synthetic-user"},output:type==="EXTRACT"?{}:state.output,status:"RUNNING",locked_by:"synthetic-worker",lease_generation:1});
  return {state,processJob,job};
}

await check("worker stores a complete receipt and source mappings without rewriting original bytes",async()=>{
  const bytes=await fixture(),before=Buffer.from(bytes),h=harness(bytes);await h.processJob(h.job("EXTRACT"));
  assert.equal(h.state.status,"SUCCEEDED");assert.equal(h.state.doc.extraction_status,"EXTRACTED");assert.equal(h.state.chunks.length,1);assert.ok(h.state.receipt.output.docxEvidenceSha256);assert.equal(h.state.receipt.output.docxEvidence.legalEvidenceReady,false);
  assert.ok(Buffer.from(bytes).equals(before));assert.equal(h.state.modelCalls,0);assert.ok(h.state.sql.every(sql=>!sql.includes("executive_snapshots")&&!sql.includes("update decisions")));
});
await check("unsupported and empty DOCX publish a terminal blocked receipt, with no chunks or OCR",async()=>{
  for(const bytes of [await fixture({body:p(text("Clause ")+'<w:r><w:drawing/></w:r>')}),await fixture({body:""})]){
    const h=harness(bytes);await h.processJob(h.job("EXTRACT"));assert.equal(h.state.status,"FAILED");assert.equal(h.state.doc.extraction_status,"FAILED");assert.deepEqual(h.state.chunks,[]);assert.equal(h.state.receipt.output.docxEvidence.analysisEligible,false);assert.ok(h.state.sql.some(sql=>sql.includes("DOCUMENT_EXTRACTION_BLOCKED")));assert.deepEqual(h.state.blockedAudit.blockedReceipt.docxEvidence,h.state.receipt.output.docxEvidence);
  }
});
await check("legacy raw-text DOCX cannot reach clause or term analysis",async()=>{
  for(const type of ["ANALYZE","TERM_EXTRACT"]){
    const h=harness(await fixture());h.state.doc.extraction_status="EXTRACTED";h.state.doc.extraction_method="DOCX_RAW_TEXT";
    await assert.rejects(()=>h.processJob(h.job(type)),/Legacy DOCX/);assert.equal(h.state.modelCalls,0);assert.equal(h.state.retryable,false);assert.ok(!h.state.sql.some(sql=>sql.startsWith("insert into analysis_runs")));
  }
});
await check("missing, unfinished and tampered receipts stop model calls and publication",async()=>{
  for(const mutation of [h=>h.state.receipt=null,h=>h.state.receipt.status="RUNNING",h=>h.state.chunks[0].content+="tampered",h=>h.state.receipt.output.docxEvidenceSha256="0".repeat(64)]){
    const h=harness(await fixture());await h.processJob(h.job("EXTRACT"));mutation(h);
    await assert.rejects(()=>h.processJob(h.job("ANALYZE")),/DOCX source/);assert.equal(h.state.modelCalls,0);assert.equal(h.state.retryable,false);assert.ok(!h.state.sql.some(sql=>sql.startsWith("insert into analysis_runs")));
  }
  const late=harness(await fixture());await late.processJob(late.job("EXTRACT"));late.state.output={};
  await late.processJob(late.job("ANALYZE"));await late.processJob(late.job("ANALYZE"));
  late.state.receipt.status="RUNNING";
  await assert.rejects(()=>late.processJob(late.job("ANALYZE")));
  assert.equal(late.state.status,"FAILED");assert.equal(late.state.modelCalls,1);assert.ok(!late.state.sql.some(sql=>sql.startsWith("update analysis_runs set status='SUCCEEDED'")),"an unfinished new extraction generation must also block final publication");
});
await check("supported evidence can advance through clause analysis; resulting objects remain unapproved",async()=>{
  const h=harness(await fixture());await h.processJob(h.job("EXTRACT"));h.state.output={};
  await h.processJob(h.job("ANALYZE"));assert.equal(h.state.status,"WAITING_EXTERNAL");assert.equal(h.state.modelCalls,0);
  await h.processJob(h.job("ANALYZE"));assert.equal(h.state.modelCalls,1);assert.equal(h.state.status,"WAITING_EXTERNAL");
  await h.processJob(h.job("ANALYZE"));assert.equal(h.state.status,"SUCCEEDED");assert.equal(h.state.run.status,"SUCCEEDED");
  assert.ok(!h.state.sql.some(sql=>sql.includes("executive_snapshots")||sql.startsWith("update agreement_versions")||sql.startsWith("update decisions")));
});
await check("OCR cannot replace DOCX negotiation evidence, including a manually queued job",async()=>{
  const h=harness(await fixture());h.state.doc.extraction_job_id=extractId;
  const job=h.job("OCR");job.input.extractionJobId=extractId;
  await assert.rejects(()=>h.processJob(job),/DOCX cannot use flattening OCR/);assert.equal(h.state.retryable,false);
});
await check("actual term adapter rejects original-only quotes and enforces proposal labeling",async()=>{
  const {extractDocx}=real("lib/docxExtraction.ts"),source=extractDocx(await fixture()).chunks[0].text;
  const {extractTerms}=real("lib/termEngine.ts"),oldFetch=globalThis.fetch,oldKey=process.env.OPENAI_API_KEY;
  const candidate=exactText=>({clauseFamily:"payment_terms",sectionLabel:"",termType:"OBLIGATION",party:"Customer",counterparty:"Flex",exactText,normalizedStatement:"Payment is due.",triggerEvent:"invoice",exceptions:[],operationalOwner:"",confidence:1});
  try{
    process.env.OPENAI_API_KEY="synthetic-never-sent";
    globalThis.fetch=async()=>Response.json({output:[{content:[{type:"output_text",text:JSON.stringify({terms:[candidate("Customer shall pay within 30 days of invoice."),candidate("Customer shall pay within 60 days of invoice."),candidate("Synthetic Customer Counsel")]})}]}]});
    const result=await extractTerms(source);assert.equal(result.terms.length,1);assert.equal(result.rejectedUngrounded,2);assert.match(result.terms[0].normalizedStatement,/^Unapproved proposed text:/);
  }finally{globalThis.fetch=oldFetch;if(oldKey===undefined)delete process.env.OPENAI_API_KEY;else process.env.OPENAI_API_KEY=oldKey;}
});
await check("evidence route authorizes before reading, keeps receipt private and reports missing receipts",async()=>{
  const h=harness(await fixture());await h.processJob(h.job("EXTRACT"));let authorized=false,queries=0,deny=false;
  const GET=createTypeScriptLoader({
    "@/lib/access":{requireResourceMatterAccess:async()=>{if(deny)throw new Error("Denied");authorized=true;return {matterId};},accessErrorResponse:error=>error.message==="Denied"?Response.json({ok:false},{status:404}):null},
    "@/lib/db":{databaseConfigured:()=>true,query:async sql=>{assert.equal(authorized,true);queries++;return {rows:sql.includes("from documents")?[h.state.doc]:h.state.receipt?[{id:extractId,...h.state.receipt}]:[]};}},
    "@/lib/safeErrors":{internalErrorResponse:unexpected}
  })("app/api/documents/[id]/evidence/route.ts").GET;
  const request=new Request("https://synthetic.invalid/api/evidence"),context={params:Promise.resolve({id:documentId})};
  const response=await GET(request,context);assert.equal(response.status,200);assert.match(response.headers.get("cache-control"),/no-store/);assert.equal((await response.json()).receipt.docxEvidence.sourceSha256,h.state.doc.sha256);
  deny=true;authorized=false;queries=0;assert.equal((await GET(request,context)).status,404);assert.equal(queries,0);
  deny=false;h.state.doc.security_scan_status="QUARANTINED";assert.equal((await GET(request,context)).status,409);
  h.state.doc.security_scan_status="CLEAN";h.state.receipt=null;assert.equal((await GET(request,context)).status,409);
});
console.log(`DOCX pipeline checks passed: ${cases} executable synthetic scenarios with mocked database/storage/model boundaries. These are not live-environment acceptance.`);
