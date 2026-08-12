-- Bind terminal executive authority to the exact validated economics evidence
-- reviewed by the decision-maker. Protocol 0 remains an explicit rollout
-- compatibility state; only protocol 1 is reliance-grade evidence.

alter table public.decisions
  add column if not exists economics_run_id uuid references public.economics_runs(id) on delete restrict;

alter table public.agreement_versions
  add column if not exists authoritative_economics_run_id uuid references public.economics_runs(id) on delete restrict,
  -- Application principals intentionally remain opaque text identifiers. The
  -- application schema is migrated before Better Auth creates public."user"
  -- on a pristine target, so an application-to-auth FK would make the
  -- canonical migration order impossible and would couple legal evidence to
  -- an independently managed auth schema.
  add column if not exists authoritative_economics_selected_by text,
  add column if not exists authoritative_economics_selected_at timestamptz,
  add column if not exists evidence_protocol_version integer not null default 0;

alter table public.agreement_versions drop constraint if exists agreement_versions_evidence_protocol_version_check;
alter table public.agreement_versions
  add constraint agreement_versions_evidence_protocol_version_check
  check (evidence_protocol_version in (0,1));

alter table public.agreement_versions drop constraint if exists agreement_versions_authoritative_economics_selection_fields_check;
alter table public.agreement_versions
  add constraint agreement_versions_authority_selection_fields_check
  check (
    (authoritative_economics_run_id is null and authoritative_economics_selected_by is null and authoritative_economics_selected_at is null) or
    (authoritative_economics_run_id is not null and nullif(btrim(authoritative_economics_selected_by),'') is not null and authoritative_economics_selected_at is not null)
  );

-- Migration 011 may already exist on an expand-phase database with its
-- original note-required expression. Replace it forward here so protocol-0
-- writers remain explicitly non-reliance but operational during bundle drain;
-- protocol 1 remains note-bound.
alter table public.decisions drop constraint if exists decisions_terminal_disposition_note_required;
alter table public.decisions
  add constraint decisions_terminal_disposition_note_required
  check (
    evidence_protocol_version=0
    or decision_status not in ('APPROVED','REJECTED')
    or char_length(btrim(coalesce(disposition_note,''))) between 12 and 4000
  ) not valid;

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
       and constraint_record.conname='decisions_approved_economics_run_required'
  ) then
    alter table public.decisions
      add constraint decisions_approved_economics_run_required
      check (evidence_protocol_version=0 or decision_status<>'APPROVED' or economics_run_id is not null) not valid;
  end if;
end;
$$;

do $$
begin
  if not exists (
    select 1
      from pg_catalog.pg_constraint constraint_record
      join pg_catalog.pg_class relation_record on relation_record.oid=constraint_record.conrelid
      join pg_catalog.pg_namespace namespace_record on namespace_record.oid=relation_record.relnamespace
     where namespace_record.nspname='public'
       and relation_record.relname='agreement_versions'
       and constraint_record.conname='agreement_versions_authoritative_economics_required'
  ) then
    alter table public.agreement_versions
      add constraint agreement_versions_authoritative_economics_required
      check (
        evidence_protocol_version=0 or status='WORKING' or (
          authoritative_economics_run_id is not null and
          authoritative_economics_selected_by is not null and
          authoritative_economics_selected_at is not null
        )
      ) not valid;
  end if;
end;
$$;

create or replace function public.enforce_authoritative_economics_selection() returns trigger
language plpgsql
set search_path = pg_catalog, public, pg_temp
as $$
declare
  economics_matter uuid;
  economics_version uuid;
  economics_formula text;
  economics_review_status text;
  active_formula text;
  active_formula_count integer;
