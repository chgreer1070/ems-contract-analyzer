import { createHash, randomUUID } from "node:crypto";
import { get } from "@vercel/blob";
import type { Principal } from "@/lib/access";
import { analyzeContractText, PROMPT_VERSION, sourceContainsExcerpt, type CoreFinding } from "@/lib/analysisEngine";
import { query, withTransaction } from "@/lib/db";
import { inferDependencies, DEPENDENCY_PROMPT_VERSION } from "@/lib/dependencyEngine";
import { extractDocument } from "@/lib/documentExtraction";
import { enrichFindings, persistFindings, type EnrichedFinding } from "@/lib/findings";
import { completeJob, continueJob, enqueueJob, failJob, pollAzureOcr, waitExternal, type ProcessingJob } from "@/lib/jobs-internal";
import { azureOcrConfigured, pollAzureOcr as pollOcr, submitAzureOcr } from "@/lib/ocr";
import { analyzePrecedence, PRECEDENCE_PROMPT_VERSION } from "@/lib/precedenceEngine";
import { exactTextHash, extractTerms, TERM_PROMPT_VERSION, TERM_SCHEMA_VERSION } from "@/lib/termEngine";

// This import shim is replaced below by direct exports from jobs.ts; kept isolated to make worker dependencies auditable.

function workerPrincipal(job:ProcessingJob):Principal {
  const requestedBy=String(job.input?.requestedBy||"system-worker");
  const requestedByName=String(job.input?.requestedByName||"ContractTwin Worker");
  return {userId:requestedBy,name:requestedByName,email:null,role:"ADMIN",demo:false};
}

async function loadDocument(documentId:string){
  const result=await query<{id:string;matter_id:string;filename:string;document_type:string;mime_type:string;blob_pathname:string;sha256:string|null;extraction_status:string}>(
    "select id,matter_id,filename,document_type,mime_type,blob_pathname,sha256,extraction_status from documents where id=$1 limit 1",[documentId]
  );
  if(!result.rows[0]) throw new Error("Document not found.");
  return result.rows[0];
}

async function loadBlobBytes(pathname:string){
  if(!process.env.BLOB_READ_WRITE_TOKEN) throw new Error("BLOB_READ_WRITE_TOKEN is not configured.");
  const blob=await get(pathname,{access:"private",token:process.env.BLOB_READ_WRITE_TOKEN});
  if(!blob||blob.statusCode!==200||!blob.stream) throw new Error("Source blob not found.");
  return new Response(blob.stream).arrayBuffer();
}

async function persistChunks(documentId:string,matterId:string,chunks:Array<{pageNumber:number|null;chunkIndex:number;text:string;sha256:string}>,method:string,pageCount:number|null,serverSha?:string){
  await withTransaction(async client=>{
    await client.query("delete from document_chunks where document_id=$1",[documentId]);
    for(const chunk of chunks) await client.query(
      `insert into document_chunks(document_id,matter_id,page_number,chunk_index,content,content_sha256) values($1,$2,$3,$4,$5,$6)`,
      [documentId,matterId,chunk.pageNumber,chunk.chunkIndex,chunk.text,chunk.sha256]
    );
    await client.query(`update documents set extraction_status='EXTRACTED',integrity_status='SERVER_VERIFIED',extraction_method=$2,page_count=$3,server_sha256=coalesce($4,server_sha256),extracted_at=now() where id=$1`,[documentId,method,pageCount,serverSha??null]);
  });
}

function sourceLocator(finding:CoreFinding,chunks:Array<{id:string;page_number:number|null;chunk_index:number;content:string}>,filename:string){
  const chunk=chunks.find(c=>sourceContainsExcerpt(c.content,finding.sourceExcerpt));
  if(!chunk) return `${filename} · verified source excerpt`;
  return chunk.page_number?`${filename} · p. ${chunk.page_number}`:`${filename} · text chunk ${chunk.chunk_index+1}`;
}

