alter table public.processing_jobs
  add column if not exists lease_generation integer not null default 0,
  add column if not exists last_heartbeat_at timestamptz,
  add column if not exists lease_expires_at timestamptz;

update public.processing_jobs
set lease_generation = case when status = 'RUNNING' then greatest(lease_generation, 1) else lease_generation end,
    locked_by = case when status = 'RUNNING' then coalesce(locked_by, 'migration-recovery') else null end,
    locked_at = case when status = 'RUNNING' then coalesce(locked_at, now()) else null end,
    last_heartbeat_at = case when status = 'RUNNING' then least(coalesce(last_heartbeat_at, locked_at, now() - interval '2 seconds'), now() - interval '2 seconds') else null end,
    lease_expires_at = case when status = 'RUNNING' then now() - interval '1 second' else null end;

alter table public.processing_jobs
  drop constraint if exists processing_jobs_lease_generation_check,
  add constraint processing_jobs_lease_generation_check check (lease_generation >= 0),
  drop constraint if exists processing_jobs_lease_state_check,
  add constraint processing_jobs_lease_state_check check (
    (
      status = 'RUNNING'
      and lease_generation > 0
      and locked_by is not null
      and locked_at is not null
      and last_heartbeat_at is not null
      and lease_expires_at is not null
      and lease_expires_at > last_heartbeat_at
    )
    or
    (
      status <> 'RUNNING'
      and locked_by is null
      and locked_at is null
      and last_heartbeat_at is null
      and lease_expires_at is null
    )
  );

create or replace function public.enforce_processing_job_lease_fence()
returns trigger
language plpgsql
set search_path = pg_catalog, public, pg_temp
as $$
begin
  -- Expand-compatible bridge for workers deployed before lease fencing. Their
  -- claim SQL supplies the owner/timestamp but not generation/heartbeat fields;
  -- normalize that write into a complete fenced lease while the new worker is
  -- staged. A later contract migration may remove this bridge only after old
  -- worker invocations are proven drained.
  if old.status <> 'RUNNING' and new.status = 'RUNNING'
     and new.lease_generation = old.lease_generation then
    if new.locked_by is null or new.locked_at is null then
      raise exception 'Entering RUNNING requires a recorded processing-job lease owner and lock timestamp.';
    end if;
    new.lease_generation := old.lease_generation + 1;
    new.last_heartbeat_at := coalesce(new.last_heartbeat_at, new.locked_at, clock_timestamp());
    new.lease_expires_at := new.last_heartbeat_at + interval '15 minutes';
  end if;

  -- A pre-fencing worker adjudicates staleness from locked_at and application
  -- time. New fenced workers deliberately do not refresh locked_at, so allowing
  -- that legacy RUNNING-to-RUNNING update would let an old bundle steal a live
  -- lease. Mixed-bundle rollout therefore preserves ordinary legacy claims and
  -- completion, but disables legacy stale-owner takeover. Recovery stays off
  -- until old bundles are proven drained, after which only the generation-CAS
  -- recovery path may advance ownership.
  if old.status = 'RUNNING' and new.status = 'RUNNING'
     and new.locked_by is distinct from old.locked_by
     and new.lease_generation = old.lease_generation then
    raise exception 'Legacy processing-job owner takeover is disabled during lease-fencing rollout';
  end if;

  if old.status = 'RUNNING' and new.status <> 'RUNNING'
     and new.locked_by is null and new.locked_at is null then
    new.last_heartbeat_at := null;
    new.lease_expires_at := null;
  end if;

  if new.lease_generation < old.lease_generation then
    raise exception 'Processing-job lease generation cannot decrease.';
  end if;

  if new.lease_generation > old.lease_generation + 1 then
    raise exception 'Processing-job lease generation may advance by only one generation.';
  end if;

  if new.lease_generation = old.lease_generation + 1 and new.status <> 'RUNNING' then
    raise exception 'Processing-job lease generation may advance only when entering a RUNNING lease.';
  end if;

  if old.status <> 'RUNNING' and new.status = 'RUNNING' and new.lease_generation <> old.lease_generation + 1 then
    raise exception 'Entering RUNNING requires a new processing-job lease generation.';
  end if;

  if old.status = 'RUNNING' and new.status = 'RUNNING'
     and new.locked_by is distinct from old.locked_by
     and new.lease_generation <> old.lease_generation + 1 then
    raise exception 'Changing processing-job lease owner requires a new generation.';
  end if;

  return new;
end;
$$;

drop trigger if exists trg_processing_job_lease_fence on public.processing_jobs;
create trigger trg_processing_job_lease_fence
before update on public.processing_jobs
for each row execute function public.enforce_processing_job_lease_fence();

create index if not exists idx_processing_jobs_expired_running_lease
  on public.processing_jobs(lease_expires_at, priority, created_at)
  where status = 'RUNNING';
