-- Version-scoped decision/economics authority and execution lifecycle controls.

alter table decisions
  add column if not exists agreement_version_id uuid references agreement_versions(id) on delete restrict;

alter table economics_runs
  add column if not exists agreement_version_id uuid references agreement_versions(id) on delete restrict,
  add column if not exists review_status text not null default 'UNREVIEWED',
  add column if not exists reviewed_by text,
  add column if not exists reviewed_at timestamptz,
  add column if not exists review_note text;

alter table economics_runs drop constraint if exists economics_runs_review_status_check;
alter table economics_runs
  add constraint economics_runs_review_status_check
  check (review_status in ('UNREVIEWED','VALIDATED','REJECTED'));

-- Preserve ambiguous historical rows as explicitly unbound legacy evidence.
-- NOT VALID avoids inventing a version for those rows while still rejecting
-- every new or subsequently changed unbound record.
alter table decisions drop constraint if exists decisions_agreement_version_required;
alter table decisions
  add constraint decisions_agreement_version_required
  check (agreement_version_id is not null) not valid;

alter table economics_runs drop constraint if exists economics_runs_agreement_version_required;
alter table economics_runs
  add constraint economics_runs_agreement_version_required
  check (matter_id is not null and agreement_version_id is not null) not valid;

-- The legacy free-text column remains readable only for historical unbound
-- decisions. New version-bound decisions must use decision_conditions.
alter table decisions drop constraint if exists decisions_structured_conditions_required;
alter table decisions
  add constraint decisions_structured_conditions_required
  check (agreement_version_id is null or nullif(btrim(conditions),'') is null) not valid;

create table if not exists decision_conditions (
  id uuid primary key default gen_random_uuid(),
  matter_id uuid not null references matters(id) on delete cascade,
  agreement_version_id uuid not null references agreement_versions(id) on delete restrict,
  decision_id uuid not null references decisions(id) on delete restrict,
  sequence_number integer not null check (sequence_number > 0),
  condition_text text not null check (length(btrim(condition_text)) between 1 and 1000),
  condition_status text not null default 'PENDING'
    check (condition_status in ('PENDING','SATISFIED','WAIVED')),
  evidence text check (evidence is null or length(evidence) <= 4000),
  created_by text not null,
  created_at timestamptz not null default now(),
  resolved_by text,
  resolved_at timestamptz,
  unique(decision_id, sequence_number)
);

create or replace function enforce_version_scoped_record() returns trigger as $$
declare
  version_matter uuid;
  version_status text;
begin
  if tg_op='UPDATE' and
     (new.matter_id,new.agreement_version_id) is distinct from
     (old.matter_id,old.agreement_version_id) then
    raise exception '% matter and agreement-version scope are immutable; create a new record',tg_table_name;
  end if;
  if new.agreement_version_id is null then
    raise exception '% must be bound to an agreement version',tg_table_name;
  end if;
  select matter_id,status into version_matter,version_status
    from agreement_versions where id=new.agreement_version_id for update;
  if version_matter is null or new.matter_id is null or version_matter<>new.matter_id then
    raise exception '% agreement version must belong to the same matter',tg_table_name;
  end if;
  if tg_op='INSERT' and version_status not in ('WORKING','APPROVED') then
    raise exception '% may be created only for a WORKING or APPROVED agreement version',tg_table_name;
  end if;
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_decisions_version_scope on decisions;
create trigger trg_decisions_version_scope
before insert or update of matter_id,agreement_version_id on decisions
for each row execute function enforce_version_scoped_record();

drop trigger if exists trg_economics_version_scope on economics_runs;
create trigger trg_economics_version_scope
before insert or update of matter_id,agreement_version_id on economics_runs
for each row execute function enforce_version_scoped_record();