async function processExtract(job:ProcessingJob){
  if(!job.document_id) throw new Error("EXTRACT job requires document_id.");
  const doc=await loadDocument(job.document_id);const bytes=await loadBlobBytes(doc.blob_pathname);
  const serverSha=createHash("sha256").update(Buffer.from(bytes)).digest("hex");
  if(doc.sha256&&doc.sha256.toLowerCase()!==serverSha.toLowerCase()){
    await query("update documents set integrity_status='FAILED',extraction_status='FAILED' where id=$1",[doc.id]);
    throw new Error("Source integrity verification failed.");
  }
  const extraction=await extractDocument(bytes,doc.mime_type);
  if(!extraction.chunks.length){
    await query("update documents set integrity_status='SERVER_VERIFIED',server_sha256=$2,extraction_status='OCR_REQUIRED',extraction_method=$3,page_count=$4 where id=$1",[doc.id,serverSha,extraction.method,extraction.pageCount]);
    if(!azureOcrConfigured()) throw new Error("Document requires OCR and Azure Document Intelligence is not configured.");
    await enqueueJob({matterId:doc.matter_id,documentId:doc.id,jobType:"OCR",idempotencyKey:`ocr:${doc.id}:${serverSha}`,createdBy:String(job.input?.requestedBy||"system-worker"),input:job.input,maxAttempts:3});
    await completeJob(job.id,{delegatedTo:"OCR",serverSha256:serverSha,warnings:extraction.warnings});return;
  }
  await persistChunks(doc.id,doc.matter_id,extraction.chunks,extraction.method,extraction.pageCount,serverSha);
  await completeJob(job.id,{chunkCount:extraction.chunks.length,pageCount:extraction.pageCount,method:extraction.method,serverSha256:serverSha,warnings:extraction.warnings});
}

async function processOcr(job:ProcessingJob){
  if(!job.document_id) throw new Error("OCR job requires document_id.");
  const doc=await loadDocument(job.document_id);
  if(!job.external_operation_url){
    const bytes=await loadBlobBytes(doc.blob_pathname);
    const serverSha=createHash("sha256").update(Buffer.from(bytes)).digest("hex");
    if(doc.sha256&&doc.sha256.toLowerCase()!==serverSha.toLowerCase()) throw new Error("Source integrity verification failed before OCR.");
    const operation=await submitAzureOcr(bytes);
    await waitExternal(job.id,operation,{serverSha256:serverSha},5);return;
  }
  const result=await pollOcr(job.external_operation_url);
  if(result.status==="running"){await waitExternal(job.id,job.external_operation_url,job.output??{},5);return;}
  if(result.status==="failed") throw new Error(result.error);
  await persistChunks(doc.id,doc.matter_id,result.chunks,"AZURE_DOCUMENT_INTELLIGENCE",result.pageCount,String(job.output?.serverSha256||"" )||undefined);
  await completeJob(job.id,{pageCount:result.pageCount,chunkCount:result.chunks.length,method:"AZURE_DOCUMENT_INTELLIGENCE"});
}

