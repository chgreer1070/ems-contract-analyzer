import { createHash, randomUUID } from "node:crypto";
import { get } from "@vercel/blob";
import { analyzeContractText, legalRelianceEnabled, PROMPT_VERSION, sourceContainsExcerpt, type CoreFinding } from "@/lib/analysisEngine";
import { query, withTransaction } from "@/lib/db";
import { inferDependencies, DEPENDENCY_PROMPT_VERSION, DEPENDENCY_SCHEMA_VERSION } from "@/lib/dependencyEngine";
import { extractDocument } from "@/lib/documentExtraction";
import { enrichFindings, type EnrichedFinding } from "@/lib/findings";
import { assertJobLease, completeJob, continueJob, enqueueJobWithClient, failJob, heartbeatJob, JobLeaseLostError, pollAzureOcr, transitionJobWithFence, waitExternal, type ProcessingJob } from "@/lib/jobs-internal";
import { jobHeartbeatIntervalMillis } from "@/lib/jobLease";
import { azureOcrConfigured, pollAzureOcr as pollOcr, submitAzureOcr } from "@/lib/ocr";
import { analyzePrecedence, PRECEDENCE_PROMPT_VERSION, PRECEDENCE_SCHEMA_VERSION } from "@/lib/precedenceEngine";
import { exactTextHash, extractTerms, TERM_PROMPT_VERSION, TERM_SCHEMA_VERSION, type ExtractedTerm } from "@/lib/termEngine";
import { scanBuffer } from "@/lib/malwareScan";
import { canonicalStateHash, canonicalStateJson } from "@/lib/stateHash";
import { assertLegalRelianceReady, legalRelianceEvidence } from "@/lib/readiness";
import { AGREEMENT_GRAPH_VERSION } from "@/lib/pipelineVersions";
import { ECONOMICS_FORMULA_VERSION } from "@/lib/economics";
import { safeOperationalFailure } from "@/lib/safeErrors";

// This import shim is replaced below by direct exports from jobs.ts; kept isolated to make worker dependencies auditable.

class TerminalJobError extends Error {}
class ExternalOperationRejectedError extends Error {}

type BufferedFinding=EnrichedFinding&{sourceLocator:string;sourceChunkId?:string};
type BufferedTerm=ExtractedTerm&{chunkId:string};
type SourceChunk={id:string;page_number:number|null;chunk_index:number;content:string;content_sha256:string};
type SourceDocument={id:string;matter_id:string;filename:string;document_type:string;mime_type:string;blob_pathname:string;sha256:string|null;server_sha256:string|null;integrity_status:string;extraction_status:string;extraction_job_id:string|null;security_scan_status:string;deletion_status:string};

function bufferedFindings(value:unknown):BufferedFinding[]{return Array.isArray(value)?value as BufferedFinding[]:[];}
function bufferedTerms(value:unknown):BufferedTerm[]{return Array.isArray(value)?value as BufferedTerm[]:[];}
function recordValue(value:unknown):Record<string,unknown>{if(value&&typeof value==="object"&&!Array.isArray(value))return value as Record<string,unknown>;if(typeof value==="string")try{const parsed=JSON.parse(value);if(parsed&&typeof parsed==="object"&&!Array.isArray(parsed))return parsed;}catch{}return {};}
function requestedDocumentScope(job:ProcessingJob){const value=job.input?.sourceDocumentIds;if(value===undefined)return null;if(!Array.isArray(value))throw new TerminalJobError("Analysis document scope is invalid.");const ids=[...new Set(value.map(String))].sort();if(!ids.length||ids.some(id=>!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(id)))throw new TerminalJobError("Analysis document scope is invalid.");return ids;}
function requestedTermRunScope(job:ProcessingJob){const value=job.input?.sourceTermAnalysisRunIds;if(value===undefined)return null;if(!Array.isArray(value))throw new TerminalJobError("Term-analysis run scope is invalid.");const ids=[...new Set(value.map(String))].sort();if(!ids.length||ids.some(id=>!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(id)))throw new TerminalJobError("Term-analysis run scope is invalid.");return ids;}
function sameSortedIds(left:string[]|null,right:string[]){return Boolean(left&&left.length===right.length&&left.every((id,index)=>id===right[index]));}

function dedupeBufferedFindings(findings:BufferedFinding[]){
  const seen=new Set<string>();
  return findings.filter(f=>{const key=`${f.clauseFamily}|${f.issue.toLowerCase()}|${f.sourceExcerpt.replace(/\s+/g," ").trim().toLowerCase()}`;if(seen.has(key))return false;seen.add(key);return true;});
}

function dedupeBufferedTerms(terms:BufferedTerm[]){
  const seen=new Set<string>();
  return terms.filter(t=>{const key=`${t.clauseFamily}|${t.termType}|${exactTextHash(t.exactText)}`;if(seen.has(key))return false;seen.add(key);return true;});
}

function chunkInputHash(chunks:Array<Pick<SourceChunk,"content_sha256">>){
  return createHash("sha256").update(chunks.map(chunk=>chunk.content_sha256.toLowerCase()).join(":"),"utf8").digest("hex");
}

function assertProcessableSource(doc:SourceDocument,matterId:string){
  if(doc.matter_id!==matterId)throw new TerminalJobError("Processing job matter does not match the source document.");
  if(doc.deletion_status!=="ACTIVE")throw new TerminalJobError(`Source processing is blocked while deletion state is ${doc.deletion_status}.`);
  if(doc.security_scan_status!=="CLEAN")throw new TerminalJobError(`Source processing requires a CLEAN malware scan; current state is ${doc.security_scan_status}.`);
  if(doc.integrity_status!=="SERVER_VERIFIED"||!doc.sha256||!doc.server_sha256||doc.sha256.toLowerCase()!==doc.server_sha256.toLowerCase())throw new TerminalJobError("Source processing requires matching client and server SHA-256 evidence.");
  if(doc.extraction_status!=="EXTRACTED")throw new TerminalJobError(`Source processing requires EXTRACTED source text; current state is ${doc.extraction_status}.`);
}

async function loadDocument(documentId:string){
  const result=await query<SourceDocument>(
    "select id,matter_id,filename,document_type,mime_type,blob_pathname,sha256,server_sha256,integrity_status,extraction_status,extraction_job_id,security_scan_status,deletion_status from documents where id=$1 limit 1",[documentId]
  );
  if(!result.rows[0]) throw new Error("Document not found.");
  return result.rows[0];
}

async function processMalwareScan(job:ProcessingJob){
  if(!job.document_id)throw new Error("MALWARE_SCAN job requires document_id.");
  const doc=await loadDocument(job.document_id);
  if(job.matter_id&&doc.matter_id!==job.matter_id)throw new TerminalJobError("Malware-scan job matter does not match the source document.");
  if(doc.deletion_status!=="ACTIVE")throw new TerminalJobError(`Malware scanning is blocked while deletion state is ${doc.deletion_status}.`);
  if(doc.security_scan_status==="CLEAN"){await completeJob(job,{securityScanStatus:"CLEAN",alreadyScanned:true});return;}
  if(doc.security_scan_status==="QUARANTINED")throw new TerminalJobError("Source is quarantined after a malware detection and cannot be processed.");
  try{
    const bytes=Buffer.from(await loadBlobBytes(doc.blob_pathname));
    const serverSha=createHash("sha256").update(bytes).digest("hex");
    if(!doc.sha256||doc.sha256.toLowerCase()!==serverSha)throw new TerminalJobError("Source integrity verification failed before malware scanning.");
    const result=await scanBuffer(bytes);
    await withTransaction(async client=>{
      await assertJobLease(client,job);
      const current=(await client.query<SourceDocument>("select id,matter_id,filename,document_type,mime_type,blob_pathname,sha256,server_sha256,integrity_status,extraction_status,extraction_job_id,security_scan_status,deletion_status from documents where id=$1 for update",[doc.id])).rows[0];
      if(!current||current.deletion_status!=="ACTIVE"||current.blob_pathname!==doc.blob_pathname||!current.sha256||current.sha256.toLowerCase()!==serverSha)throw new TerminalJobError("Source identity changed while malware scanning; the scan result was not applied.");
      const status=result.clean?"CLEAN":"QUARANTINED";
      await client.query(`update documents set security_scan_status=$2,security_scanned_at=now(),security_scan_result=$3,server_sha256=$4,integrity_status='SERVER_VERIFIED',extraction_status=case when $2='QUARANTINED' then 'FAILED' else extraction_status end where id=$1`,[doc.id,status,result.clean?"Malware scan passed.":"Malware scanner reported a threat.",serverSha]);
      await client.query(`insert into audit_events(actor_user_id,actor_name,action,matter_id,entity_type,entity_id,metadata) values($1,$2,'DOCUMENT_SECURITY_SCANNED',$3,'document',$4,$5::jsonb)`,[String(job.input?.requestedBy||"system-worker"),String(job.input?.requestedByName||"ContractTwin Worker"),doc.matter_id,doc.id,JSON.stringify({status,threatDetected:!result.clean,scannerResponseRecorded:true})]);
      await transitionJobWithFence(client,job,{status:result.clean?"SUCCEEDED":"FAILED",output:{securityScanStatus:status},errorMessage:result.clean?null:"Malware scanner quarantined the source document."});
    });
  }catch(error){
    if(error instanceof JobLeaseLostError)throw error;
    const failure=safeOperationalFailure(error,"Malware scanning could not be completed.");
    await withTransaction(async client=>{
      await assertJobLease(client,job);
      const current=(await client.query<{security_scan_status:string;blob_pathname:string;sha256:string|null;deletion_status:string}>("select security_scan_status,blob_pathname,sha256,deletion_status from documents where id=$1 for update",[doc.id])).rows[0];
      if(!current||current.security_scan_status==="QUARANTINED"||current.deletion_status!=="ACTIVE"||current.blob_pathname!==doc.blob_pathname||current.sha256!==doc.sha256)return;
      await client.query("update documents set security_scan_status='FAILED',security_scanned_at=now(),security_scan_result=$2,extraction_status='FAILED' where id=$1",[doc.id,failure.message]);
      await client.query(`insert into audit_events(actor_user_id,actor_name,action,matter_id,entity_type,entity_id,metadata) values($1,$2,'DOCUMENT_SECURITY_SCANNED',$3,'document',$4,$5::jsonb)`,[String(job.input?.requestedBy||"system-worker"),String(job.input?.requestedByName||"ContractTwin Worker"),doc.matter_id,doc.id,JSON.stringify({status:"FAILED",threatDetected:false,scannerResponseRecorded:true})]);
    });
    throw error;
  }
}