begin
  if old.evidence_protocol_version>new.evidence_protocol_version then
    raise exception 'Agreement-version evidence protocol cannot be downgraded';
  end if;

  if old.authoritative_economics_run_id is not null and
     new.authoritative_economics_run_id is distinct from old.authoritative_economics_run_id then
    raise exception 'Authoritative agreement-version economics are immutable; create a new agreement version';
  end if;
  if old.authoritative_economics_selected_by is not null and
     new.authoritative_economics_selected_by is distinct from old.authoritative_economics_selected_by then
    raise exception 'Authoritative agreement-version economics selector is immutable';
  end if;
  if old.authoritative_economics_selected_at is not null and
     new.authoritative_economics_selected_at is distinct from old.authoritative_economics_selected_at then
    raise exception 'Authoritative agreement-version economics selection time is immutable';
  end if;

  if new.evidence_protocol_version>=1 then
    if new.status='WORKING' and new.authoritative_economics_run_id is not null then
      raise exception 'Authoritative economics may be selected only while locking a WORKING agreement version';
    end if;
    if new.status<>'WORKING' and (
      new.authoritative_economics_run_id is null or
      new.authoritative_economics_selected_by is null or
      new.authoritative_economics_selected_at is null
    ) then
      raise exception 'A governed locked agreement version requires explicitly selected authoritative economics';
    end if;

    if new.authoritative_economics_run_id is not null then
      select er.matter_id,er.agreement_version_id,er.formula_version,er.review_status
        into economics_matter,economics_version,economics_formula,economics_review_status
        from public.economics_runs er
       where er.id=new.authoritative_economics_run_id
       for share;
      if not found or economics_matter is distinct from new.matter_id or economics_version is distinct from new.id then
        raise exception 'Authoritative economics must belong to the exact same matter and agreement version';
      end if;
      if economics_review_status is distinct from 'VALIDATED' then
        raise exception 'Authoritative economics must be a validated economics run';
      end if;
      select min(policy.economics_formula_version),count(distinct policy.economics_formula_version)::integer
        into active_formula,active_formula_count
        from public.analysis_engine_policies policy
       where policy.active=true;
      if active_formula_count<>1 or economics_formula is distinct from active_formula then
        raise exception 'Authoritative economics must use the one active governed formula';
      end if;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_authoritative_economics_selection on public.agreement_versions;
create trigger trg_authoritative_economics_selection
before update of status,authoritative_economics_run_id,authoritative_economics_selected_by,authoritative_economics_selected_at,evidence_protocol_version on public.agreement_versions
for each row execute function public.enforce_authoritative_economics_selection();

create or replace function public.enforce_decision_economics_binding() returns trigger
language plpgsql
set search_path = pg_catalog, public, pg_temp
as $$
declare
  economics_matter uuid;
  economics_version uuid;
  economics_review_status text;
  authoritative_economics_id uuid;
  version_evidence_protocol integer;
  version_status text;
begin
  if tg_op='UPDATE' and old.evidence_protocol_version>new.evidence_protocol_version then
    raise exception 'Decision evidence protocol cannot be downgraded';
  end if;

  if new.decision_status='PENDING' and new.economics_run_id is not null then
    raise exception 'Pending decisions cannot pre-bind economics evidence';
  end if;

  if new.evidence_protocol_version>=1 and new.decision_status='APPROVED' and new.economics_run_id is null then
    raise exception 'Approved decisions require exact validated economics evidence';
  end if;

  if new.economics_run_id is not null then
    select er.matter_id,er.agreement_version_id,er.review_status
      into economics_matter,economics_version,economics_review_status
      from public.economics_runs er
     where er.id=new.economics_run_id
     for share;

    if not found or economics_matter is distinct from new.matter_id or
       economics_version is distinct from new.agreement_version_id then
      raise exception 'Decision economics evidence must belong to the exact same matter and agreement version';
    end if;

    if economics_review_status is distinct from 'VALIDATED' then
      raise exception 'Decision economics evidence must be a validated economics run';
    end if;
  end if;

  if new.evidence_protocol_version>=1 and new.decision_status='APPROVED' then
    select av.authoritative_economics_run_id,av.evidence_protocol_version,av.status
      into authoritative_economics_id,version_evidence_protocol,version_status
      from public.agreement_versions av
     where av.id=new.agreement_version_id
     for update;
    if version_evidence_protocol<1 or version_status<>'APPROVED' or authoritative_economics_id is null then
      raise exception 'Governed decision approval requires a locked agreement version with authoritative economics';
    end if;
    if new.economics_run_id is distinct from authoritative_economics_id then
      raise exception 'Decision approval must bind the agreement version authoritative economics';
    end if;

    if new.finding_id is not null then
      perform 1 from public.findings finding_record where finding_record.id=new.finding_id for update;
    end if;
    if exists (
      select 1
        from public.decisions other_decision
       where other_decision.id<>new.id
         and other_decision.agreement_version_id=new.agreement_version_id
         and other_decision.finding_id is not distinct from new.finding_id
         and other_decision.economics_run_id=new.economics_run_id
         and other_decision.evidence_protocol_version>=1
         and other_decision.decision_status='APPROVED'
    ) then
      raise exception 'Only one effective approved disposition is permitted per version/finding scope and authoritative economics selection';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_decision_economics_binding on public.decisions;