async function processAnalysis(job:ProcessingJob){
  if(!job.document_id||!job.matter_id) throw new Error("ANALYZE job requires document and matter.");
  const doc=await loadDocument(job.document_id);
  const chunks=(await query<{id:string;page_number:number|null;chunk_index:number;content:string;content_sha256:string}>("select id,page_number,chunk_index,content,content_sha256 from document_chunks where document_id=$1 order by coalesce(page_number,0),chunk_index",[doc.id])).rows;
  if(!chunks.length) throw new Error("No extracted source chunks are available.");
  const state={next:Number(job.output?.nextChunk??0),findingCount:Number(job.output?.findingCount??0),rejected:Number(job.output?.rejected??0),analysisRunId:String(job.output?.analysisRunId||"")};
  let runId=state.analysisRunId;
  if(!runId){
    const inputHash=createHash("sha256").update(chunks.map(c=>c.content_sha256).join(":"),"utf8").digest("hex");
    const r=await query<{id:string}>(`insert into analysis_runs(matter_id,document_id,run_type,status,model_name,prompt_version,schema_version,input_sha256,source_chunk_count,created_by) values($1,$2,'CLAUSE_RISK','RUNNING',$3,$4,'clause-risk.v1',$5,$6,$7) returning id`,[job.matter_id,job.document_id,process.env.OPENAI_MODEL||"gpt-5.6",PROMPT_VERSION,inputHash,chunks.length,String(job.input?.requestedBy||"system-worker")]);runId=r.rows[0].id;
    await query("update findings set review_status='SUPERSEDED' where document_id=$1 and review_status='UNREVIEWED'",[doc.id]);
  }
  if(state.next>=chunks.length){await query("update analysis_runs set status='SUCCEEDED',output_count=$2,rejected_ungrounded_count=$3,finished_at=now() where id=$1",[runId,state.findingCount,state.rejected]);await completeJob(job.id,{...state,analysisRunId:runId});return;}
  const chunk=chunks[state.next];const result=await analyzeContractText(chunk.content);const enriched=await enrichFindings(result.findings,false);
  const located:EnrichedFinding[]=enriched.map(f=>({...f,sourceLocator:sourceLocator(f,[chunk],doc.filename)}));
  const ids=await persistFindings({principal:workerPrincipal(job),matterId:job.matter_id,documentId:job.document_id,findings:located,modelName:result.modelName,promptVersion:PROMPT_VERSION});
  const next=state.next+1;const output={nextChunk:next,findingCount:state.findingCount+ids.length,rejected:state.rejected+result.rejectedUngroundedFindings,analysisRunId:runId};
  if(next>=chunks.length){await query("update analysis_runs set status='SUCCEEDED',output_count=$2,rejected_ungrounded_count=$3,finished_at=now() where id=$1",[runId,output.findingCount,output.rejected]);await completeJob(job.id,output);}else await continueJob(job.id,output,1);
}

async function processTerms(job:ProcessingJob){
  if(!job.document_id||!job.matter_id) throw new Error("TERM_EXTRACT job requires document and matter.");
  const chunks=(await query<{id:string;page_number:number|null;chunk_index:number;content:string;content_sha256:string}>("select id,page_number,chunk_index,content,content_sha256 from document_chunks where document_id=$1 order by coalesce(page_number,0),chunk_index",[job.document_id])).rows;
  if(!chunks.length) throw new Error("No extracted source chunks are available.");
  const state={next:Number(job.output?.nextChunk??0),termCount:Number(job.output?.termCount??0),rejected:Number(job.output?.rejected??0),analysisRunId:String(job.output?.analysisRunId||"")};let runId=state.analysisRunId;
  if(!runId){const hash=createHash("sha256").update(chunks.map(c=>c.content_sha256).join(":"),"utf8").digest("hex");const r=await query<{id:string}>(`insert into analysis_runs(matter_id,document_id,run_type,status,model_name,prompt_version,schema_version,input_sha256,source_chunk_count,created_by) values($1,$2,'TERM_EXTRACTION','RUNNING',$3,$4,$5,$6,$7,$8) returning id`,[job.matter_id,job.document_id,process.env.OPENAI_MODEL||"gpt-5.6",TERM_PROMPT_VERSION,TERM_SCHEMA_VERSION,hash,chunks.length,String(job.input?.requestedBy||"system-worker")]);runId=r.rows[0].id;await query("update contract_terms set review_status='SUPERSEDED' where document_id=$1 and review_status='UNREVIEWED'",[job.document_id]);}
  if(state.next>=chunks.length){await query("update analysis_runs set status='SUCCEEDED',output_count=$2,rejected_ungrounded_count=$3,finished_at=now() where id=$1",[runId,state.termCount,state.rejected]);await completeJob(job.id,{...state,analysisRunId:runId});return;}
  const chunk=chunks[state.next];const result=await extractTerms(chunk.content);let inserted=0;
  for(const term of result.terms){await query(`insert into contract_terms(matter_id,document_id,chunk_id,clause_family,section_label,term_type,party,counterparty,exact_text,exact_text_sha256,normalized_statement,trigger_event,exceptions,operational_owner,confidence,model_name,prompt_version,created_by) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14,$15,$16,$17,$18)`,[job.matter_id,job.document_id,chunk.id,term.clauseFamily,term.sectionLabel||null,term.termType,term.party||null,term.counterparty||null,term.exactText,exactTextHash(term.exactText),term.normalizedStatement,term.triggerEvent||null,JSON.stringify(term.exceptions),term.operationalOwner||null,term.confidence,result.modelName,TERM_PROMPT_VERSION,String(job.input?.requestedBy||"system-worker")]);inserted++;}
  const output={nextChunk:state.next+1,termCount:state.termCount+inserted,rejected:state.rejected+result.rejectedUngrounded,analysisRunId:runId};
  if(output.nextChunk>=chunks.length){await query("update analysis_runs set status='SUCCEEDED',output_count=$2,rejected_ungrounded_count=$3,finished_at=now() where id=$1",[runId,output.termCount,output.rejected]);await enqueueJob({matterId:job.matter_id,jobType:"DEPENDENCY",idempotencyKey:`dependency:${job.matter_id}:${runId}`,createdBy:String(job.input?.requestedBy||"system-worker"),input:job.input});await completeJob(job.id,output);}else await continueJob(job.id,output,1);
}

