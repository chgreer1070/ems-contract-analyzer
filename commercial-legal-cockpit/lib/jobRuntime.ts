import { query, withTransaction } from "@/lib/db";
import { jobLeaseDurationSeconds, jobLeaseRecoveryEnabled } from "@/lib/jobLease";
import type { ProcessingJob } from "@/lib/jobs";

type RuntimeJob = ProcessingJob & { next_attempt_at: Date };

const runtimeProjection = `id,matter_id,document_id,job_type,status,attempts,max_attempts,input,output,
  external_operation_url,next_attempt_at,locked_by,locked_at,lease_generation,last_heartbeat_at,lease_expires_at`;

function due(at: Date | string | null | undefined) {
  return !at || new Date(at).getTime() <= Date.now();
}

export async function getJob(jobId: string) {
  const result = await query<RuntimeJob>(`select ${runtimeProjection} from processing_jobs where id=$1 limit 1`, [jobId]);
  return result.rows[0] ?? null;
}

export async function claimJob(jobId: string, workerId: string) {
  if (!workerId.trim()) throw new Error("Processing worker identity is required.");
  return withTransaction(async client => {
    const result = await client.query<RuntimeJob>(`select ${runtimeProjection} from processing_jobs where id=$1 for update`, [jobId]);
    const job = result.rows[0];
    if (!job) return null;
    if (job.status === "SUCCEEDED" || job.status === "FAILED" || job.status === "CANCELLED") return job;

    if (job.status === "RUNNING") {
      if (!jobLeaseRecoveryEnabled()) return null;
      if (job.attempts >= job.max_attempts) {
        const failed = await client.query<RuntimeJob>(
          `update processing_jobs
              set status='FAILED', error_message='Stale execution lease exhausted retry budget', finished_at=now(),
                  locked_by=null, locked_at=null, last_heartbeat_at=null, lease_expires_at=null
            where id=$1 and status='RUNNING' and locked_by is not distinct from $2 and lease_generation=$3
              and lease_expires_at<=now()
            returning ${runtimeProjection}`,
          [jobId, job.locked_by, job.lease_generation]
        );
        return failed.rows[0] ?? null;
      }
      const recovered = await client.query<RuntimeJob>(
        `update processing_jobs
            set status='RUNNING', attempts=attempts+1, locked_by=$2, locked_at=now(),
                lease_generation=lease_generation+1, last_heartbeat_at=now(),
                lease_expires_at=now() + make_interval(secs => $4), error_message='Recovered expired execution lease'
          where id=$1 and status='RUNNING' and locked_by is not distinct from $3 and lease_generation=$5
            and lease_expires_at<=now()
          returning ${runtimeProjection}`,
        [jobId, workerId, job.locked_by, jobLeaseDurationSeconds(), job.lease_generation]
      );
      return recovered.rows[0] ?? null;
    }

    if (!due(job.next_attempt_at)) return job;
    const consumesAttempt = job.status === "QUEUED";
    if (consumesAttempt && job.attempts >= job.max_attempts) {
      const failed = await client.query<RuntimeJob>(
        `update processing_jobs
            set status='FAILED', error_message='Maximum retry attempts exceeded', finished_at=now(),
                locked_by=null, locked_at=null, last_heartbeat_at=null, lease_expires_at=null
          where id=$1 and status='QUEUED' and lease_generation=$2
          returning ${runtimeProjection}`,
        [jobId, job.lease_generation]
      );
      return failed.rows[0] ?? null;
    }

    const claimed = await client.query<RuntimeJob>(
      `update processing_jobs
          set status='RUNNING', attempts=attempts+$3, locked_by=$2, locked_at=now(),
              lease_generation=lease_generation+1, last_heartbeat_at=now(),
              lease_expires_at=now() + make_interval(secs => $4), started_at=coalesce(started_at,now())
        where id=$1 and status=$5 and lease_generation=$6 and next_attempt_at<=now()
        returning ${runtimeProjection}`,
      [jobId, workerId, consumesAttempt ? 1 : 0, jobLeaseDurationSeconds(), job.status, job.lease_generation]
    );
    return claimed.rows[0] ?? null;
  });
}