create trigger trg_decision_economics_binding
before insert or update of matter_id,agreement_version_id,decision_status,economics_run_id,evidence_protocol_version on public.decisions
for each row execute function public.enforce_decision_economics_binding();

create index if not exists idx_decisions_economics_run
  on public.decisions(economics_run_id)
  where economics_run_id is not null;

create or replace function public.enforce_executive_snapshot_authoritative_evidence() returns trigger
language plpgsql
set search_path = pg_catalog, public, pg_temp
as $$
declare
  version_protocol integer;
  authoritative_economics_id uuid;
begin
  select av.evidence_protocol_version,av.authoritative_economics_run_id
    into version_protocol,authoritative_economics_id
    from public.agreement_versions av
   where av.id=new.agreement_version_id
   for share;
  if not found then
    raise exception 'Executive snapshot agreement version does not exist';
  end if;
  if version_protocol>=1 and (
    authoritative_economics_id is null or
    coalesce(new.source_manifest#>>'{agreement,evidence_protocol_version}','0')::integer<1 or
    new.source_manifest#>>'{agreement,authoritative_economics_run_id}' is distinct from authoritative_economics_id::text or
    new.source_manifest#>>'{economics,id}' is distinct from authoritative_economics_id::text or
    new.source_manifest#>>'{publicationReceipt,economicsRunId}' is distinct from authoritative_economics_id::text
  ) then
    raise exception 'Protocol-1 executive snapshots must bind the exact authoritative economics selection';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_executive_snapshot_authoritative_evidence on public.executive_snapshots;
create trigger trg_executive_snapshot_authoritative_evidence
before insert or update of agreement_version_id,source_manifest on public.executive_snapshots
for each row execute function public.enforce_executive_snapshot_authoritative_evidence();

-- Replace the original lifecycle gate without weakening its source, analysis,
-- review, pending-request, or authority controls. Historical approvals remain
-- immutable evidence. Protocol 1 approvals bind to the agreement version's
-- immutable authoritative economics selection. Protocol 0 preserves the
-- pre-migration execution behavior only for mixed-bundle rollout compatibility.
create or replace function public.enforce_agreement_execution_controls() returns trigger
language plpgsql
set search_path = pg_catalog, public, pg_temp
as $$
declare
  active_formula text;
  active_formula_count integer;
  current_economics_id uuid;
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
      select 1
        from public.agreement_version_documents avd
        join public.documents d on d.id=avd.document_id
       where avd.agreement_version_id=new.id and (
         d.deletion_status<>'ACTIVE' or d.security_scan_status<>'CLEAN' or
         d.integrity_status<>'SERVER_VERIFIED' or d.extraction_status<>'EXTRACTED' or
         d.sha256 is null or d.server_sha256 is null or lower(d.sha256)<>lower(d.server_sha256)
       )
    ) then
      raise exception 'Execution requires every version source to be clean, extracted, hash-verified, and active';
    end if;

    if not exists (
      select 1
        from public.agreement_version_documents avd
        join public.documents d on d.id=avd.document_id
       where avd.agreement_version_id=new.id and d.source_status='EXECUTED'
    ) then
      raise exception 'Execution requires an EXECUTED source document in the agreement version';
    end if;

    if exists (
      select 1
        from public.agreement_version_documents avd
       where avd.agreement_version_id=new.id
         and not exists (
           select 1
             from public.analysis_runs ar
            where ar.matter_id=new.matter_id and ar.document_id=avd.document_id
              and ar.run_type='CLAUSE_RISK' and ar.status='SUCCEEDED'
         )
    ) then
      raise exception 'Execution requires a successful clause-risk analysis for every version document';
    end if;

    select min(policy.economics_formula_version),
           count(distinct policy.economics_formula_version)::integer
      into active_formula,active_formula_count
      from public.analysis_engine_policies policy
     where policy.active=true;

    if active_formula_count<>1 or active_formula is null then
      raise exception 'Execution requires one consistent active economics formula policy';
    end if;

    if new.evidence_protocol_version>=1 then
      if new.authoritative_economics_run_id is null then
        raise exception 'Execution requires a governed agreement version with explicitly selected authoritative economics';
      end if;
      select er.id
        into current_economics_id
        from public.economics_runs er
       where er.id=new.authoritative_economics_run_id
         and er.matter_id=new.matter_id
         and er.agreement_version_id=new.id
         and er.formula_version=active_formula
         and er.review_status='VALIDATED';
      if current_economics_id is null then
        raise exception 'Execution requires the explicitly selected authoritative economics to remain validated and current-formula';
      end if;
    else
      select er.id
        into current_economics_id
        from public.economics_runs er
       where er.matter_id=new.matter_id
         and er.agreement_version_id=new.id
         and er.formula_version=active_formula
         and er.review_status='VALIDATED'
       order by er.reviewed_at desc nulls last,er.created_at desc,er.id desc
       limit 1;
      if current_economics_id is null then
        raise exception 'Execution requires validated economics using the current governed formula version';
      end if;
    end if;

    if exists (
      select 1
        from public.decisions d
       where d.agreement_version_id=new.id and d.decision_status='PENDING'
    ) then
      raise exception 'Execution is blocked by pending version-scoped decisions';
    end if;

    if new.evidence_protocol_version>=1 and exists (
      select 1
        from public.decisions d
       where d.agreement_version_id=new.id
         and d.decision_status='APPROVED'
         and d.evidence_protocol_version>=1
         and d.economics_run_id=current_economics_id
         and d.decision_type in ('NEGOTIATE','ESCALATE','REJECT')
         and char_length(btrim(coalesce(d.disposition_note,''))) between 12 and 4000
    ) then
      raise exception 'Execution is blocked by an effective NEGOTIATE, ESCALATE, or REJECT authority disposition';
    end if;

    if exists (
      select 1
        from public.decision_conditions dc
        join public.decisions d on d.id=dc.decision_id
       where d.agreement_version_id=new.id and d.decision_status='APPROVED'
         and (
           new.evidence_protocol_version=0 or (
             d.evidence_protocol_version>=1
             and d.economics_run_id=current_economics_id
             and char_length(btrim(coalesce(d.disposition_note,''))) between 12 and 4000
           )
         )
         and dc.condition_status='PENDING'
    ) then
      raise exception 'Execution is blocked by pending effective approved-decision conditions';
    end if;

    if exists (
      with latest_runs as (
        select distinct on (ar.document_id) ar.id,ar.document_id
          from public.analysis_runs ar
          join public.agreement_version_documents avd on avd.document_id=ar.document_id
         where avd.agreement_version_id=new.id and ar.matter_id=new.matter_id
           and ar.run_type='CLAUSE_RISK' and ar.status='SUCCEEDED'
         order by ar.document_id,ar.started_at desc,ar.id desc
      )
      select 1
        from latest_runs lr
        join public.findings f on f.analysis_run_id=lr.id
       where f.review_status='UNREVIEWED'
    ) then
      raise exception 'Execution is blocked until every current finding has a human disposition';
    end if;

    if exists (
      with latest_runs as (
        select distinct on (ar.document_id) ar.id,ar.document_id
          from public.analysis_runs ar
          join public.agreement_version_documents avd on avd.document_id=ar.document_id
         where avd.agreement_version_id=new.id and ar.matter_id=new.matter_id
           and ar.run_type='CLAUSE_RISK' and ar.status='SUCCEEDED'
         order by ar.document_id,ar.started_at desc,ar.id desc
      ), required_findings as (
        select f.id
          from latest_runs lr
          join public.findings f on f.analysis_run_id=lr.id
         where f.review_status='VALIDATED'
           and nullif(btrim(f.approval_required),'') is not null
      )
      select 1
        from required_findings required_finding
       where not exists (
         select 1
           from public.decisions d
          where d.agreement_version_id=new.id
            and d.finding_id=required_finding.id
            and d.decision_status='APPROVED'
            and d.decision_type in ('ACCEPT','APPROVE_EXCEPTION')
            and (
              new.evidence_protocol_version=0 or (
                d.evidence_protocol_version>=1
                and d.economics_run_id=current_economics_id
                and char_length(btrim(coalesce(d.disposition_note,''))) between 12 and 4000
              )
            )
       )
    ) then
      raise exception 'Execution requires current-economics affirmative authority for every current approval-required finding';
    end if;
  end if;

  return new;
end;
$$;
