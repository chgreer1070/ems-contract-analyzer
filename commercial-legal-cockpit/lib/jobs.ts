import { query, withTransaction } from "@/lib/db";

export type JobType = "OCR" | "EXTRACT" | "ANALYZE" | "TERM_EXTRACT" | "DEPENDENCY" | "PRECEDENCE" | "EXECUTIVE_SUMMARY" | "VALIDATION";
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
}) {
  const result = await query<ProcessingJob>(
    `insert into processing_jobs (matter_id, document_id, job_type, idempotency_key, created_by, input, priority)
     values ($1,$2,$3,$4,$5,$6::jsonb,$7)
     on conflict (idempotency_key) do update set idempotency_key = excluded.idempotency_key
     returning id, matter_id, document_id, job_type, status, attempts, max_attempts, input, output, external_operation_url`,
    [args.matterId ?? null, args.documentId ?? null, args.jobType, args.idempotencyKey, args.createdBy, JSON.stringify(args.input ?? {}), args.priority ?? 100]
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
    await client.query(
      `update processing_jobs
          set status='RUNNING', attempts=attempts+1, locked_by=$2, locked_at=now(), started_at=coalesce(started_at,now())
        where id=$1`,
      [job.id, workerId]
    );
    return { ...job, status: "RUNNING" as const, attempts: job.attempts + 1 };
  });
}

export async function waitExternal(jobId: string, operationUrl: string, output: Record<string, unknown> = {}) {
  await query(
    `update processing_jobs set status='WAITING_EXTERNAL', external_operation_url=$2, output=$3::jsonb,
      locked_by=null, locked_at=null, next_attempt_at=now() + interval '5 seconds' where id=$1`,
    [jobId, operationUrl, JSON.stringify(output)]
  );
}

export async function completeJob(jobId: string, output: Record<string, unknown> = {}) {
  await query(`update processing_jobs set status='SUCCEEDED', output=$2::jsonb, finished_at=now(), locked_by=null, locked_at=null where id=$1`, [jobId, JSON.stringify(output)]);
}

export async function failJob(job: ProcessingJob, error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const retry = job.attempts < job.max_attempts;
  await query(
    `update processing_jobs
        set status=$2, error_message=$3, locked_by=null, locked_at=null,
            next_attempt_at=case when $2='QUEUED' then now() + make_interval(secs => least(300, 5 * (2 ^ greatest(attempts-1,0)))) else next_attempt_at end,
            finished_at=case when $2='FAILED' then now() else null end
      where id=$1`,
    [job.id, retry ? "QUEUED" : "FAILED", message.slice(0, 4000)]
  );
}

export async function listMatterJobs(matterId: string) {
  const result = await query(`select id, document_id, job_type, status, attempts, max_attempts, error_message, created_at, started_at, finished_at from processing_jobs where matter_id=$1 order by created_at desc limit 100`, [matterId]);
  return result.rows;
}