create or replace function enforce_decision_version_lifecycle() returns trigger as $$
declare version_status text;
begin
  select status into version_status
    from agreement_versions where id=new.agreement_version_id for update;
  if version_status is null or version_status not in ('WORKING','APPROVED') then
    raise exception 'Decision disposition is permitted only while its agreement version is WORKING or APPROVED';
  end if;
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_decision_version_lifecycle on decisions;
create trigger trg_decision_version_lifecycle
before update of decision_status,decided_by,decided_at on decisions
for each row when (old.decision_status is distinct from new.decision_status)
execute function enforce_decision_version_lifecycle();

create or replace function enforce_decision_finding_lineage() returns trigger as $$
declare
  finding_matter uuid;
  finding_document uuid;
begin
  if tg_op='UPDATE' and new.finding_id is distinct from old.finding_id then
    raise exception 'Decision linked-finding scope is immutable; create a new decision request';
  end if;
  if new.finding_id is null then return new; end if;
  select matter_id,document_id into finding_matter,finding_document
    from findings where id=new.finding_id;
  if finding_matter is null or finding_matter<>new.matter_id then
    raise exception 'Decision finding must belong to the same matter';
  end if;
  if finding_document is null or not exists (
    select 1 from agreement_version_documents avd
     where avd.agreement_version_id=new.agreement_version_id
       and avd.document_id=finding_document
  ) then
    raise exception 'Decision finding source must be included in the bound agreement version';
  end if;
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_decision_finding_lineage on decisions;
create trigger trg_decision_finding_lineage
before insert or update of matter_id,agreement_version_id,finding_id on decisions
for each row execute function enforce_decision_finding_lineage();

create or replace function enforce_decision_condition_lineage() returns trigger as $$
declare
  decision_matter uuid;
  decision_version uuid;
  decision_status text;
  version_status text;
begin
  select d.matter_id,d.agreement_version_id,d.decision_status into decision_matter,decision_version,decision_status
    from decisions d where d.id=new.decision_id for update;
  if decision_matter is null or decision_version is null or
     decision_matter<>new.matter_id or decision_version<>new.agreement_version_id then
    raise exception 'Decision condition must match its decision matter and agreement version';
  end if;
  select status into version_status from agreement_versions where id=new.agreement_version_id for update;
  if version_status not in ('WORKING','APPROVED') then
    raise exception 'Decision conditions may be created or rebound only while the agreement version is WORKING or APPROVED';
  end if;
  if tg_op='INSERT' and decision_status<>'PENDING' then
    raise exception 'Decision conditions may be created only while the decision is PENDING';
  end if;
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_decision_condition_lineage on decision_conditions;
create trigger trg_decision_condition_lineage
before insert or update of matter_id,agreement_version_id,decision_id on decision_conditions
for each row execute function enforce_decision_condition_lineage();

create or replace function enforce_decision_condition_lifecycle() returns trigger as $$
declare
  parent_decision_status text;
  resolver_role text;
begin
  if tg_op='DELETE' then
    raise exception 'Decision conditions are immutable evidence and cannot be deleted';
  end if;
  if tg_op='INSERT' then
    if new.condition_status<>'PENDING' or new.evidence is not null or
       new.resolved_by is not null or new.resolved_at is not null then
      raise exception 'New decision conditions must begin PENDING without resolution evidence';
    end if;
    return new;
  end if;
  if (new.matter_id,new.agreement_version_id,new.decision_id,new.sequence_number,
      new.condition_text,new.created_by,new.created_at)
     is distinct from
     (old.matter_id,old.agreement_version_id,old.decision_id,old.sequence_number,
      old.condition_text,old.created_by,old.created_at) then
    raise exception 'Decision condition identity and text are immutable';
  end if;
  if old.condition_status<>'PENDING' then
    raise exception 'Resolved decision conditions are immutable';
  end if;
  select decision_status into parent_decision_status from decisions where id=new.decision_id for share;
  if parent_decision_status<>'APPROVED' then
    raise exception 'Decision conditions may be resolved only after the parent decision is APPROVED';
  end if;
  if new.condition_status not in ('SATISFIED','WAIVED') or
     new.resolved_by is null or new.resolved_at is null or
     length(btrim(coalesce(new.evidence,'')))<12 then
    raise exception 'Condition resolution requires SATISFIED or WAIVED status, resolver, timestamp, and substantive evidence';
  end if;
  if new.condition_status='WAIVED' then
    select role into resolver_role from app_user_roles where user_id=new.resolved_by and active=true;
    if resolver_role is distinct from 'ADMIN' then
      raise exception 'Condition waiver requires a recorded active Admin resolver';
    end if;
  end if;
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_decision_condition_lifecycle on decision_conditions;
create trigger trg_decision_condition_lifecycle
before insert or update or delete on decision_conditions
for each row execute function enforce_decision_condition_lifecycle();

