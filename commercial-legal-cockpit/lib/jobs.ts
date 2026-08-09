import type { PoolClient } from "pg";
import { query, withTransaction } from "@/lib/db";
import { jobLeaseDurationSeconds } from "@/lib/jobLease";
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
  locked_by: string | null;
  locked_at: Date | null;
  lease_generation: number;
  last_heartbeat_at: Date | null;
  lease_expires_at: Date | null;
};

export type EnqueueJobArgs = {
  matterId?: string | null;
  documentId?: string | null;
  jobType: JobType;
  idempotencyKey: string;
  createdBy: string;
  input?: Record<string, unknown>;
  priority?: number;
  maxAttempts?: number;
};

const processingJobProjection = `id, matter_id, document_id, job_type, status, attempts, max_attempts, input, output,
  external_operation_url, locked_by, locked_at, lease_generation, last_heartbeat_at, lease_expires_at`;

const enqueueSql = `insert into processing_jobs (matter_id, document_id, job_type, idempotency_key, created_by, input, priority, max_attempts)
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
    locked_at=case when processing_jobs.status in ('FAILED','CANCELLED') then null else processing_jobs.locked_at end,
    last_heartbeat_at=case when processing_jobs.status in ('FAILED','CANCELLED') then null else processing_jobs.last_heartbeat_at end,
    lease_expires_at=case when processing_jobs.status in ('FAILED','CANCELLED') then null else processing_jobs.lease_expires_at end
  returning ${processingJobProjection}`;

function enqueueValues(args: EnqueueJobArgs) {
  return [args.matterId ?? null, args.documentId ?? null, args.jobType, args.idempotencyKey, args.createdBy, JSON.stringify(args.input ?? {}), args.priority ?? 100, args.maxAttempts ?? 3];
}

export async function enqueueJobWithClient(client: PoolClient, args: EnqueueJobArgs) {
  const result = await client.query<ProcessingJob>(enqueueSql, enqueueValues(args));
  return result.rows[0];
}

export async function enqueueJob(args: EnqueueJobArgs) {
  const result = await query<ProcessingJob>(enqueueSql, enqueueValues(args));
  return result.rows[0];
}

export class JobLeaseLostError extends Error {
  constructor(jobId: string) {
    super(`Processing job ${jobId} no longer owns its execution lease.`);
    this.name = "JobLeaseLostError";
  }
}

function requireFence(job: ProcessingJob) {
  if (job.status !== "RUNNING" || !job.locked_by || !Number.isSafeInteger(job.lease_generation) || job.lease_generation < 1) {
    throw new JobLeaseLostError(job.id);
  }
  return { workerId: job.locked_by, generation: job.lease_generation };
}

export async function assertJobLease(client: PoolClient, job: ProcessingJob) {
  const fence = requireFence(job);
  const result = await client.query(
    `update processing_jobs
        set last_heartbeat_at=now(), lease_expires_at=now() + make_interval(secs => $4)
      where id=$1 and status='RUNNING' and locked_by=$2 and lease_generation=$3 and lease_expires_at>now()
      returning id`,
    [job.id, fence.workerId, fence.generation, jobLeaseDurationSeconds()]
  );
  if (result.rowCount !== 1) throw new JobLeaseLostError(job.id);
}

export async function heartbeatJob(job: ProcessingJob) {
  const fence = requireFence(job);
  const result = await query(
    `update processing_jobs
        set last_heartbeat_at=now(), lease_expires_at=now() + make_interval(secs => $4)
      where id=$1 and status='RUNNING' and locked_by=$2 and lease_generation=$3 and lease_expires_at>now()
      returning id`,
    [job.id, fence.workerId, fence.generation, jobLeaseDurationSeconds()]
  );
  if (result.rowCount !== 1) throw new JobLeaseLostError(job.id);
}

type FencedTransition = {
  status: "QUEUED" | "WAITING_EXTERNAL" | "SUCCEEDED" | "FAILED";
  output?: Record<string, unknown> | null;
  operationUrl?: string | null;
  errorMessage?: string | null;
  delaySeconds?: number;
};