async function loadBlobBytes(pathname:string){
  if(!process.env.BLOB_READ_WRITE_TOKEN) throw new Error("BLOB_READ_WRITE_TOKEN is not configured.");
  const blob=await get(pathname,{access:"private",token:process.env.BLOB_READ_WRITE_TOKEN});
  if(!blob||blob.statusCode!==200||!blob.stream) throw new Error("Source blob not found.");
  return new Response(blob.stream).arrayBuffer();
}

async function recordIntegrityFailure(doc:SourceDocument,job:ProcessingJob,observedSha256:string,stage:string,expectedExtractionJobId:string|null=null){
  await withTransaction(async client=>{
    await assertJobLease(client,job);
    const updated=await client.query("update documents set integrity_status='FAILED',extraction_status='FAILED' where id=$1 and matter_id=$2 and ($3::uuid is null or extraction_job_id=$3) returning id",[doc.id,doc.matter_id,expectedExtractionJobId]);
    if(!updated.rowCount)throw new TerminalJobError("A stale extraction generation cannot change the source integrity state.");
    await client.query(`insert into audit_events(actor_user_id,actor_name,action,matter_id,entity_type,entity_id,metadata) values($1,$2,'DOCUMENT_INTEGRITY_FAILED',$3,'document',$4,$5::jsonb)`,[String(job.input?.requestedBy||"system-worker"),String(job.input?.requestedByName||"ContractTwin Worker"),doc.matter_id,doc.id,JSON.stringify({expectedSha256:doc.sha256,observedSha256,stage})]);
  });
}

async function persistChunks(job:ProcessingJob,documentId:string,matterId:string,chunks:Array<{pageNumber:number|null;chunkIndex:number;text:string;sha256:string}>,method:string,pageCount:number|null,serverSha:string,expectedExtractionJobId:string,actor:{id:string;name:string}){
  await withTransaction(async client=>{
    await assertJobLease(client,job);
    const current=(await client.query<SourceDocument>("select id,matter_id,filename,document_type,mime_type,blob_pathname,sha256,server_sha256,integrity_status,extraction_status,extraction_job_id,security_scan_status,deletion_status from documents where id=$1 for update",[documentId])).rows[0];
    if(!current||current.matter_id!==matterId||current.extraction_job_id!==expectedExtractionJobId||current.deletion_status!=="ACTIVE"||current.security_scan_status!=="CLEAN"||!current.sha256||current.sha256.toLowerCase()!==serverSha.toLowerCase())throw new TerminalJobError("Source identity or extraction generation changed before extracted chunks could be published.");
    await client.query("delete from document_chunks where document_id=$1",[documentId]);
    for(const chunk of chunks) await client.query(
      `insert into document_chunks(document_id,matter_id,page_number,chunk_index,content,content_sha256) values($1,$2,$3,$4,$5,$6)`,
      [documentId,matterId,chunk.pageNumber,chunk.chunkIndex,chunk.text,chunk.sha256]
    );
    await client.query(`update documents set extraction_status='EXTRACTED',integrity_status='SERVER_VERIFIED',extraction_method=$2,page_count=$3,server_sha256=$4,extracted_at=now() where id=$1`,[documentId,method,pageCount,serverSha]);
    const action=method==="AZURE_DOCUMENT_INTELLIGENCE"?"DOCUMENT_OCR":"DOCUMENT_EXTRACTED";
    await client.query(`insert into audit_events(actor_user_id,actor_name,action,matter_id,entity_type,entity_id,metadata) values($1,$2,$3,$4,'document',$5,$6::jsonb)`,[actor.id,actor.name,action,matterId,documentId,JSON.stringify({method,pageCount,chunkCount:chunks.length,serverSha256:serverSha})]);
  });
}

function sourceLocator(finding:CoreFinding,chunks:Array<{id:string;page_number:number|null;chunk_index:number;content:string}>,filename:string){
  const chunk=chunks.find(c=>sourceContainsExcerpt(c.content,finding.sourceExcerpt));
  if(!chunk) return `${filename} · verified source excerpt`;
  return chunk.page_number?`${filename} · p. ${chunk.page_number}`:`${filename} · text chunk ${chunk.chunk_index+1}`;
}

async function processExtract(job:ProcessingJob){
  if(!job.document_id) throw new Error("EXTRACT job requires document_id.");
  const doc=await withTransaction(async client=>{
    await assertJobLease(client,job);
    if(job.job_type!=="EXTRACT")throw new TerminalJobError("Extraction generation is not an exact RUNNING EXTRACT job.");
    const current=(await client.query<SourceDocument>("select id,matter_id,filename,document_type,mime_type,blob_pathname,sha256,server_sha256,integrity_status,extraction_status,extraction_job_id,security_scan_status,deletion_status from documents where id=$1 for update",[job.document_id])).rows[0];
    if(!current)throw new TerminalJobError("Extraction source no longer exists.");
    if(job.matter_id&&current.matter_id!==job.matter_id)throw new TerminalJobError("Extraction job matter does not match the source document.");
    if(job.matter_id!==current.matter_id)throw new TerminalJobError("Extraction job matter lineage is invalid.");
    if(current.deletion_status!=="ACTIVE")throw new TerminalJobError(`Extraction is blocked while deletion state is ${current.deletion_status}.`);
    if(current.security_scan_status!=="CLEAN")throw new TerminalJobError(`Extraction requires a CLEAN malware scan; current state is ${current.security_scan_status}.`);
    await client.query("update documents set extraction_job_id=$2,extraction_status='PENDING' where id=$1",[current.id,job.id]);
    return {...current,extraction_job_id:job.id,extraction_status:"PENDING"};
  });
  const bytes=await loadBlobBytes(doc.blob_pathname);
  const serverSha=createHash("sha256").update(Buffer.from(bytes)).digest("hex");
  if(!doc.sha256||doc.sha256.toLowerCase()!==serverSha.toLowerCase()){
    await recordIntegrityFailure(doc,job,serverSha,"EXTRACT",job.id);
    throw new TerminalJobError("Source integrity verification failed.");
  }
  const extraction=await extractDocument(bytes,doc.mime_type);
  if(!extraction.chunks.length){
    const ocrJob=await withTransaction(async client=>{
      await assertJobLease(client,job);
      const current=(await client.query<SourceDocument>("select id,matter_id,filename,document_type,mime_type,blob_pathname,sha256,server_sha256,integrity_status,extraction_status,extraction_job_id,security_scan_status,deletion_status from documents where id=$1 for update",[doc.id])).rows[0];
      if(!current||current.extraction_job_id!==job.id||current.deletion_status!=="ACTIVE"||current.security_scan_status!=="CLEAN"||!current.sha256||current.sha256.toLowerCase()!==serverSha)throw new TerminalJobError("Source identity or extraction generation changed before OCR handoff.");
      await client.query("update documents set integrity_status='SERVER_VERIFIED',server_sha256=$2,extraction_status='OCR_REQUIRED',extraction_method=$3,page_count=$4 where id=$1",[doc.id,serverSha,extraction.method,extraction.pageCount]);
      await client.query(`insert into audit_events(actor_user_id,actor_name,action,matter_id,entity_type,entity_id,metadata) values($1,$2,'DOCUMENT_OCR_REQUIRED',$3,'document',$4,$5::jsonb)`,[String(job.input?.requestedBy||"system-worker"),String(job.input?.requestedByName||"ContractTwin Worker"),doc.matter_id,doc.id,JSON.stringify({method:extraction.method,pageCount:extraction.pageCount,serverSha256:serverSha})]);
      if(!azureOcrConfigured())return null;
      const child=await enqueueJobWithClient(client,{matterId:doc.matter_id,documentId:doc.id,jobType:"OCR",idempotencyKey:`ocr:${job.id}:${serverSha}`,createdBy:String(job.input?.requestedBy||"system-worker"),input:{...job.input,extractionJobId:job.id},maxAttempts:3});
      await transitionJobWithFence(client,job,{status:"SUCCEEDED",output:{delegatedTo:"OCR",ocrJobId:child.id,serverSha256:serverSha,warnings:extraction.warnings}});
      return child;
    });
    if(!ocrJob)throw new Error("Document requires OCR and Azure Document Intelligence is not configured.");
    return;
  }
  await persistChunks(job,doc.id,doc.matter_id,extraction.chunks,extraction.method,extraction.pageCount,serverSha,job.id,{id:String(job.input?.requestedBy||"system-worker"),name:String(job.input?.requestedByName||"ContractTwin Worker")});
  await completeJob(job,{chunkCount:extraction.chunks.length,pageCount:extraction.pageCount,method:extraction.method,serverSha256:serverSha,warnings:extraction.warnings});
}

async function processOcr(job:ProcessingJob){
  if(!job.document_id) throw new Error("OCR job requires document_id.");
  const extractionJobId=String(job.input?.extractionJobId||"");
  if(!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(extractionJobId))throw new TerminalJobError("OCR job is missing its exact extraction-generation binding.");
  const doc=await loadDocument(job.document_id);
  if(job.matter_id&&doc.matter_id!==job.matter_id)throw new TerminalJobError("OCR job matter does not match the source document.");
  if(doc.deletion_status!=="ACTIVE"||doc.security_scan_status!=="CLEAN")throw new Error("OCR requires an active source with a CLEAN malware scan.");
  if(doc.extraction_job_id!==extractionJobId)throw new TerminalJobError("OCR output belongs to a stale extraction generation.");
  if(!job.external_operation_url){
    const bytes=await loadBlobBytes(doc.blob_pathname);
    const serverSha=createHash("sha256").update(Buffer.from(bytes)).digest("hex");
    if(!doc.sha256||doc.sha256.toLowerCase()!==serverSha.toLowerCase()){await recordIntegrityFailure(doc,job,serverSha,"OCR_SUBMIT",extractionJobId);throw new TerminalJobError("Source integrity verification failed before OCR.");}
    const operation=await submitAzureOcr(bytes);
    await waitExternal(job,operation,{serverSha256:serverSha},5);return;
  }
  const result=await pollOcr(job.external_operation_url);
  if(result.status==="running"){await waitExternal(job,job.external_operation_url,job.output??{},5);return;}
  if(result.status==="failed") throw new ExternalOperationRejectedError(result.error);
  const expectedSha=String(job.output?.serverSha256||"");
  if(!/^[0-9a-f]{64}$/i.test(expectedSha))throw new TerminalJobError("OCR job lost its source-integrity fingerprint.");
  const currentBytes=Buffer.from(await loadBlobBytes(doc.blob_pathname));
  const currentSha=createHash("sha256").update(currentBytes).digest("hex");
  if(currentSha.toLowerCase()!==expectedSha.toLowerCase()){await recordIntegrityFailure(doc,job,currentSha,"OCR_PUBLISH",extractionJobId);throw new TerminalJobError("Source blob changed while OCR was pending; OCR output was not published.");}
  await persistChunks(job,doc.id,doc.matter_id,result.chunks,"AZURE_DOCUMENT_INTELLIGENCE",result.pageCount,currentSha,extractionJobId,{id:String(job.input?.requestedBy||"system-worker"),name:String(job.input?.requestedByName||"ContractTwin Worker")});
  await completeJob(job,{pageCount:result.pageCount,chunkCount:result.chunks.length,method:"AZURE_DOCUMENT_INTELLIGENCE"});
}