-- Migration 006 made economics rows entirely append-only. Replace that trigger
-- with a narrower lifecycle: calculation/version data stay immutable, and the
-- only permitted update is one documented human disposition.
drop trigger if exists trg_economics_runs_append_only on economics_runs;

create or replace function enforce_economics_run_lifecycle() returns trigger as $$
declare version_status text;
begin
  if tg_op='DELETE' then
    raise exception 'Economics runs are immutable evidence and cannot be deleted';
  end if;
  if tg_op='INSERT' then
    if new.review_status<>'UNREVIEWED' or new.reviewed_by is not null or
       new.reviewed_at is not null or new.review_note is not null then
      raise exception 'New economics runs must begin UNREVIEWED';
    end if;
    return new;
  end if;
  if old.review_status<>'UNREVIEWED' then
    raise exception 'Human-reviewed economics runs are immutable';
  end if;
  select status into version_status from agreement_versions where id=new.agreement_version_id for update;
  if version_status not in ('WORKING','APPROVED') then
    raise exception 'Economics review is permitted only while its agreement version is WORKING or APPROVED';
  end if;
  if (to_jsonb(new)-'review_status'-'reviewed_by'-'reviewed_at'-'review_note')
     is distinct from
     (to_jsonb(old)-'review_status'-'reviewed_by'-'reviewed_at'-'review_note') then
    raise exception 'Economics calculation and agreement-version evidence are immutable';
  end if;
  if new.review_status not in ('VALIDATED','REJECTED') or
     new.reviewed_by is null or new.reviewed_at is null or
     length(btrim(coalesce(new.review_note,'')))<12 then
    raise exception 'Economics disposition requires reviewer, timestamp, and substantive note';
  end if;
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_economics_run_lifecycle on economics_runs;
create trigger trg_economics_run_lifecycle
before insert or update or delete on economics_runs
for each row execute function enforce_economics_run_lifecycle();

