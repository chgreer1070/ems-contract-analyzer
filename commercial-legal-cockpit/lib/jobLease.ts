const DEFAULT_JOB_LEASE_SECONDS = 900;
const MIN_JOB_LEASE_SECONDS = 60;
const MAX_JOB_LEASE_SECONDS = 3600;

export function jobLeaseDurationSeconds(configured: string | number | undefined = process.env.JOB_LEASE_SECONDS ?? process.env.JOB_LOCK_STALE_SECONDS) {
  const parsed = Number(configured ?? DEFAULT_JOB_LEASE_SECONDS);
  if (!Number.isFinite(parsed)) return DEFAULT_JOB_LEASE_SECONDS;
  return Math.min(MAX_JOB_LEASE_SECONDS, Math.max(MIN_JOB_LEASE_SECONDS, Math.trunc(parsed)));
}

export function jobHeartbeatIntervalMillis(leaseSeconds = jobLeaseDurationSeconds()) {
  return Math.max(5_000, Math.min(30_000, Math.floor(leaseSeconds * 1000 / 3)));
}

export function jobLeaseRecoveryEnabled(configured: string | undefined = process.env.JOB_LEASE_RECOVERY_ENABLED) {
  return configured === "true";
}