async function processAnalysis(job:ProcessingJob){
  if(!job.document_id||!job.matter_id) throw new Error("ANALYZE job requires document and matter.");
  const doc=await loadDocument(job.document_id);
  assertProcessableSource(doc,job.matter_id);
  const chunks=(await query<SourceChunk>("select id,page_number,chunk_index,content,content_sha256 from document_chunks where document_id=$1 order by coalesce(page_number,0),chunk_index,id",[doc.id])).rows;
  if(!chunks.length) throw new Error("No extracted source chunks are available.");
  const state={next:Number(job.output?.nextChunk??0),rejected:Number(job.output?.rejected??0),analysisRunId:String(job.output?.analysisRunId||""),findings:bufferedFindings(job.output?.findings),models:Array.isArray(job.output?.models)?job.output.models.map(String):[] as string[],modes:Array.isArray(job.output?.modes)?job.output.modes.map(String):[] as string[],warnings:Array.isArray(job.output?.warnings)?job.output.warnings.map(String):[] as string[]};
  if(!Number.isInteger(state.next)||state.next<0||!Number.isInteger(state.rejected)||state.rejected<0)throw new TerminalJobError("Clause-risk continuation state is invalid.");
  let runId=state.analysisRunId;
  if(!runId){
    const inputHash=chunkInputHash(chunks);
    runId=await withTransaction(async client=>{
      await assertJobLease(client,job);
      const r=await client.query<{id:string}>(`insert into analysis_runs(matter_id,document_id,run_type,status,model_name,prompt_version,schema_version,input_sha256,source_chunk_count,created_by) values($1,$2,'CLAUSE_RISK','RUNNING',$3,$4,'clause-risk.v2',$5,$6,$7) returning id`,[job.matter_id,job.document_id,process.env.OPENAI_MODEL||"gpt-5.6",PROMPT_VERSION,inputHash,chunks.length,String(job.input?.requestedBy||"system-worker")]);
      const output={nextChunk:0,rejected:0,analysisRunId:r.rows[0].id,findings:[],models:[],modes:[],warnings:[]};
      await transitionJobWithFence(client,job,{status:"WAITING_EXTERNAL",output,delaySeconds:0});
      return r.rows[0].id;
    });
    return;
  }
  const run=(await query<{matter_id:string;document_id:string|null;run_type:string;status:string;input_sha256:string;source_chunk_count:number}>("select matter_id,document_id,run_type,status,input_sha256,source_chunk_count from analysis_runs where id=$1",[runId])).rows[0];
  const currentHash=chunkInputHash(chunks);
  if(!run||run.matter_id!==job.matter_id||run.document_id!==doc.id||run.run_type!=="CLAUSE_RISK"||run.status!=="RUNNING"||run.input_sha256.toLowerCase()!==currentHash||Number(run.source_chunk_count)!==chunks.length)throw new TerminalJobError("Clause-risk run is no longer bound to the current extracted source state.");
  if(state.next>=chunks.length){
    const grounded=state.findings.filter(finding=>finding.sourceChunkId?chunks.some(chunk=>chunk.id===finding.sourceChunkId&&sourceContainsExcerpt(chunk.content,finding.sourceExcerpt)):chunks.some(chunk=>sourceContainsExcerpt(chunk.content,finding.sourceExcerpt)));
    const rejected=state.rejected+(state.findings.length-grounded.length);
    if(legalRelianceEnabled&&rejected>0)throw new TerminalJobError("Legal-reliance analysis rejected ungrounded output; no findings were published.");
    const ready=dedupeBufferedFindings(grounded);
    await withTransaction(async client=>{
      await assertJobLease(client,job);
      const currentDoc=(await client.query<SourceDocument>("select id,matter_id,filename,document_type,mime_type,blob_pathname,sha256,server_sha256,integrity_status,extraction_status,extraction_job_id,security_scan_status,deletion_status from documents where id=$1 for update",[doc.id])).rows[0];
      if(!currentDoc)throw new TerminalJobError("Source document disappeared before clause-risk publication.");
      assertProcessableSource(currentDoc,job.matter_id!);
      const currentChunks=(await client.query<SourceChunk>("select id,page_number,chunk_index,content,content_sha256 from document_chunks where document_id=$1 order by coalesce(page_number,0),chunk_index,id",[doc.id])).rows;
      const currentRun=(await client.query<{status:string;input_sha256:string;source_chunk_count:number}>("select status,input_sha256,source_chunk_count from analysis_runs where id=$1 and matter_id=$2 and document_id=$3 and run_type='CLAUSE_RISK' for update",[runId,job.matter_id,doc.id])).rows[0];
      if(!currentRun||currentRun.status!=="RUNNING"||currentRun.input_sha256.toLowerCase()!==chunkInputHash(currentChunks)||Number(currentRun.source_chunk_count)!==currentChunks.length)throw new TerminalJobError("Extracted source changed before clause-risk publication.");
      if(ready.some(finding=>finding.sourceChunkId?!currentChunks.some(chunk=>chunk.id===finding.sourceChunkId&&sourceContainsExcerpt(chunk.content,finding.sourceExcerpt)):!currentChunks.some(chunk=>sourceContainsExcerpt(chunk.content,finding.sourceExcerpt))))throw new TerminalJobError("Buffered clause-risk evidence no longer exists in the current source chunks.");
      await client.query("update findings set review_status='SUPERSEDED' where document_id=$1 and review_status='UNREVIEWED'",[doc.id]);
      for(const finding of ready)await client.query(`insert into findings(matter_id,document_id,analysis_run_id,clause_family,issue,risk_level,rationale,operational_consequence,source_excerpt,source_locator,primary_position,fallback_position,no_go_position,approval_required,financial_variables,uncertainty,review_status,model_name,prompt_version,standard_status,standard_version,created_by) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb,$16,'UNREVIEWED',$17,$18,$19,$20,$21)`,[job.matter_id,job.document_id,runId,finding.clauseFamily,finding.issue,finding.risk,finding.rationale,finding.operationalConsequence,finding.sourceExcerpt,finding.sourceLocator,finding.primaryPosition,finding.fallback,finding.noGo,finding.approval,JSON.stringify(finding.financialVariables),finding.uncertainty,state.models.join(",")||"unknown",PROMPT_VERSION,finding.standardStatus,finding.standardVersion,String(job.input?.requestedBy||"system-worker")]);
      await client.query("update analysis_runs set status='SUCCEEDED',model_name=$2,output_count=$3,rejected_ungrounded_count=$4,metrics=$5::jsonb,finished_at=now() where id=$1",[runId,state.models.join(",")||"unknown",ready.length,rejected,JSON.stringify({modes:[...new Set(state.modes)],warnings:[...new Set(state.warnings)]})]);
      await transitionJobWithFence(client,job,{status:"SUCCEEDED",output:{analysisRunId:runId,findingCount:ready.length,rejected,modes:[...new Set(state.modes)],warnings:[...new Set(state.warnings)]}});
      await client.query(`insert into audit_events(actor_user_id,actor_name,action,matter_id,entity_type,entity_id,metadata) values($1,$2,'ANALYSIS_RUN',$3,'analysis_run',$4,$5::jsonb)`,[String(job.input?.requestedBy||"system-worker"),String(job.input?.requestedByName||"ContractTwin Worker"),job.matter_id,runId,JSON.stringify({documentId:job.document_id,promptVersion:PROMPT_VERSION,outputCount:ready.length,rejectedUngrounded:rejected})]);
    });return;
  }
  const chunk=chunks[state.next];const result=await analyzeContractText(chunk.content);const enriched=await enrichFindings(result.findings,false);
  const located:BufferedFinding[]=enriched.map(f=>({...f,sourceLocator:sourceLocator(f,[chunk],doc.filename),sourceChunkId:chunk.id}));
  const output={nextChunk:state.next+1,rejected:state.rejected+result.rejectedUngroundedFindings,analysisRunId:runId,findings:dedupeBufferedFindings([...state.findings,...located]),models:[...new Set([...state.models,result.modelName])],modes:[...new Set([...state.modes,result.mode])],warnings:[...new Set([...state.warnings,...(result.warning?[result.warning]:[])])]};
  await continueJob(job,output,output.nextChunk>=chunks.length?0:1);
}

