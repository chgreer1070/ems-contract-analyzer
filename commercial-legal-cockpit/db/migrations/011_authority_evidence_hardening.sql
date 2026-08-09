-- Bind legal dispositions to active counsel authority and persist decision evidence.

alter table public.decisions
  add column if not exists disposition_note text,
  add column if not exists evidence_protocol_version integer not null default 0;

alter table public.decisions drop constraint if exists decisions_evidence_protocol_version_check;
alter table public.decisions
  add constraint decisions_evidence_protocol_version_check
  check (evidence_protocol_version in (0,1));

do $$
begin
  if not exists (
    select 1
      from pg_catalog.pg_constraint constraint_record
      join pg_catalog.pg_class relation_record
        on relation_record.oid=constraint_record.conrelid
      join pg_catalog.pg_namespace namespace_record
        on namespace_record.oid=relation_record.relnamespace
     where namespace_record.nspname='public'
       and relation_record.relname='decisions'
       and constraint_record.conname='decisions_terminal_disposition_note_required'
  ) then
    alter table public.decisions
      add constraint decisions_terminal_disposition_note_required
      check (
        evidence_protocol_version=0
        or decision_status not in ('APPROVED','REJECTED')
        or char_length(btrim(coalesce(disposition_note,''))) between 12 and 4000
      ) not valid;
  end if;
end;
$$;

create or replace function public.enforce_human_review_record() returns trigger
language plpgsql
set search_path = pg_catalog, public, pg_temp
as $$
begin
  if new.review_status in ('VALIDATED','REJECTED') then
    if new.reviewed_by is null or new.reviewed_at is null or
       char_length(btrim(coalesce(new.review_note,'')))<12 then
      raise exception 'Human disposition requires reviewer, timestamp, and substantive note';
    end if;

    perform 1
      from public.app_user_capabilities capability_record
     where capability_record.user_id=new.reviewed_by
       and capability_record.capability='LEGAL_COUNSEL_ATTEST'
       and capability_record.active=true
       for share;
    if not found then
      raise exception 'Human disposition requires active LEGAL_COUNSEL_ATTEST capability';
    end if;
  end if;
  return new;
end;
$$;

create or replace function public.enforce_decision_disposition() returns trigger
language plpgsql
set search_path = pg_catalog, public, pg_temp
as $$
begin
  if new.decision_status in ('APPROVED','REJECTED') then
    if new.decided_by is null or new.decided_at is null or new.decided_by=new.requested_by then
      raise exception 'Decision disposition requires an independent recorded approver';
    end if;
    if new.evidence_protocol_version>=1 and
       char_length(btrim(coalesce(new.disposition_note,''))) not between 12 and 4000 then
      raise exception 'Decision disposition requires a substantive note between 12 and 4000 characters';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_enforce_decision_disposition on public.decisions;
create trigger trg_enforce_decision_disposition
before insert or update of decision_status,decided_by,decided_at,disposition_note,evidence_protocol_version on public.decisions
for each row execute function public.enforce_decision_disposition();