export async function transitionJobWithFence(client: PoolClient, job: ProcessingJob, transition: FencedTransition) {
  const fence = requireFence(job);
  const delaySeconds = Math.max(0, transition.delaySeconds ?? 0);
  const terminal = transition.status === "SUCCEEDED" || transition.status === "FAILED";
  const result = await client.query(
    `update processing_jobs
        set status=$4,
            output=coalesce($5::jsonb,output),
            external_operation_url=$6,
            error_message=$7,
            next_attempt_at=case when $4 in ('QUEUED','WAITING_EXTERNAL') then now() + make_interval(secs => $8) else next_attempt_at end,
            finished_at=case when $9 then now() else null end,
            locked_by=null, locked_at=null, last_heartbeat_at=null, lease_expires_at=null
      where id=$1 and status='RUNNING' and locked_by=$2 and lease_generation=$3 and lease_expires_at>now()
      returning id`,
    [
      job.id,
      fence.workerId,
      fence.generation,
      transition.status,
      transition.output === undefined || transition.output === null ? null : JSON.stringify(transition.output),
      transition.operationUrl ?? null,
      transition.errorMessage ?? null,
      delaySeconds,
      terminal
    ]
  );
  if (result.rowCount !== 1) throw new JobLeaseLostError(job.id);
}

export async function claimNextJob(workerId: string, allowedTypes?: JobType[]) {
  return withTransaction(async (client) => {
    const result = await client.query<ProcessingJob>(
      `select ${processingJobProjection}
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
    const claimed = await client.query<ProcessingJob>(
      `update processing_jobs
          set status='RUNNING', attempts=attempts + $3, locked_by=$2, locked_at=now(),
              lease_generation=lease_generation+1, last_heartbeat_at=now(),
              lease_expires_at=now() + make_interval(secs => $4), started_at=coalesce(started_at,now())
        where id=$1 and status=$5 and lease_generation=$6
        returning ${processingJobProjection}`,
      [job.id, workerId, consumesAttempt ? 1 : 0, jobLeaseDurationSeconds(), job.status, job.lease_generation]
    );
    return claimed.rows[0] ?? null;
  });
}

export async function continueJob(job: ProcessingJob, output: Record<string, unknown> = {}, delaySeconds = 1) {
  await withTransaction(client => transitionJobWithFence(client, job, { status: "WAITING_EXTERNAL", output, delaySeconds }));
}

export async function waitExternal(job: ProcessingJob, operationUrl: string, output: Record<string, unknown> = {}, delaySeconds = 5) {
  await withTransaction(client => transitionJobWithFence(client, job, { status: "WAITING_EXTERNAL", operationUrl, output, delaySeconds: Math.max(1, delaySeconds) }));
}

export async function completeJob(job: ProcessingJob, output: Record<string, unknown> = {}) {
  await withTransaction(client => transitionJobWithFence(client, job, { status: "SUCCEEDED", output }));
}

export async function failJob(job: ProcessingJob, error: unknown, retryable = true, preserveExternalOperation = Boolean(job.external_operation_url)) {
  const retry = retryable && job.attempts < job.max_attempts;
  const failure = safeOperationalFailure(
    error,
    retry
      ? "A processing dependency was unavailable; a retry was scheduled."
      : retryable
        ? "A processing dependency remained unavailable after the retry limit."
        : "A governed processing control rejected the job."
  );
  await withTransaction(client => transitionJobWithFence(client, job, {
    status: retry ? "QUEUED" : "FAILED",
    operationUrl: retry && preserveExternalOperation ? job.external_operation_url : null,
    errorMessage: failure.message,
    delaySeconds: retry ? Math.min(300, 5 * (2 ** Math.max(job.attempts - 1, 0))) : 0
  }));
  return { status: retry ? "QUEUED" as const : "FAILED" as const, message: failure.message };
}

export async function listMatterJobs(matterId: string) {
  const result = await query(`select id, document_id, job_type, status, attempts, max_attempts, error_message, output, created_at, started_at, finished_at from processing_jobs where matter_id=$1 order by created_at desc limit 100`, [matterId]);
  return result.rows.map(row => ({ ...row, error_message: row.error_message ? safePersistedFailureForDisplay(row.error_message) : null }));
}
