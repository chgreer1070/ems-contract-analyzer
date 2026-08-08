import { query, withTransaction } from "@/lib/db";
import { safeOperationalFailure, safePersistedFailureForDisplay } from "@/lib/safeErrors";

export type JobType = "MALWARE_SCAN" | "OCR" | "EXTRACT" | "ANALYZE" | "TERM_EXTRACT" | "DEPENDENCY" | "PRECEDENCE" | "EXECUTIVE_SUMMARY" | "VALIDATION";
export type JobStatus = "QUEUED" | "RUNNING" | "WAITING_EXTERNAL" | "SUCCEEDED" | "FAILED" | "CANCELLED";
export type ProcessingJob = {
  id: string;
  matter_id: string | null;
  document_id: string | null;
  job_type: JobType;
  status: JobStatus;
  attempts: number;
  max_attempts: number;
  input: Record<string, unknown>;
  output: Record<string, unknown> | null;
  external_operation_url: string | null;
};

export async function enqueueJob(args: {
  matterId?: string | null;
  documentId?: string | null;
  jobType: JobType;
  idempotencyKey: string;
  createdBy: string;
  input?: Record<string, unknown>;
  priority?: number;
  maxAttempts?: number;
}) {
  const result = await query<ProcessingJob>(
    `insert into processing_jobs (matter_id, document_id, job_type, idempotency_key, created_by, input, priority, max_attempts)
     values ($1,$2,$3,$4,$5,$6::jsonb,$7,$8)
     on conflict (idempotency_key) do update set
       status=case when processing_jobs.status in ('FAILED','CANCELLED') then 'QUEUED' else processing_jobs.status end,
       attempts=case when processing_jobs.status in ('FAILED','CANCELLED') then 0 else processing_jobs.attempts end,
       max_attempts=case when processing_jobs.status in ('FAILED','CANCELLED') then excluded.max_attempts else processing_jobs.max_attempts end,
       input=case when processing_jobs.status in ('FAILED','CANCELLED') then excluded.input else processing_jobs.input end,
       output=case when processing_jobs.status in ('FAILED','CANCELLED') then '{}'::jsonb else processing_jobs.output end,
       external_operation_url=case when processing_jobs.status in ('FAILED','CANCELLED') then null else processing_jobs.external_operation_url end,
       error_message=case when processing_jobs.status in ('FAILED','CANCELLED') then null else processing_jobs.error_message end,
       next_attempt_at=case when processing_jobs.status in ('FAILED','CANCELLED') then now() else processing_jobs.next_attempt_at end,
       finished_at=case when processing_jobs.status in ('FAILED','CANCELLED') then null else processing_jobs.finished_at end,
       started_at=case when processing_jobs.status in ('FAILED','CANCELLED') then null else processing_jobs.started_at end,
       locked_by=case when processing_jobs.status in ('FAILED','CANCELLED') then null else processing_jobs.locked_by end,
       locked_at=case when processing_jobs.status in ('FAILED','CANCELLED') then null else processing_jobs.locked_at end
     returning id, matter_id, document_id, job_type, status, attempts, max_attempts, input, output, external_operation_url`,
    [args.matterId ?? null, args.documentId ?? null, args.jobType, args.idempotencyKey, args.createdBy, JSON.stringify(args.input ?? {}), args.priority ?? 100, args.maxAttempts ?? 3]
  );
  return result.rows[0];
}

export async function claimNextJob(workerId: string, allowedTypes?: JobType[]) {
  return withTransaction(async (client) => {
    const result = await client.query<ProcessingJob>(
      `select id, matter_id, document_id, job_type, status, attempts, max_attempts, input, output, external_operation_url
         from processing_jobs
        where status in ('QUEUED','WAITING_EXTERNAL')
          and next_attempt_at <= now()
          and attempts < max_attempts
          and ($1::text[] is null or job_type = any($1::text[]))
        order by priority asc, created_at asc
        for update skip locked
        limit 1`,
      [allowedTypes?.length ? allowedTypes : null]
    );
    const job = result.rows[0];
    if (!job) return null;
    const consumesAttempt = job.status === "QUEUED";
    await client.query(
      `update processing_jobs
          set status='RUNNING', attempts=attempts + $3, locked_by=$2, locked_at=now(), started_at=coalesce(started_at,now())
        where id=$1`,
      [job.id, workerId, consumesAttempt ? 1 : 0]
    );
    return { ...job, status: "RUNNING" as const, attempts: job.attempts + (consumesAttempt ? 1 : 0) };
  });
}

export async function continueJob(jobId: string, output: Record<string, unknown> = {}, delaySeconds = 1) {
  await query(
    `update processing_jobs set status='WAITING_EXTERNAL', output=$2::jsonb, external_operation_url=null,
      locked_by=null, locked_at=null, next_attempt_at=now() + make_interval(secs => $3) where id=$1`,
    [jobId, JSON.stringify(output), Math.max(0, delaySeconds)]
  );
}

export async function waitExternal(jobId: string, operationUrl: string, output: Record<string, unknown> = {}, delaySeconds = 5) {
  await query(
    `update processing_jobs set status='WAITING_EXTERNAL', external_operation_url=$2, output=$3::jsonb,
      locked_by=null, locked_at=null, next_attempt_at=now() + make_interval(secs => $4) where id=$1`,
    [jobId, operationUrl, JSON.stringify(output), Math.max(1, delaySeconds)]
  );
}

export async function completeJob(jobId: string, output: Record<string, unknown> = {}) {
  await query(`update processing_jobs set status='SUCCEEDED', output=$2::jsonb, error_message=null, finished_at=now(), locked_by=null, locked_at=null where id=$1`, [jobId, JSON.stringify(output)]);
}

export async function failJob(job: ProcessingJob, error: unknown, retryable = true) {
  const retry = retryable && job.attempts < job.max_attempts;
  const failure=safeOperationalFailure(
    error,
    retry
      ? "A processing dependency was unavailable; a retry was scheduled."
      : retryable
        ? "A processing dependency remained unavailable after the retry limit."
        : "A governed processing control rejected the job."
  );
  await query(
    `update processing_jobs
        set status=$2, error_message=$3, locked_by=null, locked_at=null,
            next_attempt_at=case when $2='QUEUED' then now() + make_interval(secs => least(300, 5 * (2 ^ greatest(attempts-1,0)))) else next_attempt_at end,
            finished_at=case when $2='FAILED' then now() else null end
      where id=$1`,
    [job.id, retry ? "QUEUED" : "FAILED", failure.message]
  );
  return {status:retry ? "QUEUED" as const : "FAILED" as const,message:failure.message};
}

export async function listMatterJobs(matterId: string) {
  const result = await query(`select id, document_id, job_type, status, attempts, max_attempts, error_message, output, created_at, started_at, finished_at from processing_jobs where matter_id=$1 order by created_at desc limit 100`, [matterId]);
  return result.rows.map(row=>({...row,error_message:row.error_message?safePersistedFailureForDisplay(row.error_message):null}));
}
