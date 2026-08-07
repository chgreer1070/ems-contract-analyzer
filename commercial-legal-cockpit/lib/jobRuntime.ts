import { query, withTransaction } from "@/lib/db";
import type { ProcessingJob } from "@/lib/jobs";

type RuntimeJob = ProcessingJob & { next_attempt_at: Date; locked_by: string | null };

export async function getJob(jobId:string){
  const result=await query<RuntimeJob>(`select id,matter_id,document_id,job_type,status,attempts,max_attempts,input,output,external_operation_url,next_attempt_at,locked_by from processing_jobs where id=$1 limit 1`,[jobId]);
  return result.rows[0]??null;
}

export async function claimJob(jobId:string,workerId:string){
  return withTransaction(async client=>{
    const result=await client.query<RuntimeJob>(`select id,matter_id,document_id,job_type,status,attempts,max_attempts,input,output,external_operation_url,next_attempt_at,locked_by from processing_jobs where id=$1 for update`,[jobId]);
    const job=result.rows[0];if(!job)return null;
    if(job.status==="SUCCEEDED"||job.status==="FAILED"||job.status==="CANCELLED")return job;
    if(job.status==="RUNNING"&&job.locked_by&&job.locked_by!==workerId)return null;
    const consumesAttempt=job.status==="QUEUED";
    if(consumesAttempt&&job.attempts>=job.max_attempts){await client.query("update processing_jobs set status='FAILED',error_message='Maximum retry attempts exceeded',finished_at=now() where id=$1",[jobId]);return {...job,status:"FAILED" as const};}
    if(job.next_attempt_at&&new Date(job.next_attempt_at).getTime()>Date.now())return job;
    await client.query(`update processing_jobs set status='RUNNING',attempts=attempts+$3,locked_by=$2,locked_at=now(),started_at=coalesce(started_at,now()) where id=$1`,[jobId,workerId,consumesAttempt?1:0]);
    return {...job,status:"RUNNING" as const,locked_by:workerId,attempts:job.attempts+(consumesAttempt?1:0)};
  });
}
