import { randomUUID } from "node:crypto";
import { sleep } from "workflow";
import { enqueueJob, type JobType } from "@/lib/jobs";
import { claimJob, getJob } from "@/lib/jobRuntime";
import { processJob } from "@/lib/jobProcessor";
import { query } from "@/lib/db";
import { PIPELINE_VERSION } from "@/lib/pipelineVersions";

export { PIPELINE_VERSION } from "@/lib/pipelineVersions";

type PipelineInput={documentId:string;matterId:string;sourceFingerprint:string;requestedBy:string;requestedByName:string};

async function createStage(input:PipelineInput,jobType:JobType,suffix:string,priority:number){
  "use step";
  return enqueueJob({matterId:input.matterId,documentId:["MALWARE_SCAN","EXTRACT","OCR","ANALYZE","TERM_EXTRACT"].includes(jobType)?input.documentId:null,jobType,idempotencyKey:`${PIPELINE_VERSION}:${input.matterId}:${input.documentId}:${input.sourceFingerprint}:${suffix}`,createdBy:input.requestedBy,input:{requestedBy:input.requestedBy,requestedByName:input.requestedByName,pipelineVersion:PIPELINE_VERSION},priority,maxAttempts:3});
}

async function createWorkerId(documentId:string){
  "use step";
  return `pipeline:${documentId}:${randomUUID()}`;
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

async function runStage(jobId:string,workerId:string){
  for(let cycle=0;cycle<5000;cycle++){
    const job=await processStageStep(jobId,workerId);
    if(!job)throw new Error(`Job ${jobId} not found.`);
    if(job.status==="SUCCEEDED")return job;
    if(job.status==="FAILED"||job.status==="CANCELLED")throw new Error(`Job ${jobId} ended with ${job.status}.`);
    await sleep(job.status==="WAITING_EXTERNAL"&&job.external_operation_url?"5s":"1s");
  }
  throw new Error(`Job ${jobId} exceeded the pipeline cycle limit.`);
}

export async function fullContractPipeline(input:PipelineInput){
  "use workflow";
  const worker=await createWorkerId(input.documentId);
  const security=await createStage(input,"MALWARE_SCAN","malware",5);await runStage(security.id,worker);
  const extraction=await createStage(input,"EXTRACT","extract",10);const completedExtraction=await runStage(extraction.id,worker);
  const extractionState=await documentExtractionState(input.documentId);
  if(extractionState.extraction_status==="OCR_REQUIRED"){
    const ocrJobId=typeof completedExtraction.output?.ocrJobId==="string"?completedExtraction.output.ocrJobId:null;if(!ocrJobId)throw new Error("Extraction requires OCR but did not return its exact OCR job identifier.");
    await runStage(ocrJobId,worker);const afterOcr=await documentExtractionState(input.documentId);
    if(afterOcr.extraction_status!=="EXTRACTED")throw new Error(`OCR completed without producing an EXTRACTED source state (${afterOcr.extraction_status}).`);
  }else if(extractionState.extraction_status!=="EXTRACTED")throw new Error(`Source extraction did not reach EXTRACTED state (${extractionState.extraction_status}).`);
  const risk=await createStage(input,"ANALYZE","risk",30);await runStage(risk.id,worker);
  const termStage=await createStage(input,"TERM_EXTRACT","terms",40);const terms=await runStage(termStage.id,worker);
  const dependencyJobId=typeof terms.output?.dependencyJobId==="string"?terms.output.dependencyJobId:null;
  if(dependencyJobId)await runStage(dependencyJobId,worker);
  const precedence=await createStage(input,"PRECEDENCE","precedence",50);await runStage(precedence.id,worker);
  return {pipelineVersion:PIPELINE_VERSION,documentId:input.documentId,matterId:input.matterId,status:"SUCCEEDED",humanReviewRequired:true,snapshotGenerated:false};
}
