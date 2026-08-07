import { sleep } from "workflow";
import { enqueueJob, type JobType } from "@/lib/jobs";
import { claimJob, getJob } from "@/lib/jobRuntime";
import { processJob } from "@/lib/jobProcessor";
import { query } from "@/lib/db";

export const PIPELINE_VERSION = "contracttwin-pipeline-2026-08-07.v3";

type PipelineInput={documentId:string;matterId:string;sourceFingerprint:string;requestedBy:string;requestedByName:string};

async function createStage(input:PipelineInput,jobType:JobType,suffix:string,priority:number){
  "use step";
  return enqueueJob({matterId:input.matterId,documentId:["EXTRACT","OCR","ANALYZE","TERM_EXTRACT"].includes(jobType)?input.documentId:null,jobType,idempotencyKey:`${PIPELINE_VERSION}:${input.matterId}:${input.documentId}:${input.sourceFingerprint}:${suffix}`,createdBy:input.requestedBy,input:{requestedBy:input.requestedBy,requestedByName:input.requestedByName,pipelineVersion:PIPELINE_VERSION},priority,maxAttempts:3});
}

async function processStageStep(jobId:string,workerId:string){
  "use step";
  const job=await claimJob(jobId,workerId);if(!job)return getJob(jobId);
  if(job.status==="SUCCEEDED"||job.status==="FAILED"||job.status==="CANCELLED")return job;
  if(job.status!=="RUNNING")return job;
  try{await processJob(job);}catch{/* processor persisted retry/failure state */}
  return getJob(jobId);
}

async function documentExtractionState(documentId:string){
  "use step";
  const result=await query<{extraction_status:string;server_sha256:string|null}>("select extraction_status,server_sha256 from documents where id=$1 limit 1",[documentId]);
  if(!result.rows[0])throw new Error(`Document ${documentId} not found after extraction.`);
  return result.rows[0];
}

async function findOcrJob(documentId:string){
  "use step";
  const result=await query<{id:string}>(`select id from processing_jobs where document_id=$1 and job_type='OCR' order by created_at desc limit 1`,[documentId]);
  return result.rows[0]?.id??null;
}

async function findDependencyJob(matterId:string,requestedBy:string){
  "use step";
  const result=await query<{id:string}>(`select id from processing_jobs where matter_id=$1 and job_type='DEPENDENCY' and created_by=$2 order by created_at desc limit 1`,[matterId,requestedBy]);
  return result.rows[0]?.id??null;
}

async function runStage(jobId:string,workerId:string){
  for(let cycle=0;cycle<5000;cycle++){
    const job=await processStageStep(jobId,workerId);
    if(!job)throw new Error(`Job ${jobId} not found.`);
    if(job.status==="SUCCEEDED")return job;
    if(job.status==="FAILED"||job.status==="CANCELLED")throw new Error(`Job ${jobId} ended with ${job.status}.`);
    await sleep(job.status==="WAITING_EXTERNAL"?"5s":"1s");
  }
  throw new Error(`Job ${jobId} exceeded the pipeline cycle limit.`);
}

export async function fullContractPipeline(input:PipelineInput){
  "use workflow";
  const worker=`pipeline:${input.documentId}`;
  const extraction=await createStage(input,"EXTRACT","extract",10);await runStage(extraction.id,worker);
  const extractionState=await documentExtractionState(input.documentId);
  if(extractionState.extraction_status==="OCR_REQUIRED"){
    const ocrJobId=await findOcrJob(input.documentId);if(!ocrJobId)throw new Error("Extraction requires OCR but no OCR job was created.");
    await runStage(ocrJobId,worker);const afterOcr=await documentExtractionState(input.documentId);
    if(afterOcr.extraction_status!=="EXTRACTED")throw new Error(`OCR completed without producing an EXTRACTED source state (${afterOcr.extraction_status}).`);
  }else if(extractionState.extraction_status!=="EXTRACTED")throw new Error(`Source extraction did not reach EXTRACTED state (${extractionState.extraction_status}).`);
  const risk=await createStage(input,"ANALYZE","risk",30);await runStage(risk.id,worker);
  const terms=await createStage(input,"TERM_EXTRACT","terms",40);await runStage(terms.id,worker);
  const dependencyJobId=await findDependencyJob(input.matterId,input.requestedBy);if(dependencyJobId)await runStage(dependencyJobId,worker);
  const precedence=await createStage(input,"PRECEDENCE","precedence",50);await runStage(precedence.id,worker);
  const snapshot=await createStage(input,"EXECUTIVE_SUMMARY","snapshot",60);const snapshotResult=await runStage(snapshot.id,worker);
  return {pipelineVersion:PIPELINE_VERSION,documentId:input.documentId,matterId:input.matterId,status:"SUCCEEDED",snapshot:snapshotResult.output};
}