async function processTerms(job:ProcessingJob){
  if(!job.document_id||!job.matter_id) throw new Error("TERM_EXTRACT job requires document and matter.");
  const doc=await loadDocument(job.document_id);
  assertProcessableSource(doc,job.matter_id);
  const chunks=(await query<SourceChunk>("select id,page_number,chunk_index,content,content_sha256 from document_chunks where document_id=$1 order by coalesce(page_number,0),chunk_index,id",[job.document_id])).rows;
  if(!chunks.length) throw new Error("No extracted source chunks are available.");
  const state={next:Number(job.output?.nextChunk??0),rejected:Number(job.output?.rejected??0),analysisRunId:String(job.output?.analysisRunId||""),terms:bufferedTerms(job.output?.terms),models:Array.isArray(job.output?.models)?job.output.models.map(String):[] as string[]};let runId=state.analysisRunId;
  if(!Number.isInteger(state.next)||state.next<0||!Number.isInteger(state.rejected)||state.rejected<0)throw new TerminalJobError("Term-extraction continuation state is invalid.");
  if(!runId){
    const hash=chunkInputHash(chunks);
    runId=await withTransaction(async client=>{
      await assertJobLease(client,job);
      const r=await client.query<{id:string}>(`insert into analysis_runs(matter_id,document_id,run_type,status,model_name,prompt_version,schema_version,input_sha256,source_chunk_count,created_by) values($1,$2,'TERM_EXTRACTION','RUNNING',$3,$4,$5,$6,$7,$8) returning id`,[job.matter_id,job.document_id,process.env.OPENAI_MODEL||"gpt-5.6",TERM_PROMPT_VERSION,TERM_SCHEMA_VERSION,hash,chunks.length,String(job.input?.requestedBy||"system-worker")]);
      const output={nextChunk:0,rejected:0,analysisRunId:r.rows[0].id,terms:[],models:[]};
      await transitionJobWithFence(client,job,{status:"WAITING_EXTERNAL",output,delaySeconds:0});
      return r.rows[0].id;
    });
    return;
  }
  const run=(await query<{matter_id:string;document_id:string|null;run_type:string;status:string;input_sha256:string;source_chunk_count:number}>("select matter_id,document_id,run_type,status,input_sha256,source_chunk_count from analysis_runs where id=$1",[runId])).rows[0];
  if(!run||run.matter_id!==job.matter_id||run.document_id!==doc.id||run.run_type!=="TERM_EXTRACTION"||run.status!=="RUNNING"||run.input_sha256.toLowerCase()!==chunkInputHash(chunks)||Number(run.source_chunk_count)!==chunks.length)throw new TerminalJobError("Term-extraction run is no longer bound to the current extracted source state.");
  if(state.next>=chunks.length){
    const grounded=state.terms.filter(term=>chunks.some(chunk=>chunk.id===term.chunkId&&sourceContainsExcerpt(chunk.content,term.exactText)));
    const rejected=state.rejected+(state.terms.length-grounded.length);
    if(legalRelianceEnabled&&rejected>0)throw new TerminalJobError("Legal-reliance term extraction rejected ungrounded output; no terms were published.");
    const ready=dedupeBufferedTerms(grounded);let inserted=0;
    await withTransaction(async client=>{
      await assertJobLease(client,job);
      const currentDoc=(await client.query<SourceDocument>("select id,matter_id,filename,document_type,mime_type,blob_pathname,sha256,server_sha256,integrity_status,extraction_status,extraction_job_id,security_scan_status,deletion_status from documents where id=$1 for update",[job.document_id])).rows[0];
      if(!currentDoc)throw new TerminalJobError("Source document disappeared before term publication.");
      assertProcessableSource(currentDoc,job.matter_id!);
      const currentChunks=(await client.query<SourceChunk>("select id,page_number,chunk_index,content,content_sha256 from document_chunks where document_id=$1 order by coalesce(page_number,0),chunk_index,id",[job.document_id])).rows;
      const currentRun=(await client.query<{status:string;input_sha256:string;source_chunk_count:number}>("select status,input_sha256,source_chunk_count from analysis_runs where id=$1 and matter_id=$2 and document_id=$3 and run_type='TERM_EXTRACTION' for update",[runId,job.matter_id,job.document_id])).rows[0];
      if(!currentRun||currentRun.status!=="RUNNING"||currentRun.input_sha256.toLowerCase()!==chunkInputHash(currentChunks)||Number(currentRun.source_chunk_count)!==currentChunks.length)throw new TerminalJobError("Extracted source changed before term publication.");
      if(ready.some(term=>!currentChunks.some(chunk=>chunk.id===term.chunkId&&sourceContainsExcerpt(chunk.content,term.exactText))))throw new TerminalJobError("Buffered term evidence no longer exists in the current source chunks.");
      await client.query("update contract_terms set review_status='SUPERSEDED' where document_id=$1 and review_status='UNREVIEWED'",[job.document_id]);
      for(const term of ready){const result=await client.query(`insert into contract_terms(matter_id,document_id,analysis_run_id,chunk_id,clause_family,section_label,term_type,party,counterparty,exact_text,exact_text_sha256,normalized_statement,trigger_event,exceptions,operational_owner,confidence,model_name,prompt_version,created_by) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15,$16,$17,$18,$19)`,[job.matter_id,job.document_id,runId,term.chunkId,term.clauseFamily,term.sectionLabel||null,term.termType,term.party||null,term.counterparty||null,term.exactText,exactTextHash(term.exactText),term.normalizedStatement,term.triggerEvent||null,JSON.stringify(term.exceptions),term.operationalOwner||null,term.confidence,state.models.join(",")||"unknown",TERM_PROMPT_VERSION,String(job.input?.requestedBy||"system-worker")]);inserted+=result.rowCount||0;}
      await client.query("update analysis_runs set status='SUCCEEDED',model_name=$2,output_count=$3,rejected_ungrounded_count=$4,finished_at=now() where id=$1",[runId,state.models.join(",")||"unknown",inserted,rejected]);
      const dependency=await enqueueJobWithClient(client,{matterId:job.matter_id,jobType:"DEPENDENCY",idempotencyKey:`dependency:${job.matter_id}:${runId}`,createdBy:String(job.input?.requestedBy||"system-worker"),input:{...job.input,termAnalysisRunId:runId}});
      await transitionJobWithFence(client,job,{status:"SUCCEEDED",output:{analysisRunId:runId,termCount:inserted,rejected,dependencyJobId:dependency.id}});
      await client.query(`insert into audit_events(actor_user_id,actor_name,action,matter_id,entity_type,entity_id,metadata) values($1,$2,'ANALYSIS_RUN',$3,'analysis_run',$4,$5::jsonb)`,[String(job.input?.requestedBy||"system-worker"),String(job.input?.requestedByName||"ContractTwin Worker"),job.matter_id,runId,JSON.stringify({documentId:job.document_id,promptVersion:TERM_PROMPT_VERSION,outputCount:inserted,rejectedUngrounded:rejected,dependencyJobId:dependency.id})]);
    });return;
  }
  const chunk=chunks[state.next];const result=await extractTerms(chunk.content);
  const output={nextChunk:state.next+1,rejected:state.rejected+result.rejectedUngrounded,analysisRunId:runId,terms:dedupeBufferedTerms([...state.terms,...result.terms.map(term=>({...term,chunkId:chunk.id}))]),models:[...new Set([...state.models,result.modelName])]};
  await continueJob(job,output,output.nextChunk>=chunks.length?0:1);
}

async function processDependencies(job:ProcessingJob){
  if(!job.matter_id) throw new Error("DEPENDENCY job requires matter.");
  const requestedScope=requestedDocumentScope(job);
  const requestedRunIds=requestedTermRunScope(job);
  const agreementVersionId=String(job.input?.agreementVersionId||"");
  if(agreementVersionId&&(!requestedScope||!requestedRunIds))throw new TerminalJobError("Agreement-version dependency analysis requires exact document and term-run scopes.");
  const triggerRunId=String(job.input?.termAnalysisRunId||"");
  if(!/^[0-9a-f-]{36}$/i.test(triggerRunId))throw new TerminalJobError("Dependency job is missing its exact term-analysis run binding.");
  const sourceRuns=(await query<{id:string;document_id:string;status:string;input_sha256:string;source_chunk_count:number}>(`select distinct on(ar.document_id) ar.id,ar.document_id,ar.status,ar.input_sha256,ar.source_chunk_count from analysis_runs ar where ar.matter_id=$1 and ar.run_type='TERM_EXTRACTION' and ($2::uuid[] is null or ar.document_id=any($2::uuid[])) order by ar.document_id,ar.started_at desc,ar.id desc`,[job.matter_id,requestedScope])).rows;
  if(!sourceRuns.some(run=>run.id===triggerRunId)||sourceRuns.some(run=>run.status!=="SUCCEEDED")||(requestedScope&&sourceRuns.length!==requestedScope.length))throw new TerminalJobError("Dependency job term-analysis scope is stale, incomplete, superseded by a newer run, or unsuccessful.");
  const sourceDocumentIds=sourceRuns.map(run=>run.document_id).sort();const sourceRunIds=sourceRuns.map(run=>run.id).sort();
  if(requestedRunIds&&!sameSortedIds(requestedRunIds,sourceRunIds))throw new TerminalJobError("Dependency job term-analysis run scope is stale or was substituted.");
  for(const run of sourceRuns){
    const chunks=(await query<Pick<SourceChunk,"content_sha256">>("select content_sha256 from document_chunks where document_id=$1 order by coalesce(page_number,0),chunk_index,id",[run.document_id])).rows;
    if(!chunks.length||chunks.length!==Number(run.source_chunk_count)||chunkInputHash(chunks)!==String(run.input_sha256).toLowerCase())throw new TerminalJobError("Dependency analysis requires term runs bound to each document's current extracted chunks.");
  }
  const terms=(await query<{id:string;analysis_run_id:string;clause_family:string;term_type:string;normalized_statement:string;trigger_event:string|null}>(`select t.id,t.analysis_run_id,t.clause_family,t.term_type,t.normalized_statement,t.trigger_event from contract_terms t where t.matter_id=$1 and t.document_id=any($2::uuid[]) and t.analysis_run_id=any($3::uuid[]) and t.review_status<>'SUPERSEDED' order by t.created_at,t.id limit 251`,[job.matter_id,sourceDocumentIds,sourceRunIds])).rows;
  if(terms.length>250)throw new TerminalJobError("Dependency analysis exceeds the governed 250-term limit; partitioning or counsel direction is required.");
  const dependencyState={sourceDocumentIds,sourceRunIds,terms};const inputHash=canonicalStateHash(dependencyState);
  const dependencyResult=terms.length<2?{dependencies:[],rawCount:0,invalidCount:0,duplicateCount:0,rejectedCount:0}:await inferDependencies(terms.map(t=>({id:t.id,clauseFamily:t.clause_family,termType:t.term_type,normalizedStatement:t.normalized_statement,triggerEvent:t.trigger_event})));
  if(legalRelianceEnabled&&dependencyResult.rejectedCount)throw new TerminalJobError("Legal-reliance dependency analysis rejected invalid model edges; no dependency receipt was published.");
  const deps=dependencyResult.dependencies;
  const objectIds:string[]=[];
  await withTransaction(async client=>{
    await assertJobLease(client,job);
    await client.query("select id from matters where id=$1 for update",[job.matter_id]);
    const currentRuns=(await client.query<{id:string;document_id:string;status:string;input_sha256:string;source_chunk_count:number}>(`select distinct on(ar.document_id) ar.id,ar.document_id,ar.status,ar.input_sha256,ar.source_chunk_count from analysis_runs ar where ar.matter_id=$1 and ar.run_type='TERM_EXTRACTION' and ar.document_id=any($2::uuid[]) order by ar.document_id,ar.started_at desc,ar.id desc`,[job.matter_id,sourceDocumentIds])).rows;
    const currentRunIds=currentRuns.map(run=>run.id).sort();const currentTerms=(await client.query<{id:string;analysis_run_id:string;clause_family:string;term_type:string;normalized_statement:string;trigger_event:string|null}>(`select t.id,t.analysis_run_id,t.clause_family,t.term_type,t.normalized_statement,t.trigger_event from contract_terms t where t.matter_id=$1 and t.document_id=any($2::uuid[]) and t.analysis_run_id=any($3::uuid[]) and t.review_status<>'SUPERSEDED' order by t.created_at,t.id limit 251`,[job.matter_id,sourceDocumentIds,currentRunIds])).rows;
    if(currentRuns.some(run=>run.status!=="SUCCEEDED")||!sameSortedIds(currentRunIds,sourceRunIds))throw new TerminalJobError("A newer or unsuccessful term run replaced the dependency input while analysis was running.");
    for(const run of currentRuns){const chunks=(await client.query<Pick<SourceChunk,"content_sha256">>("select content_sha256 from document_chunks where document_id=$1 order by coalesce(page_number,0),chunk_index,id",[run.document_id])).rows;if(!chunks.length||chunks.length!==Number(run.source_chunk_count)||chunkInputHash(chunks)!==String(run.input_sha256).toLowerCase())throw new TerminalJobError("Extracted chunks changed while dependency analysis was running.");}
    if(currentTerms.length>250||canonicalStateHash({sourceDocumentIds,sourceRunIds:currentRunIds,terms:currentTerms})!==inputHash)throw new TerminalJobError("Current term state changed while dependency analysis was running.");
    await client.query(`update term_dependencies td set review_status='SUPERSEDED' where td.matter_id=$1 and td.review_status='UNREVIEWED' and exists(select 1 from contract_terms s where s.id=td.source_term_id and s.document_id=any($2::uuid[])) and exists(select 1 from contract_terms t where t.id=td.target_term_id and t.document_id=any($2::uuid[]))`,[job.matter_id,sourceDocumentIds]);
    for(const d of deps){const result=await client.query<{id:string}>(`insert into term_dependencies(matter_id,processing_job_id,origin,source_term_id,target_term_id,dependency_type,rationale,confidence,created_by) values($1,$2,'MODEL',$3,$4,$5,$6,$7,$8) on conflict do nothing returning id`,[job.matter_id,job.id,d.sourceTermId,d.targetTermId,d.dependencyType,d.rationale,d.confidence,String(job.input?.requestedBy||"system-worker")]);if(result.rows[0])objectIds.push(result.rows[0].id);}
    objectIds.sort();
    if(objectIds.length!==deps.length)throw new TerminalJobError("Dependency publication did not preserve a one-to-one mapping from accepted candidates to immutable objects.");
    const engine={modelName:process.env.OPENAI_MODEL||"gpt-5.6",promptVersion:DEPENDENCY_PROMPT_VERSION,schemaVersion:DEPENDENCY_SCHEMA_VERSION};
    const candidateCounts={rawCandidateCount:dependencyResult.rawCount,invalidCandidateCount:dependencyResult.invalidCount,duplicateCandidateCount:dependencyResult.duplicateCount,rejectedCandidateCount:dependencyResult.rejectedCount};
    await transitionJobWithFence(client,job,{status:"SUCCEEDED",output:{dependencyCount:objectIds.length,objectIds,...candidateCounts,...engine,termAnalysisRunId:triggerRunId,sourceDocumentIds,sourceRunIds,inputHash}});
    await client.query(`insert into audit_events(actor_user_id,actor_name,action,matter_id,entity_type,entity_id,metadata) values($1,$2,'ANALYSIS_RUN',$3,'dependency_analysis',$4,$5::jsonb)`,[String(job.input?.requestedBy||"system-worker"),String(job.input?.requestedByName||"ContractTwin Worker"),job.matter_id,job.id,JSON.stringify({outputCount:objectIds.length,objectIds,...candidateCounts,...engine,termAnalysisRunId:triggerRunId,sourceDocumentIds,sourceRunIds,inputHash})]);
  });
}