async function processDependencies(job:ProcessingJob){
  if(!job.matter_id) throw new Error("DEPENDENCY job requires matter.");
  const terms=(await query<{id:string;clause_family:string;term_type:string;normalized_statement:string;trigger_event:string|null}>("select id,clause_family,term_type,normalized_statement,trigger_event from contract_terms where matter_id=$1 and review_status in ('UNREVIEWED','VALIDATED') order by created_at asc limit 250",[job.matter_id])).rows;
  if(terms.length<2){await completeJob(job.id,{dependencyCount:0});return;}
  const deps=await inferDependencies(terms.map(t=>({id:t.id,clauseFamily:t.clause_family,termType:t.term_type,normalizedStatement:t.normalized_statement,triggerEvent:t.trigger_event})));
  await query("update term_dependencies set review_status='REJECTED' where matter_id=$1 and review_status='UNREVIEWED'",[job.matter_id]);
  for(const d of deps) await query(`insert into term_dependencies(matter_id,source_term_id,target_term_id,dependency_type,rationale,confidence,created_by) values($1,$2,$3,$4,$5,$6,$7)`,[job.matter_id,d.sourceTermId,d.targetTermId,d.dependencyType,d.rationale,d.confidence,String(job.input?.requestedBy||"system-worker")]);
  await completeJob(job.id,{dependencyCount:deps.length,promptVersion:DEPENDENCY_PROMPT_VERSION});
}

async function processPrecedence(job:ProcessingJob){
  if(!job.matter_id) throw new Error("PRECEDENCE job requires matter.");
  const docs=(await query<{id:string;filename:string;document_type:string}>("select id,filename,document_type from documents where matter_id=$1 and extraction_status='EXTRACTED' order by uploaded_at asc",[job.matter_id])).rows;
  const inputs=[] as Array<{id:string;filename:string;documentType:string;text:string}>;
  for(const doc of docs){const chunks=(await query<{content:string}>(`select content from document_chunks where document_id=$1 order by case when content ~* '(preced|conflict|amend|supersed|control|incorporat|govern|order of precedence)' then 0 else 1 end,coalesce(page_number,0),chunk_index limit 12`,[doc.id])).rows;inputs.push({id:doc.id,filename:doc.filename,documentType:doc.document_type,text:chunks.map(c=>c.content).join("\n\n")});}
  if(inputs.length<2){await completeJob(job.id,{relationCount:0});return;}
  const relations=await analyzePrecedence(inputs);await query("update document_relations set review_status='REJECTED' where matter_id=$1 and review_status='UNREVIEWED'",[job.matter_id]);
  for(const r of relations) await query(`insert into document_relations(matter_id,source_document_id,target_document_id,relation_type,source_locator,rationale,confidence,created_by) values($1,$2,$3,$4,$5,$6,$7,$8)`,[job.matter_id,r.sourceDocumentId,r.targetDocumentId,r.relationType,r.sourceExcerpt,r.rationale,r.confidence,String(job.input?.requestedBy||"system-worker")]);
  await completeJob(job.id,{relationCount:relations.length,promptVersion:PRECEDENCE_PROMPT_VERSION});
}

