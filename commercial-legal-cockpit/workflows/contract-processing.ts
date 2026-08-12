import { randomUUID } from "node:crypto";
import { sleep } from "workflow";
import { claimJob, getJob } from "@/lib/jobRuntime";
import { processJob } from "@/lib/jobProcessor";

async function processJobStep(jobId:string,workerId:string){
  "use step";
  const claimed=await claimJob(jobId,workerId);
  if(!claimed)return getJob(jobId);
  if(claimed.status==="SUCCEEDED"||claimed.status==="FAILED"||claimed.status==="CANCELLED")return claimed;
  if(claimed.status!=="RUNNING")return claimed;
  try{await processJob(claimed);}catch{/* processJob records retry/failure state */}
  return getJob(jobId);
}

async function createWorkerId(jobId:string){
  "use step";
  return `workflow:${jobId}:${randomUUID()}`;
}

export async function contractProcessingWorkflow(jobId:string){
  "use workflow";
  const workerId=await createWorkerId(jobId);
  for(let cycle=0;cycle<5000;cycle++){
    const job=await processJobStep(jobId,workerId);
    if(!job)throw new Error(`Processing job ${jobId} was deleted or never existed.`);
    if(job.status==="SUCCEEDED")return {jobId,status:job.status,output:job.output};
    if(job.status==="FAILED"||job.status==="CANCELLED")return {jobId,status:job.status,output:job.output};
    await sleep(job.status==="WAITING_EXTERNAL"&&job.external_operation_url?"5s":"1s");
  }
  throw new Error(`Processing job ${jobId} exceeded workflow cycle safety limit.`);
}