-- Database-level execution gate backs up the authenticated API gate. A version
-- cannot become EXECUTED without executed-source evidence, complete analysis,
-- resolved current findings, affirmative version-scoped authority, and cleared
-- conditions.
create or replace function enforce_agreement_execution_controls() returns trigger as $$
begin
  if new.status is distinct from old.status and not (
    (old.status='WORKING' and new.status='APPROVED') or
    (old.status='APPROVED' and new.status in ('EXECUTED','SUPERSEDED')) or
    (old.status='EXECUTED' and new.status='SUPERSEDED')
  ) then
    raise exception 'Agreement version transition from % to % is not permitted',old.status,new.status;
  end if;
  if new.status='EXECUTED' and old.status is distinct from 'EXECUTED' then
    if old.status<>'APPROVED' then
      raise exception 'Agreement version must transition from APPROVED to EXECUTED';
    end if;
    if exists (
      select 1 from agreement_version_documents avd
      join documents d on d.id=avd.document_id
      where avd.agreement_version_id=new.id and (
        d.deletion_status<>'ACTIVE' or d.security_scan_status<>'CLEAN' or
        d.integrity_status<>'SERVER_VERIFIED' or d.extraction_status<>'EXTRACTED' or
        d.sha256 is null or d.server_sha256 is null or lower(d.sha256)<>lower(d.server_sha256)
      )
    ) then
      raise exception 'Execution requires every version source to be clean, extracted, hash-verified, and active';
    end if;
    if not exists (
      select 1 from agreement_version_documents avd
      join documents d on d.id=avd.document_id
      where avd.agreement_version_id=new.id and d.source_status='EXECUTED'
    ) then
      raise exception 'Execution requires an EXECUTED source document in the agreement version';
    end if;
    if exists (
      select 1 from agreement_version_documents avd
      where avd.agreement_version_id=new.id
        and not exists (
          select 1 from analysis_runs ar
          where ar.matter_id=new.matter_id and ar.document_id=avd.document_id
            and ar.run_type='CLAUSE_RISK' and ar.status='SUCCEEDED'
        )
    ) then
      raise exception 'Execution requires a successful clause-risk analysis for every version document';
    end if;
    if not exists (
      select 1 from economics_runs er
       where er.matter_id=new.matter_id and er.agreement_version_id=new.id
         and er.review_status='VALIDATED'
    ) then
      raise exception 'Execution requires a validated economics run for the exact agreement version';
    end if;
    if exists (
      select 1 from decisions d
      where d.agreement_version_id=new.id and d.decision_status='PENDING'
    ) then
      raise exception 'Execution is blocked by pending version-scoped decisions';
    end if;
    if exists (
      select 1 from decision_conditions dc
      join decisions d on d.id=dc.decision_id
      where d.agreement_version_id=new.id and d.decision_status='APPROVED'
        and dc.condition_status='PENDING'
    ) then
      raise exception 'Execution is blocked by pending approved-decision conditions';
    end if;
    if exists (
      with latest_runs as (
        select distinct on (ar.document_id) ar.id,ar.document_id
        from analysis_runs ar
        join agreement_version_documents avd on avd.document_id=ar.document_id
        where avd.agreement_version_id=new.id and ar.matter_id=new.matter_id
          and ar.run_type='CLAUSE_RISK' and ar.status='SUCCEEDED'
        order by ar.document_id,ar.started_at desc,ar.id desc
      )
      select 1 from latest_runs lr
      join findings f on f.analysis_run_id=lr.id
      where f.review_status='UNREVIEWED'
    ) then
      raise exception 'Execution is blocked until every current finding has a human disposition';
    end if;
    if exists (
      with latest_runs as (
        select distinct on (ar.document_id) ar.id,ar.document_id
        from analysis_runs ar
        join agreement_version_documents avd on avd.document_id=ar.document_id
        where avd.agreement_version_id=new.id and ar.matter_id=new.matter_id
          and ar.run_type='CLAUSE_RISK' and ar.status='SUCCEEDED'
        order by ar.document_id,ar.started_at desc,ar.id desc
      ), required_findings as (
        select f.id from latest_runs lr
        join findings f on f.analysis_run_id=lr.id
        where f.review_status='VALIDATED'
          and nullif(btrim(f.approval_required),'') is not null
      )
      select 1 from required_findings rf
      where not exists (
        select 1 from decisions d
        where d.agreement_version_id=new.id and d.finding_id=rf.id
          and d.decision_status='APPROVED'
          and d.decision_type in ('ACCEPT','APPROVE_EXCEPTION')
      )
    ) then
      raise exception 'Execution requires an approved affirmative decision for every current approval-required finding';
    end if;
  end if;
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_agreement_execution_controls on agreement_versions;
create trigger trg_agreement_execution_controls
before update of status on agreement_versions
for each row execute function enforce_agreement_execution_controls();

do $$
begin
  if exists (
    select 1 from agreement_versions where status='APPROVED'
     group by matter_id having count(*)>1
  ) then
    raise exception 'Multiple APPROVED agreement versions in one matter must be reconciled before the lifecycle uniqueness control can be applied';
  end if;
end;
$$;

create unique index if not exists uq_one_approved_agreement_version_per_matter
  on agreement_versions(matter_id) where status='APPROVED';
create index if not exists idx_decisions_agreement_version
  on decisions(agreement_version_id,decision_status,requested_at desc);
create index if not exists idx_economics_runs_agreement_version
  on economics_runs(agreement_version_id,created_at desc);
create index if not exists idx_decision_conditions_gate
  on decision_conditions(agreement_version_id,condition_status,decision_id);