async function processSnapshot(job:ProcessingJob){
  if(!job.matter_id) throw new Error("EXECUTIVE_SUMMARY job requires matter.");
  const findings=(await query<any>(`select id,issue,risk_level,operational_consequence,primary_position,fallback_position,no_go_position,approval_required,source_locator from findings where matter_id=$1 and review_status='VALIDATED' order by case risk_level when 'Critical' then 4 when 'High' then 3 when 'Medium' then 2 else 1 end desc,created_at desc limit 5`,[job.matter_id])).rows;
  const econ=(await query<any>("select outputs,formula_version,created_at from economics_runs where matter_id=$1 order by created_at desc limit 1",[job.matter_id])).rows[0]??null;
  const deps=(await query<any>(`select td.dependency_type,td.rationale,s.normalized_statement source,t.normalized_statement target from term_dependencies td join contract_terms s on s.id=td.source_term_id join contract_terms t on t.id=td.target_term_id where td.matter_id=$1 and td.review_status='VALIDATED' limit 12`,[job.matter_id])).rows;
  const decisions=(await query<any>("select decision_type,rationale,conditions,decision_status,required_approver_role from decisions where matter_id=$1 and decision_status='PENDING' order by requested_at asc limit 10",[job.matter_id])).rows;
  const standardsActions=findings.map((f:any)=>({issue:f.issue,primary:f.primary_position,fallback:f.fallback_position,noGo:f.no_go_position,approval:f.approval_required}));
  const state={findings,economics:econ,dependencies:deps,decisions};const sourceStateHash=createHash("sha256").update(JSON.stringify(state),"utf8").digest("hex");
  const latest=(await query<{v:number}>("select coalesce(max(snapshot_version),0)::int v from executive_snapshots where matter_id=$1",[job.matter_id])).rows[0]?.v??0;
  const result=await query<{id:string}>(`insert into executive_snapshots(matter_id,snapshot_version,top_risks,quantified_exposure,dependencies,negotiation_actions,executive_decisions,next_steps,source_state_hash,generated_by) values($1,$2,$3::jsonb,$4::jsonb,$5::jsonb,$6::jsonb,$7::jsonb,$8::jsonb,$9,$10) returning id`,[job.matter_id,latest+1,JSON.stringify(findings),JSON.stringify(econ??{}),JSON.stringify(deps),JSON.stringify(standardsActions),JSON.stringify(decisions),JSON.stringify(["Resolve pending executive decisions","Validate unreviewed high-risk findings","Confirm document precedence before execution"]),sourceStateHash,String(job.input?.requestedBy||"system-worker")]);
  await completeJob(job.id,{snapshotId:result.rows[0].id,snapshotVersion:latest+1,sourceStateHash});
}

export async function processJob(job:ProcessingJob){
  try{
    switch(job.job_type){
      case "EXTRACT":return await processExtract(job);
      case "OCR":return await processOcr(job);
      case "ANALYZE":return await processAnalysis(job);
      case "TERM_EXTRACT":return await processTerms(job);
      case "DEPENDENCY":return await processDependencies(job);
      case "PRECEDENCE":return await processPrecedence(job);
      case "EXECUTIVE_SUMMARY":return await processSnapshot(job);
      default:throw new Error(`Job type ${job.job_type} does not yet have a processor.`);
    }
  }catch(error){await failJob(job,error);throw error;}
}