async function processPrecedence(job:ProcessingJob){
  if(!job.matter_id) throw new Error("PRECEDENCE job requires matter.");
  const requestedScope=requestedDocumentScope(job);
  const agreementVersionId=String(job.input?.agreementVersionId||"");
  if(agreementVersionId&&!requestedScope)throw new TerminalJobError("Agreement-version precedence analysis requires an exact document scope.");
  const loadInputs=async()=>{
    const docs=(await query<{id:string;filename:string;document_type:string;sha256:string;server_sha256:string}>("select id,filename,document_type,sha256,server_sha256 from documents where matter_id=$1 and ($2::uuid[] is null or id=any($2::uuid[])) and extraction_status='EXTRACTED' and integrity_status='SERVER_VERIFIED' and security_scan_status='CLEAN' and deletion_status='ACTIVE' and sha256 is not null and server_sha256 is not null and lower(sha256)=lower(server_sha256) order by uploaded_at,id",[job.matter_id,requestedScope])).rows;
    if(requestedScope&&docs.length!==requestedScope.length)throw new TerminalJobError("Precedence scope contains a source that is missing, unsafe, stale, or unextracted.");
    const inputs=[] as Array<{id:string;filename:string;documentType:string;text:string;sourceChunks:Array<{id:string;content_sha256:string}>;sha256:string}>;
    for(const doc of docs){const chunks=(await query<{id:string;content:string;content_sha256:string}>(`select id,content,content_sha256 from document_chunks where document_id=$1 order by case when content ~* '(preced|conflict|amend|supersed|control|incorporat|govern|order of precedence)' then 0 else 1 end,coalesce(page_number,0),chunk_index,id limit 12`,[doc.id])).rows;inputs.push({id:doc.id,filename:doc.filename,documentType:doc.document_type,text:chunks.map(c=>c.content).join("\n\n"),sourceChunks:chunks.map(c=>({id:c.id,content_sha256:c.content_sha256})),sha256:doc.sha256.toLowerCase()});}
    return inputs;
  };
  const inputs=await loadInputs();
  const sourceDocumentIds=inputs.map(input=>input.id).sort();
  const inputHash=canonicalStateHash(inputs.map(({text,...input})=>input));
  const precedenceResult=inputs.length<2?{relations:[],rawCount:0,invalidCount:0,duplicateCount:0,rejectedCount:0}:await analyzePrecedence(inputs);
  if(legalRelianceEnabled&&precedenceResult.rejectedCount)throw new TerminalJobError("Legal-reliance precedence analysis rejected invalid or ungrounded model edges; no precedence receipt was published.");
  const relations=precedenceResult.relations;const objectIds:string[]=[];
  await withTransaction(async client=>{
    await assertJobLease(client,job);
    await client.query("select id from matters where id=$1 for update",[job.matter_id]);
    const currentDocs=(await client.query<{id:string;filename:string;document_type:string;sha256:string;server_sha256:string}>("select id,filename,document_type,sha256,server_sha256 from documents where matter_id=$1 and id=any($2::uuid[]) and extraction_status='EXTRACTED' and integrity_status='SERVER_VERIFIED' and security_scan_status='CLEAN' and deletion_status='ACTIVE' and sha256 is not null and server_sha256 is not null and lower(sha256)=lower(server_sha256) order by uploaded_at,id",[job.matter_id,sourceDocumentIds])).rows;
    const currentInputs=[] as Array<{id:string;filename:string;documentType:string;sourceChunks:Array<{id:string;content_sha256:string}>;sha256:string}>;
    for(const doc of currentDocs){const chunks=(await client.query<{id:string;content_sha256:string}>(`select id,content_sha256 from document_chunks where document_id=$1 order by case when content ~* '(preced|conflict|amend|supersed|control|incorporat|govern|order of precedence)' then 0 else 1 end,coalesce(page_number,0),chunk_index,id limit 12`,[doc.id])).rows;currentInputs.push({id:doc.id,filename:doc.filename,documentType:doc.document_type,sourceChunks:chunks,sha256:doc.sha256.toLowerCase()});}
    if(currentDocs.length!==sourceDocumentIds.length||canonicalStateHash(currentInputs)!==inputHash)throw new TerminalJobError("Current document state changed while precedence analysis was running.");
    await client.query("update document_relations set review_status='SUPERSEDED' where matter_id=$1 and review_status='UNREVIEWED' and source_document_id=any($2::uuid[]) and target_document_id=any($2::uuid[])",[job.matter_id,sourceDocumentIds]);
    for(const r of relations){const result=await client.query<{id:string}>(`insert into document_relations(matter_id,processing_job_id,origin,source_document_id,target_document_id,relation_type,source_locator,rationale,confidence,created_by) values($1,$2,'MODEL',$3,$4,$5,$6,$7,$8,$9) on conflict do nothing returning id`,[job.matter_id,job.id,r.sourceDocumentId,r.targetDocumentId,r.relationType,r.sourceExcerpt,r.rationale,r.confidence,String(job.input?.requestedBy||"system-worker")]);if(result.rows[0])objectIds.push(result.rows[0].id);}
    objectIds.sort();
    if(objectIds.length!==relations.length)throw new TerminalJobError("Precedence publication did not preserve a one-to-one mapping from accepted candidates to immutable objects.");
    const engine={modelName:process.env.OPENAI_MODEL||"gpt-5.6",promptVersion:PRECEDENCE_PROMPT_VERSION,schemaVersion:PRECEDENCE_SCHEMA_VERSION};
    const candidateCounts={rawCandidateCount:precedenceResult.rawCount,invalidCandidateCount:precedenceResult.invalidCount,duplicateCandidateCount:precedenceResult.duplicateCount,rejectedCandidateCount:precedenceResult.rejectedCount};
    await transitionJobWithFence(client,job,{status:"SUCCEEDED",output:{relationCount:objectIds.length,objectIds,...candidateCounts,...engine,sourceDocumentIds,inputHash}});
    await client.query(`insert into audit_events(actor_user_id,actor_name,action,matter_id,entity_type,entity_id,metadata) values($1,$2,'ANALYSIS_RUN',$3,'precedence_analysis',$4,$5::jsonb)`,[String(job.input?.requestedBy||"system-worker"),String(job.input?.requestedByName||"ContractTwin Worker"),job.matter_id,job.id,JSON.stringify({outputCount:objectIds.length,objectIds,...candidateCounts,...engine,sourceDocumentIds,inputHash})]);
  });
}

async function processSnapshot(job:ProcessingJob){
  if(!job.matter_id) throw new Error("EXECUTIVE_SUMMARY job requires matter.");
  const readiness=await assertLegalRelianceReady({requireEnabled:true});
  if(!readiness)throw new TerminalJobError("Legal-reliance evidence is unavailable.");
  const relianceEvidence=legalRelianceEvidence(readiness);
  const requestedRelianceEvidence=job.input?.requestedRelianceEvidence;
  const requestedRelianceHash=String(job.input?.requestedRelianceHash||"");
  if(!requestedRelianceEvidence||typeof requestedRelianceEvidence!=="object"||!/^[0-9a-f]{64}$/i.test(requestedRelianceHash)||canonicalStateHash(requestedRelianceEvidence)!==requestedRelianceHash||canonicalStateHash(relianceEvidence)!==requestedRelianceHash)throw new TerminalJobError("Legal-reliance evidence changed after snapshot authorization; submit a new snapshot request.");
  const requestedBy=String(job.input?.requestedBy||"");
  const requestedAgreementVersionId=String(job.input?.requestedAgreementVersionId||"");
  const requestedEconomicsRunId=String(job.input?.requestedEconomicsRunId||"");
  const requestedAuditId=String(job.input?.requestedAuditId??"");
  if(!requestedBy||!/^\d+$/.test(requestedAuditId)||!/[0-9a-f]{8}-[0-9a-f-]{27}/i.test(requestedAgreementVersionId)||!/[0-9a-f]{8}-[0-9a-f-]{27}/i.test(requestedEconomicsRunId))throw new TerminalJobError("Executive snapshot job is missing its bound requester or state identifiers.");
  await withTransaction(async client=>{
    await client.query("set transaction isolation level serializable");
    await assertJobLease(client,job);
    const matter=(await client.query<any>(`select m.id,m.matter_number,c.name customer,m.agreement_title,m.region,m.annual_revenue::text annual_revenue,m.stage,m.risk_level,m.status,m.owner_user_id,m.restricted,m.updated_at::text updated_at,(select role from app_user_roles where user_id=$2 and active=true limit 1) requester_role,(select access_level from matter_members where matter_id=m.id and user_id=$2 limit 1) member_access from matters m join customers c on c.id=m.customer_id where m.id=$1 for update of m`,[job.matter_id,requestedBy])).rows[0];
    if(!matter)throw new TerminalJobError("Snapshot matter no longer exists.");
    if(!["APPROVER","ADMIN"].includes(String(matter.requester_role||"")))throw new TerminalJobError("Snapshot requester no longer has an active Approver or Admin role.");
    if(matter.requester_role!=="ADMIN"&&matter.owner_user_id!==requestedBy&&matter.member_access!=="APPROVE")throw new TerminalJobError("Snapshot requester no longer has matter-level approval authority.");
    const currentAuditId=(await client.query<{id:string}>("select coalesce(max(id)::text,'0') id from audit_events where matter_id=$1",[job.matter_id])).rows[0].id;
    if(currentAuditId!==requestedAuditId)throw new TerminalJobError("Matter state changed after snapshot authorization; submit a new snapshot request.");
    const agreement=(await client.query<any>(`select id,matter_id,version_number,label,status,effective_date::text effective_date,created_by,created_at::text created_at,authoritative_economics_run_id,authoritative_economics_selected_by,authoritative_economics_selected_at::text authoritative_economics_selected_at,evidence_protocol_version from agreement_versions where id=$1 and matter_id=$2 and status in ('APPROVED','EXECUTED')`,[requestedAgreementVersionId,job.matter_id])).rows[0];
    if(!agreement)throw new TerminalJobError("The agreement version bound to this snapshot request is no longer APPROVED or EXECUTED.");
    if(Number(agreement.evidence_protocol_version)<1||!agreement.authoritative_economics_run_id||agreement.authoritative_economics_run_id!==requestedEconomicsRunId||!agreement.authoritative_economics_selected_by||!agreement.authoritative_economics_selected_at)throw new TerminalJobError("The snapshot request is not bound to a protocol-1 agreement version's immutable authoritative economics selection.");
    const documents=(await client.query<any>(`select d.id,d.matter_id,d.filename,d.document_type,d.version_label,d.mime_type,d.size_bytes,d.blob_pathname,d.source_status,d.sha256,d.server_sha256,d.integrity_status,d.extraction_status,d.extraction_method,d.page_count,d.security_scan_status,d.security_scanned_at::text security_scanned_at,d.deletion_status,d.uploaded_by,d.uploaded_at::text uploaded_at,avd.display_order,avd.included_by,avd.included_at::text included_at from agreement_version_documents avd join documents d on d.id=avd.document_id where avd.agreement_version_id=$1 and d.matter_id=$2 order by avd.display_order,d.id`,[agreement.id,job.matter_id])).rows;
    if(!documents.length)throw new TerminalJobError("The selected agreement version has no source documents.");
    const invalidDocuments=documents.filter((d:any)=>d.deletion_status!=="ACTIVE"||d.security_scan_status!=="CLEAN"||d.integrity_status!=="SERVER_VERIFIED"||d.extraction_status!=="EXTRACTED"||!d.sha256||!d.server_sha256||String(d.sha256).toLowerCase()!==String(d.server_sha256).toLowerCase());
    if(invalidDocuments.length)throw new TerminalJobError(`${invalidDocuments.length} agreement source document(s) lack a clean, extracted, hash-verified active state.`);
    const documentIds=documents.map((d:any)=>String(d.id)).sort();
    const currentModel=process.env.OPENAI_MODEL||"gpt-5.6";
    const sourceChunks=(await client.query<any>(`select document_id,id,page_number,chunk_index,content_sha256 from document_chunks where document_id=any($1::uuid[]) order by document_id,coalesce(page_number,0),chunk_index,id`,[documentIds])).rows;
    const latestRuns=(await client.query<any>(`select distinct on (document_id,run_type) id,document_id,run_type,status,model_name,prompt_version,schema_version,input_sha256,source_chunk_count,output_count,rejected_ungrounded_count,started_at::text started_at,finished_at::text finished_at from analysis_runs where document_id=any($1::uuid[]) and matter_id=$2 and run_type in ('CLAUSE_RISK','TERM_EXTRACTION') order by document_id,run_type,started_at desc,id desc`,[documentIds,job.matter_id])).rows;
    for(const documentId of documentIds){
      const hashes=sourceChunks.filter((chunk:any)=>chunk.document_id===documentId).map((chunk:any)=>chunk.content_sha256);
      if(!hashes.length)throw new TerminalJobError("Every agreement source must retain its extracted source-chunk hashes.");
      const expectedHash=chunkInputHash(hashes.map(content_sha256=>({content_sha256})));
      for(const runType of ["CLAUSE_RISK","TERM_EXTRACTION"]){
        const run=latestRuns.find((candidate:any)=>candidate.document_id===documentId&&candidate.run_type===runType);
        const expectedPrompt=runType==="CLAUSE_RISK"?PROMPT_VERSION:TERM_PROMPT_VERSION;
        const expectedSchema=runType==="CLAUSE_RISK"?"clause-risk.v2":TERM_SCHEMA_VERSION;
        if(!run||run.status!=="SUCCEEDED"||run.model_name!==currentModel||run.prompt_version!==expectedPrompt||run.schema_version!==expectedSchema||String(run.input_sha256).toLowerCase()!==expectedHash||Number(run.source_chunk_count)!==hashes.length)throw new TerminalJobError("Every agreement source must have current successful clause-risk and term-extraction runs bound to its present chunks, model, prompt, and schema.");
        if(legalRelianceEnabled&&Number(run.rejected_ungrounded_count)!==0)throw new TerminalJobError("Legal-reliance snapshots require zero rejected ungrounded outputs in current analysis runs.");
      }
    }
    const clauseRunIds=latestRuns.filter((run:any)=>run.run_type==="CLAUSE_RISK").map((run:any)=>String(run.id)).sort();
    const termRunIds=latestRuns.filter((run:any)=>run.run_type==="TERM_EXTRACTION").map((run:any)=>String(run.id)).sort();
    const dependencyTerms=(await client.query<any>(`select t.id,t.analysis_run_id,t.clause_family,t.term_type,t.normalized_statement,t.trigger_event from contract_terms t where t.matter_id=$1 and t.document_id=any($2::uuid[]) and t.analysis_run_id=any($3::uuid[]) and t.review_status<>'SUPERSEDED' order by t.created_at,t.id limit 251`,[job.matter_id,documentIds,termRunIds])).rows;
    if(dependencyTerms.length>250)throw new TerminalJobError("Dependency evidence exceeds the governed 250-term limit.");
    const dependencyInputHash=canonicalStateHash({sourceDocumentIds:documentIds,sourceRunIds:termRunIds,terms:dependencyTerms});
    const dependencyReceipt=(await client.query<any>(`select id,input,output,created_by,started_at::text started_at,finished_at::text finished_at from processing_jobs where matter_id=$1 and job_type='DEPENDENCY' and status='SUCCEEDED' and input->>'agreementVersionId'=$2 and input->>'graphVersion'=$3 and output->'sourceDocumentIds'=$4::jsonb and output->'sourceRunIds'=$5::jsonb and output->>'modelName'=$6 and output->>'promptVersion'=$7 and output->>'schemaVersion'=$8 and output->>'inputHash'=$9 order by finished_at desc,id desc limit 1`,[job.matter_id,agreement.id,AGREEMENT_GRAPH_VERSION,JSON.stringify(documentIds),JSON.stringify(termRunIds),currentModel,DEPENDENCY_PROMPT_VERSION,DEPENDENCY_SCHEMA_VERSION,dependencyInputHash])).rows[0];
    const dependencyOutput=recordValue(dependencyReceipt?.output);const dependencyInput=recordValue(dependencyReceipt?.input);
    const dependencyObjectIds=Array.isArray(dependencyOutput.objectIds)?dependencyOutput.objectIds.map(String).sort():null;
    if(!dependencyReceipt||!dependencyObjectIds||Number(dependencyOutput.dependencyCount)!==dependencyObjectIds.length||Number(dependencyOutput.rawCandidateCount)!==dependencyObjectIds.length||Number(dependencyOutput.rejectedCandidateCount)!==0||dependencyOutput.inputHash!==dependencyInputHash)throw new TerminalJobError("A current successful, rejection-free dependency-analysis receipt bound to the exact agreement term state is required.");
    const precedenceDocuments=(await client.query<any>("select id,filename,document_type,sha256 from documents where matter_id=$1 and id=any($2::uuid[]) and extraction_status='EXTRACTED' and integrity_status='SERVER_VERIFIED' and security_scan_status='CLEAN' and deletion_status='ACTIVE' and sha256 is not null and server_sha256 is not null and lower(sha256)=lower(server_sha256) order by uploaded_at,id",[job.matter_id,documentIds])).rows;
    if(precedenceDocuments.length!==documentIds.length)throw new TerminalJobError("Precedence inputs no longer match the exact agreement-version source set.");
    const precedenceInputs=[] as Array<{id:string;filename:string;documentType:string;sourceChunks:Array<{id:string;content_sha256:string}>;sha256:string}>;
    for(const doc of precedenceDocuments){const chunks=(await client.query<{id:string;content_sha256:string}>(`select id,content_sha256 from document_chunks where document_id=$1 order by case when content ~* '(preced|conflict|amend|supersed|control|incorporat|govern|order of precedence)' then 0 else 1 end,coalesce(page_number,0),chunk_index,id limit 12`,[doc.id])).rows;precedenceInputs.push({id:doc.id,filename:doc.filename,documentType:doc.document_type,sourceChunks:chunks,sha256:String(doc.sha256).toLowerCase()});}
    const precedenceInputHash=canonicalStateHash(precedenceInputs);
    const precedenceReceipt=(await client.query<any>(`select id,input,output,created_by,started_at::text started_at,finished_at::text finished_at from processing_jobs where matter_id=$1 and job_type='PRECEDENCE' and status='SUCCEEDED' and input->>'agreementVersionId'=$2 and input->>'graphVersion'=$3 and output->'sourceDocumentIds'=$4::jsonb and output->>'modelName'=$5 and output->>'promptVersion'=$6 and output->>'schemaVersion'=$7 and output->>'inputHash'=$8 order by finished_at desc,id desc limit 1`,[job.matter_id,agreement.id,AGREEMENT_GRAPH_VERSION,JSON.stringify(documentIds),currentModel,PRECEDENCE_PROMPT_VERSION,PRECEDENCE_SCHEMA_VERSION,precedenceInputHash])).rows[0];
    const precedenceOutput=recordValue(precedenceReceipt?.output);
    const precedenceObjectIds=Array.isArray(precedenceOutput.objectIds)?precedenceOutput.objectIds.map(String).sort():null;
    if(!precedenceReceipt||!precedenceObjectIds||Number(precedenceOutput.relationCount)!==precedenceObjectIds.length||Number(precedenceOutput.rawCandidateCount)!==precedenceObjectIds.length||Number(precedenceOutput.rejectedCandidateCount)!==0||precedenceOutput.inputHash!==precedenceInputHash)throw new TerminalJobError("A current successful, rejection-free precedence-analysis receipt bound to the exact agreement source state is required.");
    const reviewAttestations=(await client.query<any>(`select id,matter_id,scope_type,analysis_run_id,processing_job_id,input_sha256,output_count,disposition_counts,manifest,manifest_hash,attestation_note,attested_by,attested_at::text attested_at from analysis_review_attestations where matter_id=$1 and (analysis_run_id=any($2::uuid[]) or processing_job_id=any($3::uuid[])) order by scope_type,id`,[job.matter_id,[...clauseRunIds,...termRunIds],[dependencyReceipt.id,precedenceReceipt.id]])).rows;
    const validatedFindingIds:string[]=[];const validatedTermIds:string[]=[];
    for(const run of latestRuns){
      const attestation=reviewAttestations.find((candidate:any)=>candidate.analysis_run_id===run.id&&candidate.scope_type===run.run_type);
      const manifest=recordValue(attestation?.manifest);const manifestObjects=Array.isArray(manifest.objects)?manifest.objects as Array<Record<string,unknown>>:[];
      if(!attestation||String(attestation.input_sha256).toLowerCase()!==String(run.input_sha256).toLowerCase()||Number(attestation.output_count)!==Number(run.output_count)||manifestObjects.length!==Number(run.output_count))throw new TerminalJobError(`Current ${run.run_type} run lacks an exact immutable counsel-completion attestation.`);
      const validatedIds=manifestObjects.filter(object=>object.review_status==="VALIDATED").map(object=>String(object.id||""));
      if(validatedIds.some(id=>!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(id)))throw new TerminalJobError("Analysis attestation contains an invalid object identifier.");
      if(run.run_type==="CLAUSE_RISK")validatedFindingIds.push(...validatedIds);else validatedTermIds.push(...validatedIds);
    }
    for(const [scope,receipt,inputHash,objectIds] of [["DEPENDENCY",dependencyReceipt,dependencyInputHash,dependencyObjectIds],["PRECEDENCE",precedenceReceipt,precedenceInputHash,precedenceObjectIds]] as const){
      const attestation=reviewAttestations.find((candidate:any)=>candidate.processing_job_id===receipt.id&&candidate.scope_type===scope);
      const manifest=recordValue(attestation?.manifest);const manifestObjects=Array.isArray(manifest.objects)?manifest.objects as Array<Record<string,unknown>>:[];const attestedIds=manifestObjects.map(object=>String(object.id||"")).sort();
      if(!attestation||String(attestation.input_sha256).toLowerCase()!==inputHash||Number(attestation.output_count)!==objectIds.length||!sameSortedIds(attestedIds,objectIds))throw new TerminalJobError(`Current ${scope} receipt lacks an exact immutable counsel-completion attestation for its published objects.`);
    }
    const review=(await client.query<any>(`select
      (select count(*)::int from findings where analysis_run_id=any($1::uuid[]) and review_status='UNREVIEWED') unreviewed_findings,
      (select count(*)::int from contract_terms where analysis_run_id=any($2::uuid[]) and review_status='UNREVIEWED') unreviewed_terms,
      (select count(*)::int from term_dependencies where processing_job_id=$4 and id=any($5::uuid[]) and review_status='UNREVIEWED') unreviewed_dependencies,
      (select count(*)::int from document_relations where processing_job_id=$6 and id=any($7::uuid[]) and review_status='UNREVIEWED') unreviewed_relations,
      (select count(*)::int from findings where analysis_run_id=any($1::uuid[]) and review_status='VALIDATED' and (reviewed_at is null or reviewed_by is null or nullif(trim(review_note),'') is null)) undocumented_findings,
      (select count(*)::int from contract_terms where analysis_run_id=any($2::uuid[]) and review_status='VALIDATED' and (reviewed_at is null or reviewed_by is null or nullif(trim(review_note),'') is null)) undocumented_terms,
      (select count(*)::int from term_dependencies where processing_job_id=$4 and id=any($5::uuid[]) and review_status='VALIDATED' and (reviewed_at is null or reviewed_by is null or nullif(trim(review_note),'') is null)) undocumented_dependencies,
      (select count(*)::int from document_relations where processing_job_id=$6 and id=any($7::uuid[]) and review_status='VALIDATED' and (reviewed_at is null or reviewed_by is null or nullif(trim(review_note),'') is null)) undocumented_relations`,[clauseRunIds,termRunIds,documentIds,dependencyReceipt.id,dependencyObjectIds,precedenceReceipt.id,precedenceObjectIds])).rows[0];
    const openReviews=Number(review.unreviewed_findings)+Number(review.unreviewed_terms)+Number(review.unreviewed_dependencies)+Number(review.unreviewed_relations);
    const undocumentedReviews=Number(review.undocumented_findings)+Number(review.undocumented_terms)+Number(review.undocumented_dependencies)+Number(review.undocumented_relations);
    if(openReviews)throw new TerminalJobError(`${openReviews} source-derived object(s) still require human disposition.`);
    if(undocumentedReviews)throw new TerminalJobError(`${undocumentedReviews} validated object(s) lack a recorded human-review note.`);

    const allFindings=(await client.query<any>(`select id,matter_id,document_id,analysis_run_id,clause_family,issue,risk_level,rationale,operational_consequence,source_excerpt,source_locator,primary_position,fallback_position,no_go_position,approval_required,financial_variables,uncertainty,standard_status,standard_version,model_name,prompt_version,created_by,created_at::text created_at,reviewed_by,reviewed_at::text reviewed_at,review_note from findings where matter_id=$2 and analysis_run_id=any($1::uuid[]) and id=any($3::uuid[]) and review_status='VALIDATED' order by case risk_level when 'Critical' then 4 when 'High' then 3 when 'Medium' then 2 else 1 end desc,created_at desc,id`,[clauseRunIds,job.matter_id,validatedFindingIds])).rows;
    const governedStandards=(await client.query<any>(`select id,clause_family,title,standard_position,fallback_position,no_go_position,approval_authority,business_rationale,provenance_source,approval_role,version,effective_date::text effective_date,created_by,created_at::text created_at from negotiation_standards where active=true and clause_family=any($1::text[]) order by clause_family,version,id`,[[...new Set(allFindings.map((finding:any)=>finding.clause_family).filter(Boolean))]])).rows;
    if(legalRelianceEnabled&&allFindings.some((finding:any)=>{const standard=governedStandards.find((candidate:any)=>candidate.clause_family===finding.clause_family&&candidate.version===finding.standard_version);return finding.standard_status!=="APPROVED"||!standard||standard.standard_position!==finding.primary_position||standard.fallback_position!==finding.fallback_position||standard.no_go_position!==finding.no_go_position||standard.approval_authority!==finding.approval_required;}))throw new TerminalJobError("Every validated finding must remain bound to its current approved governed negotiation standard in legal-reliance mode.");
    const terms=(await client.query<any>(`select id,matter_id,document_id,analysis_run_id,chunk_id,clause_family,section_label,term_type,party,counterparty,exact_text_sha256,normalized_statement,trigger_event,exceptions,operational_owner,confidence,model_name,prompt_version,created_by,created_at::text created_at,reviewed_by,reviewed_at::text reviewed_at,review_note from contract_terms where matter_id=$2 and analysis_run_id=any($1::uuid[]) and id=any($3::uuid[]) and review_status='VALIDATED' order by document_id,created_at,id`,[termRunIds,job.matter_id,validatedTermIds])).rows;
    const dependencies=(await client.query<any>(`select td.id,td.matter_id,td.processing_job_id,td.origin,td.dependency_type,td.rationale,td.confidence,s.id source_term_id,s.normalized_statement source,s.review_status source_review_status,t.id target_term_id,t.normalized_statement target,t.review_status target_review_status,td.created_by,td.created_at::text created_at,td.reviewed_by,td.reviewed_at::text reviewed_at,td.review_note from term_dependencies td join contract_terms s on s.id=td.source_term_id join contract_terms t on t.id=td.target_term_id where td.matter_id=$2 and s.analysis_run_id=any($1::uuid[]) and t.analysis_run_id=any($1::uuid[]) and td.review_status='VALIDATED' and ((td.processing_job_id=$3 and td.origin='MODEL' and td.id=any($4::uuid[])) or (td.processing_job_id is null and td.origin='COUNSEL')) order by td.created_at,td.id`,[termRunIds,job.matter_id,dependencyReceipt.id,dependencyObjectIds])).rows;
    if(dependencies.some((dependency:any)=>dependency.source_review_status!=="VALIDATED"||dependency.target_review_status!=="VALIDATED"))throw new TerminalJobError("Validated dependency edges may reference only validated current contract terms.");
    const relations=(await client.query<any>(`select id,matter_id,processing_job_id,origin,source_document_id,target_document_id,relation_type,source_locator,rationale,confidence,created_by,created_at::text created_at,reviewed_by,reviewed_at::text reviewed_at,review_note from document_relations where matter_id=$2 and source_document_id=any($1::uuid[]) and target_document_id=any($1::uuid[]) and review_status='VALIDATED' and ((processing_job_id=$3 and origin='MODEL' and id=any($4::uuid[])) or (processing_job_id is null and origin='COUNSEL')) order by created_at,id`,[documentIds,job.matter_id,precedenceReceipt.id,precedenceObjectIds])).rows;
    const economics=(await client.query<any>("select id,matter_id,agreement_version_id,inputs,outputs,formula_version,review_status,reviewed_by,reviewed_at::text reviewed_at,review_note,created_by,created_at::text created_at from economics_runs where id=$1 and matter_id=$2 and agreement_version_id=$3 and formula_version=$4 and review_status='VALIDATED'",[requestedEconomicsRunId,job.matter_id,agreement.id,ECONOMICS_FORMULA_VERSION])).rows[0];
    if(!economics)throw new TerminalJobError("The agreement version's authoritative economics selection is not validated on the current formula.");
    const decisions=(await client.query<any>("select d.id,d.agreement_version_id,d.finding_id,d.decision_type,d.rationale,d.decision_status,d.required_approver_role,d.economics_run_id,d.disposition_note,d.evidence_protocol_version,d.requested_by,d.decided_by,d.requested_at::text requested_at,d.decided_at::text decided_at,(select json_build_object('id',decision_economics.id,'agreementVersionId',decision_economics.agreement_version_id,'inputs',decision_economics.inputs,'outputs',decision_economics.outputs,'formulaVersion',decision_economics.formula_version,'reviewStatus',decision_economics.review_status,'reviewedBy',decision_economics.reviewed_by,'reviewedAt',decision_economics.reviewed_at::text,'reviewNote',decision_economics.review_note,'createdAt',decision_economics.created_at::text) from economics_runs decision_economics where decision_economics.id=d.economics_run_id) economics_evidence,coalesce(json_agg(json_build_object('id',dc.id,'sequenceNumber',dc.sequence_number,'text',dc.condition_text,'status',dc.condition_status,'evidence',dc.evidence,'resolvedBy',dc.resolved_by,'resolvedAt',dc.resolved_at::text) order by dc.sequence_number) filter(where dc.id is not null),'[]'::json) conditions from decisions d left join decision_conditions dc on dc.decision_id=d.id where d.matter_id=$1 and d.agreement_version_id=$2 group by d.id order by d.requested_at,d.id",[job.matter_id,agreement.id])).rows;
    const effectiveAuthority=decisions.filter((decision:any)=>decision.decision_status==="APPROVED"&&Number(decision.evidence_protocol_version)>=1&&decision.economics_run_id===economics.id&&typeof decision.disposition_note==="string"&&decision.disposition_note.trim().length>=12&&decision.disposition_note.trim().length<=4000).map((decision:any)=>({...decision,projection_status:"EFFECTIVE_AUTHORITY"}));
    const pendingActions=decisions.filter((decision:any)=>decision.decision_status==="PENDING").map((decision:any)=>({...decision,projection_status:"PENDING_ACTION"}));
    const executiveDecisionProjection=[...effectiveAuthority,...pendingActions];
    const matterContext={matterId:matter.id,matterNumber:matter.matter_number,customer:matter.customer,agreementTitle:matter.agreement_title,region:matter.region,annualRevenue:matter.annual_revenue,stage:matter.stage,riskLevel:matter.risk_level,status:matter.status,updatedAt:matter.updated_at};
    const topRisks=allFindings.slice(0,5);
    const negotiationActions=topRisks.map((f:any)=>({findingId:f.id,issue:f.issue,primary:f.primary_position,fallback:f.fallback_position,noGo:f.no_go_position,approval:f.approval_required,standardVersion:f.standard_version}));
    const hasBlockingAuthority=effectiveAuthority.some((decision:any)=>["NEGOTIATE","ESCALATE","REJECT"].includes(decision.decision_type));
    const nextSteps:string[]=[];if(pendingActions.length)nextSteps.push("Resolve pending executive decisions under the recorded authority level.");if(hasBlockingAuthority)nextSteps.push("Do not execute this version; complete the recorded negotiation, escalation, or rejection path in a new agreement version.");else if(agreement.status==="APPROVED")nextSteps.push("Complete authorized execution and freeze the executed agreement version.");else nextSteps.push("Retain the executed source set and monitor obligations against this frozen state.");
    const publicationReceipt={jobId:job.id,requesterId:requestedBy,agreementVersionId:agreement.id,economicsRunId:economics.id,sourceAuditId:requestedAuditId,relianceEvidenceHash:requestedRelianceHash};
    const snapshotPresentation={topRisks,quantifiedExposure:economics,dependencies,negotiationActions,executiveDecisions:executiveDecisionProjection,nextSteps};
    const state={matterContext,agreement,documents,sourceChunks,analysisRuns:latestRuns,analysisReviewAttestations:reviewAttestations,dependencyReceipt:{...dependencyReceipt,input:dependencyInput,output:dependencyOutput},precedenceReceipt:{...precedenceReceipt,output:precedenceOutput},findings:allFindings,governedStandards,terms,dependencies,relations,economics,decisions,relianceEvidence,publicationReceipt,snapshotPresentation};
    const sourceManifestCanonical=canonicalStateJson(state);
    const sourceStateHash=createHash("sha256").update(sourceManifestCanonical,"utf8").digest("hex");
    const latest=(await client.query<{v:number}>("select coalesce(max(snapshot_version),0)::int v from executive_snapshots where matter_id=$1",[job.matter_id])).rows[0]?.v??0;
    const result=await client.query<{id:string}>(`insert into executive_snapshots(matter_id,agreement_version_id,processing_job_id,snapshot_version,matter_context,source_manifest,source_manifest_canonical,top_risks,quantified_exposure,dependencies,negotiation_actions,executive_decisions,next_steps,source_state_hash,generated_by) values($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,$8::jsonb,$9::jsonb,$10::jsonb,$11::jsonb,$12::jsonb,$13::jsonb,$14,$15) returning id`,[job.matter_id,agreement.id,job.id,latest+1,JSON.stringify(matterContext),sourceManifestCanonical,sourceManifestCanonical,JSON.stringify(topRisks),JSON.stringify(economics),JSON.stringify(dependencies),JSON.stringify(negotiationActions),JSON.stringify(executiveDecisionProjection),JSON.stringify(nextSteps),sourceStateHash,requestedBy]);
    await transitionJobWithFence(client,job,{status:"SUCCEEDED",output:{snapshotId:result.rows[0].id,snapshotVersion:latest+1,agreementVersionId:agreement.id,economicsRunId:economics.id,requesterId:requestedBy,sourceAuditId:requestedAuditId,sourceStateHash,relianceEvidenceHash:requestedRelianceHash}});
    await client.query(`insert into audit_events(actor_user_id,actor_name,action,matter_id,entity_type,entity_id,metadata) values($1,$2,'EXECUTIVE_SNAPSHOT_CREATED',$3,'executive_snapshot',$4,$5::jsonb)`,[String(job.input?.requestedBy||"system-worker"),String(job.input?.requestedByName||"ContractTwin Worker"),job.matter_id,result.rows[0].id,JSON.stringify({snapshotVersion:latest+1,agreementVersionId:agreement.id,sourceStateHash,relianceEvidenceHash:requestedRelianceHash})]);
  });
}

export async function processJob(job:ProcessingJob){
  let heartbeatTimer:ReturnType<typeof setInterval>|null=null;
  let heartbeatFailure:unknown=null;
  try{
    await heartbeatJob(job);
    heartbeatTimer=setInterval(()=>{void heartbeatJob(job).catch(error=>{if(error instanceof JobLeaseLostError)heartbeatFailure=error;});},jobHeartbeatIntervalMillis());
    try{
      if(heartbeatFailure)throw heartbeatFailure;
      switch(job.job_type){
        case "MALWARE_SCAN":return await processMalwareScan(job);
        case "EXTRACT":return await processExtract(job);
        case "OCR":return await processOcr(job);
        case "ANALYZE":return await processAnalysis(job);
        case "TERM_EXTRACT":return await processTerms(job);
        case "DEPENDENCY":return await processDependencies(job);
        case "PRECEDENCE":return await processPrecedence(job);
        case "EXECUTIVE_SUMMARY":return await processSnapshot(job);
        default:throw new Error(`Job type ${job.job_type} does not yet have a processor.`);
      }
    }catch(error){
      if(error instanceof JobLeaseLostError||heartbeatFailure instanceof JobLeaseLostError)throw (heartbeatFailure||error);
      const retryable=!(error instanceof TerminalJobError);
      const willRetry=retryable&&job.attempts<job.max_attempts;
      const analysisRunId=String(job.output?.analysisRunId||"");
      let publicFailure:string;
      if(analysisRunId&&!willRetry){
        const failure=safeOperationalFailure(
          error,
          retryable
            ? "The analysis dependency remained unavailable after the retry limit."
            : "A governed analysis control rejected the job."
        );
        publicFailure=failure.message;
        await withTransaction(async client=>{
          await assertJobLease(client,job);
          await transitionJobWithFence(client,job,{status:"FAILED",errorMessage:publicFailure});
          await client.query("update analysis_runs set status='FAILED',error_message=$2,finished_at=now() where id=$1 and status='RUNNING'",[analysisRunId,publicFailure]);
        });
      }else publicFailure=(await failJob(job,error,retryable,!(error instanceof ExternalOperationRejectedError))).message;
      throw new Error(publicFailure);
    }
  }finally{
    if(heartbeatTimer)clearInterval(heartbeatTimer);
  }
}
