-- Explicit counsel completion receipts for every current analysis stage,
-- including legitimate zero-output runs.

alter table documents
  add column if not exists extraction_job_id uuid references processing_jobs(id) on delete restrict;

alter table term_dependencies
  add column if not exists processing_job_id uuid references processing_jobs(id) on delete restrict,
  add column if not exists origin text default 'LEGACY_UNATTESTED';

alter table document_relations
  add column if not exists processing_job_id uuid references processing_jobs(id) on delete restrict,
  add column if not exists origin text default 'LEGACY_UNATTESTED';

-- Pre-migration graph rows have no durable generator receipt and therefore
-- cannot be promoted implicitly to either model or counsel provenance.
update term_dependencies set origin='LEGACY_UNATTESTED' where origin is null;
update document_relations set origin='LEGACY_UNATTESTED' where origin is null;
alter table term_dependencies alter column origin drop default;
alter table document_relations alter column origin drop default;
alter table term_dependencies alter column origin set not null;
alter table document_relations alter column origin set not null;
alter table term_dependencies drop constraint if exists term_dependencies_origin_check;
alter table term_dependencies add constraint term_dependencies_origin_check
  check (origin in ('MODEL','COUNSEL','LEGACY_UNATTESTED'));
alter table document_relations drop constraint if exists document_relations_origin_check;
alter table document_relations add constraint document_relations_origin_check
  check (origin in ('MODEL','COUNSEL','LEGACY_UNATTESTED'));

create table if not exists analysis_engine_policies (
  id uuid primary key default gen_random_uuid(),
  scope_type text not null check (scope_type in ('CLAUSE_RISK','TERM_EXTRACTION','DEPENDENCY','PRECEDENCE')),
  policy_version text not null,
  model_name text not null check (length(btrim(model_name))>0),
  prompt_version text not null check (length(btrim(prompt_version))>0),
  schema_version text not null check (length(btrim(schema_version))>0),
  graph_version text,
  economics_formula_version text not null check (length(btrim(economics_formula_version))>0),
  active boolean not null default false,
  approved_by text not null,
  approved_at timestamptz not null default now(),
  unique(scope_type,policy_version)
);

create unique index if not exists uq_active_analysis_engine_policy
  on analysis_engine_policies(scope_type) where active=true;

insert into analysis_engine_policies(scope_type,policy_version,model_name,prompt_version,schema_version,graph_version,economics_formula_version,active,approved_by)
values
  ('CLAUSE_RISK','engine-policy-2026-08-08.v1','gpt-5.6','ems-legal-triage-2026-08-07.v4','clause-risk.v2',null,'ems-contract-economics-2026-08-07.v1',true,'MIGRATION-008'),
  ('TERM_EXTRACTION','engine-policy-2026-08-08.v1','gpt-5.6','contract-term-extraction-2026-08-07.v1','contract-term.v1',null,'ems-contract-economics-2026-08-07.v1',true,'MIGRATION-008'),
  ('DEPENDENCY','engine-policy-2026-08-08.v1','gpt-5.6','term-dependency-2026-08-07.v1','term-dependency.v1','agreement-graph-2026-08-08.v2','ems-contract-economics-2026-08-07.v1',true,'MIGRATION-008'),
  ('PRECEDENCE','engine-policy-2026-08-08.v1','gpt-5.6','document-precedence-2026-08-07.v1','document-precedence.v1','agreement-graph-2026-08-08.v2','ems-contract-economics-2026-08-07.v1',true,'MIGRATION-008')
on conflict(scope_type,policy_version) do nothing;

create or replace function prevent_active_engine_policy_mutation() returns trigger as $$
begin
  if tg_op='DELETE' and old.active then raise exception 'Active analysis-engine policy is immutable'; end if;
  if tg_op='UPDATE' and old.active and to_jsonb(new) is distinct from to_jsonb(old) then
    raise exception 'Active analysis-engine policy is immutable; activate a governed successor by migration';
  end if;
  if tg_op='DELETE' then return old; end if;
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_active_analysis_engine_policy_immutable on analysis_engine_policies;
create trigger trg_active_analysis_engine_policy_immutable
before update or delete on analysis_engine_policies
for each row execute function prevent_active_engine_policy_mutation();

-- Match lib/stateHash.ts for JSON values constructed from database rows. The
-- fixed evidence keys are ASCII, so C collation matches their JS lexical order.
create or replace function canonical_jsonb_text(input_value jsonb) returns text as $$
declare result text;
begin
  case jsonb_typeof(input_value)
    when 'object' then
      select '{'||coalesce(string_agg(to_jsonb(key)::text||':'||canonical_jsonb_text(value),',' order by key collate "C"),'')||'}'
        into result from jsonb_each(input_value);
    when 'array' then
      select '['||coalesce(string_agg(canonical_jsonb_text(value),',' order by ordinal_position),'')||']'
        into result from jsonb_array_elements(input_value) with ordinality as item(value,ordinal_position);
    else result:=input_value::text;
  end case;
  return result;
end;
$$ language plpgsql immutable strict;

create or replace function enforce_extraction_generation_lineage() returns trigger as $$
declare
  job_matter uuid;
  job_document uuid;
  job_kind text;
  job_status text;
begin
  if tg_op='UPDATE' and new.extraction_job_id is not distinct from old.extraction_job_id then return new; end if;
  if new.extraction_job_id is null then
    if tg_op='UPDATE' and old.extraction_job_id is not null then
      raise exception 'Document extraction-generation lineage cannot be cleared';
    end if;
    return new;
  end if;
  perform lock_documents_for_legal_publication(array[new.id]);
  select matter_id,document_id,job_type,status into job_matter,job_document,job_kind,job_status
    from processing_jobs where id=new.extraction_job_id for share;
  if job_matter is null or job_matter<>new.matter_id or job_document<>new.id or
     job_kind<>'EXTRACT' or job_status<>'RUNNING' then
    raise exception 'Document extraction generation must reference its same-document RUNNING EXTRACT job';
  end if;
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_extraction_generation_lineage on documents;
create trigger trg_extraction_generation_lineage
before insert or update on documents
for each row execute function enforce_extraction_generation_lineage();

create or replace function prevent_bound_extraction_job_retarget() returns trigger as $$
begin
  if exists(select 1 from documents d where d.extraction_job_id=old.id) and
     (new.matter_id,new.document_id,new.job_type) is distinct from
     (old.matter_id,old.document_id,old.job_type) then
    raise exception 'A claimed extraction job cannot be retargeted away from its document generation';
  end if;
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_bound_extraction_job_lineage on processing_jobs;
create trigger trg_bound_extraction_job_lineage
before update of matter_id,document_id,job_type on processing_jobs
for each row execute function prevent_bound_extraction_job_retarget();

create table if not exists app_user_capabilities (
  user_id text not null,
  capability text not null check (capability in ('LEGAL_COUNSEL_ATTEST')),
  active boolean not null default true,
  granted_by text not null,
  granted_at timestamptz not null default now(),
  primary key(user_id,capability)
);

create table if not exists analysis_review_attestations (
  id uuid primary key default gen_random_uuid(),
  matter_id uuid not null references matters(id) on delete restrict,
  scope_type text not null check (scope_type in ('CLAUSE_RISK','TERM_EXTRACTION','DEPENDENCY','PRECEDENCE')),
  analysis_run_id uuid references analysis_runs(id) on delete restrict,
  processing_job_id uuid references processing_jobs(id) on delete restrict,
  input_sha256 text not null check (input_sha256 ~ '^[0-9a-fA-F]{64}$'),
  output_count integer not null check (output_count >= 0),
  disposition_counts jsonb not null,
  manifest jsonb not null,
  manifest_canonical text not null,
  manifest_hash text not null check (manifest_hash ~ '^[0-9a-fA-F]{64}$'),
  attestation_note text not null check (length(btrim(attestation_note)) between 12 and 4000),
  authority_capability text not null check (authority_capability='LEGAL_COUNSEL_ATTEST'),
  attested_by text not null,
  attested_at timestamptz not null default now(),
  check (
    (scope_type in ('CLAUSE_RISK','TERM_EXTRACTION') and analysis_run_id is not null and processing_job_id is null)
    or
    (scope_type in ('DEPENDENCY','PRECEDENCE') and analysis_run_id is null and processing_job_id is not null)
  )
);

create unique index if not exists uq_analysis_review_attestation_run
  on analysis_review_attestations(analysis_run_id) where analysis_run_id is not null;
create unique index if not exists uq_analysis_review_attestation_job
  on analysis_review_attestations(processing_job_id) where processing_job_id is not null;
create index if not exists idx_analysis_review_attestations_matter
  on analysis_review_attestations(matter_id,attested_at desc);

create or replace function enforce_active_counsel_attestation() returns trigger as $$
begin
  if not exists(select 1 from app_user_capabilities c where c.user_id=new.attested_by and c.capability='LEGAL_COUNSEL_ATTEST' and c.active=true) then
    raise exception 'Analysis-review attester lacks active LEGAL_COUNSEL_ATTEST authority';
  end if;
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_active_counsel_attestation on analysis_review_attestations;
create trigger trg_active_counsel_attestation
before insert on analysis_review_attestations
for each row execute function enforce_active_counsel_attestation();

create or replace function enforce_graph_origin() returns trigger as $$
begin
  if tg_op='UPDATE' and
     (new.origin,new.processing_job_id) is distinct from (old.origin,old.processing_job_id) then
    raise exception 'Graph-object origin and generator receipt are immutable';
  end if;
  if tg_op='INSERT' and new.origin='LEGACY_UNATTESTED' then
    raise exception 'LEGACY_UNATTESTED is migration-only provenance and cannot be assigned to new graph objects';
  end if;
  if (new.origin='MODEL' and new.processing_job_id is null) or
     (new.origin in ('COUNSEL','LEGACY_UNATTESTED') and new.processing_job_id is not null) then
    raise exception 'Graph-object origin is inconsistent with its processing-job receipt';
  end if;
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_dependency_graph_origin on term_dependencies;
create trigger trg_dependency_graph_origin
before insert or update of origin,processing_job_id on term_dependencies
for each row execute function enforce_graph_origin();

drop trigger if exists trg_relation_graph_origin on document_relations;
create trigger trg_relation_graph_origin
before insert or update of origin,processing_job_id on document_relations
for each row execute function enforce_graph_origin();

create or replace function enforce_graph_job_lineage() returns trigger as $$
declare
  job_matter uuid;
  job_kind text;
  job_status text;
begin
  if new.processing_job_id is null then return new; end if;
  if new.origin<>'MODEL' then
    raise exception 'Only MODEL graph objects may reference a processing-job receipt';
  end if;
  select matter_id,job_type,status into job_matter,job_kind,job_status
    from processing_jobs where id=new.processing_job_id;
  if job_matter is null or job_matter<>new.matter_id or job_status<>'RUNNING' then
    raise exception 'Graph output must be published by its same-matter RUNNING processing job';
  end if;
  if (tg_table_name='term_dependencies' and job_kind<>'DEPENDENCY') or
     (tg_table_name='document_relations' and job_kind<>'PRECEDENCE') then
    raise exception 'Graph output processing-job type is inconsistent';
  end if;
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_dependency_job_lineage on term_dependencies;
create trigger trg_dependency_job_lineage
before insert or update of matter_id,processing_job_id on term_dependencies
for each row execute function enforce_graph_job_lineage();

drop trigger if exists trg_relation_job_lineage on document_relations;
create trigger trg_relation_job_lineage
before insert or update of matter_id,processing_job_id on document_relations
for each row execute function enforce_graph_job_lineage();

create or replace function enforce_analysis_review_attestation() returns trigger as $$
declare
  source_matter uuid;
  source_type text;
  source_status text;
  source_input text;
  source_output_count integer;
  source_rejected_count integer;
  source_output jsonb;
  manifest_objects jsonb;
  manifest_object_ids text[];
  source_object_ids text[];
  receipt_object_ids text[];
  expected_dispositions jsonb;
begin
  if new.manifest is distinct from new.manifest_canonical::jsonb then
    raise exception 'Analysis-review manifest does not match its canonical preimage';
  end if;
  if lower(new.manifest_hash)<>encode(digest(convert_to(new.manifest_canonical,'UTF8'),'sha256'),'hex') then
    raise exception 'Analysis-review manifest hash is invalid';
  end if;

  if new.analysis_run_id is not null then
    select matter_id,run_type,status,input_sha256,output_count,rejected_ungrounded_count
      into source_matter,source_type,source_status,source_input,source_output_count,source_rejected_count
      from analysis_runs where id=new.analysis_run_id;
  else
    select matter_id,job_type,status,output->>'inputHash',output,
           case when job_type='DEPENDENCY' then (output->>'dependencyCount')::integer
                when job_type='PRECEDENCE' then (output->>'relationCount')::integer
                else -1 end
      into source_matter,source_type,source_status,source_input,source_output,source_output_count
      from processing_jobs where id=new.processing_job_id;
  end if;

  if source_matter is null or source_matter<>new.matter_id or source_type is distinct from new.scope_type or source_status is distinct from 'SUCCEEDED' or
     lower(coalesce(source_input,''))<>lower(new.input_sha256) or source_output_count is distinct from new.output_count then
    raise exception 'Analysis-review attestation does not match its immutable successful source run';
  end if;
  if new.analysis_run_id is not null and source_rejected_count<>0 then
    raise exception 'Analysis-review attestation requires a rejection-free grounded source run';
  end if;
  if new.processing_job_id is not null and (
     (source_output->>'rawCandidateCount')::integer is distinct from source_output_count or
     (source_output->>'rejectedCandidateCount')::integer is distinct from 0
  ) then
    raise exception 'Graph-analysis attestation requires rejection-free raw/output candidate parity';
  end if;

  manifest_objects:=new.manifest->'objects';
  if jsonb_typeof(manifest_objects) is distinct from 'array' then
    raise exception 'Analysis-review manifest must contain an objects array';
  end if;
  if exists (
    select 1 from jsonb_array_elements(manifest_objects) as object_row(value)
     where jsonb_typeof(value)<>'object' or coalesce(value->>'id','') !~* '^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$'
  ) then
    raise exception 'Analysis-review manifest contains an invalid object identity';
  end if;
  select coalesce(array_agg(value->>'id' order by value->>'id'),array[]::text[])
    into manifest_object_ids
    from jsonb_array_elements(manifest_objects) as object_row(value);

  if new.scope_type='CLAUSE_RISK' then
    select coalesce(array_agg(id::text order by id::text),array[]::text[]),
           jsonb_build_object(
             'validated',count(*) filter(where review_status='VALIDATED'),
             'rejected',count(*) filter(where review_status='REJECTED'),
             'unreviewed',count(*) filter(where review_status='UNREVIEWED'),
             'other',count(*) filter(where review_status not in ('VALIDATED','REJECTED','UNREVIEWED'))
           )
      into source_object_ids,expected_dispositions
      from findings where analysis_run_id=new.analysis_run_id;
    if exists (
      select 1 from findings
       where analysis_run_id=new.analysis_run_id and
             (review_status not in ('VALIDATED','REJECTED') or reviewed_by is null or reviewed_at is null or length(btrim(coalesce(review_note,'')))<12)
    ) then raise exception 'Every finding in an attested run requires a documented human disposition'; end if;
    if exists (
      select 1 from jsonb_array_elements(manifest_objects) as object_row(value)
      join findings f on f.id::text=value->>'id' and f.analysis_run_id=new.analysis_run_id
       where value->>'review_status' is distinct from f.review_status or
             value->>'reviewed_by' is distinct from f.reviewed_by or
             value->>'reviewed_at' is distinct from f.reviewed_at::text or
             value->>'review_note' is distinct from f.review_note
    ) then raise exception 'Finding review evidence in the attestation manifest does not match the source rows'; end if;
  elsif new.scope_type='TERM_EXTRACTION' then
    select coalesce(array_agg(id::text order by id::text),array[]::text[]),
           jsonb_build_object(
             'validated',count(*) filter(where review_status='VALIDATED'),
             'rejected',count(*) filter(where review_status='REJECTED'),
             'unreviewed',count(*) filter(where review_status='UNREVIEWED'),
             'other',count(*) filter(where review_status not in ('VALIDATED','REJECTED','UNREVIEWED'))
           )
      into source_object_ids,expected_dispositions
      from contract_terms where analysis_run_id=new.analysis_run_id;
    if exists (
      select 1 from contract_terms
       where analysis_run_id=new.analysis_run_id and
             (review_status not in ('VALIDATED','REJECTED') or reviewed_by is null or reviewed_at is null or length(btrim(coalesce(review_note,'')))<12)
    ) then raise exception 'Every contract term in an attested run requires a documented human disposition'; end if;
    if exists (
      select 1 from jsonb_array_elements(manifest_objects) as object_row(value)
      join contract_terms t on t.id::text=value->>'id' and t.analysis_run_id=new.analysis_run_id
       where value->>'review_status' is distinct from t.review_status or
             value->>'reviewed_by' is distinct from t.reviewed_by or
             value->>'reviewed_at' is distinct from t.reviewed_at::text or
             value->>'review_note' is distinct from t.review_note
    ) then raise exception 'Contract-term review evidence in the attestation manifest does not match the source rows'; end if;
  elsif new.scope_type='DEPENDENCY' then
    select coalesce(array_agg(id::text order by id::text),array[]::text[]),
           jsonb_build_object(
             'validated',count(*) filter(where review_status='VALIDATED'),
             'rejected',count(*) filter(where review_status='REJECTED'),
             'unreviewed',count(*) filter(where review_status='UNREVIEWED'),
             'other',count(*) filter(where review_status not in ('VALIDATED','REJECTED','UNREVIEWED'))
           )
      into source_object_ids,expected_dispositions
      from term_dependencies where processing_job_id=new.processing_job_id and origin='MODEL';
    if exists (
      select 1 from term_dependencies
       where processing_job_id=new.processing_job_id and origin='MODEL' and
             (review_status not in ('VALIDATED','REJECTED') or reviewed_by is null or reviewed_at is null or length(btrim(coalesce(review_note,'')))<12)
    ) then raise exception 'Every dependency in an attested job requires a documented human disposition'; end if;
    if exists (
      select 1 from jsonb_array_elements(manifest_objects) as object_row(value)
      join term_dependencies d on d.id::text=value->>'id' and d.processing_job_id=new.processing_job_id and d.origin='MODEL'
       where value->>'review_status' is distinct from d.review_status or
             value->>'reviewed_by' is distinct from d.reviewed_by or
             value->>'reviewed_at' is distinct from d.reviewed_at::text or
             value->>'review_note' is distinct from d.review_note
    ) then raise exception 'Dependency review evidence in the attestation manifest does not match the source rows'; end if;
  else
    select coalesce(array_agg(id::text order by id::text),array[]::text[]),
           jsonb_build_object(
             'validated',count(*) filter(where review_status='VALIDATED'),
             'rejected',count(*) filter(where review_status='REJECTED'),
             'unreviewed',count(*) filter(where review_status='UNREVIEWED'),
             'other',count(*) filter(where review_status not in ('VALIDATED','REJECTED','UNREVIEWED'))
           )
      into source_object_ids,expected_dispositions
      from document_relations where processing_job_id=new.processing_job_id and origin='MODEL';
    if exists (
      select 1 from document_relations
       where processing_job_id=new.processing_job_id and origin='MODEL' and
             (review_status not in ('VALIDATED','REJECTED') or reviewed_by is null or reviewed_at is null or length(btrim(coalesce(review_note,'')))<12)
    ) then raise exception 'Every precedence relation in an attested job requires a documented human disposition'; end if;
    if exists (
      select 1 from jsonb_array_elements(manifest_objects) as object_row(value)
      join document_relations r on r.id::text=value->>'id' and r.processing_job_id=new.processing_job_id and r.origin='MODEL'
       where value->>'review_status' is distinct from r.review_status or
             value->>'reviewed_by' is distinct from r.reviewed_by or
             value->>'reviewed_at' is distinct from r.reviewed_at::text or
             value->>'review_note' is distinct from r.review_note
    ) then raise exception 'Precedence review evidence in the attestation manifest does not match the source rows'; end if;
  end if;

  if cardinality(source_object_ids)<>new.output_count or manifest_object_ids is distinct from source_object_ids then
    raise exception 'Analysis-review manifest object identities/count do not match the exact source output rows';
  end if;
  if new.disposition_counts is distinct from expected_dispositions or
     new.manifest->'dispositionCounts' is distinct from expected_dispositions then
    raise exception 'Analysis-review disposition counts do not match the exact source output rows';
  end if;
  if new.manifest#>>'{scope,id}' is distinct from coalesce(new.analysis_run_id,new.processing_job_id)::text or
     new.manifest#>>'{authority,capability}' is distinct from 'LEGAL_COUNSEL_ATTEST' or
     new.manifest#>>'{authority,attestedBy}' is distinct from new.attested_by or
     new.manifest#>>'{authority,confirmComplete}' is distinct from 'true' then
    raise exception 'Analysis-review manifest scope or authority binding is invalid';
  end if;

  if new.processing_job_id is not null then
    if jsonb_typeof(source_output->'objectIds') is distinct from 'array' or exists (
      select 1 from jsonb_array_elements(source_output->'objectIds') as receipt_row(value)
       where jsonb_typeof(value)<>'string' or (value#>>'{}') !~* '^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$'
    ) then
      raise exception 'Graph-analysis receipt must contain a valid objectIds array';
    end if;
    select coalesce(array_agg(value#>>'{}' order by value#>>'{}'),array[]::text[])
      into receipt_object_ids
      from jsonb_array_elements(source_output->'objectIds') as receipt_row(value);
    if receipt_object_ids is distinct from source_object_ids then
      raise exception 'Graph-analysis receipt objectIds do not match the exact rows published by that job';
    end if;
  end if;
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_analysis_review_attestation_integrity on analysis_review_attestations;
create trigger trg_analysis_review_attestation_integrity
before insert on analysis_review_attestations
for each row execute function enforce_analysis_review_attestation();

drop trigger if exists trg_analysis_review_attestations_append_only on analysis_review_attestations;
create trigger trg_analysis_review_attestations_append_only
before update or delete on analysis_review_attestations
for each row execute function prevent_append_only_record_mutation();

create or replace function prevent_succeeded_job_mutation() returns trigger as $$
begin
  if tg_op='DELETE' then
    if old.status='SUCCEEDED' then raise exception 'Successful processing-job receipts are immutable'; end if;
    return old;
  end if;
  if old.status='SUCCEEDED' and to_jsonb(new) is distinct from to_jsonb(old) then
    raise exception 'Successful processing-job receipts are immutable';
  end if;
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_succeeded_processing_jobs_immutable on processing_jobs;
create trigger trg_succeeded_processing_jobs_immutable
before update or delete on processing_jobs
for each row execute function prevent_succeeded_job_mutation();

create or replace function enforce_open_validation_result_parent() returns trigger as $$
declare parent_status text; parent_id uuid;
begin
  parent_id:=case when tg_op='DELETE' then old.validation_run_id else new.validation_run_id end;
  select status into parent_status from validation_runs where id=parent_id for update;
  if parent_status in ('PASSED','FAILED') then
    raise exception 'Validation-result evidence is immutable after its parent run is terminal';
  end if;
  if tg_op='UPDATE' and new.validation_run_id is distinct from old.validation_run_id then
    select status into parent_status from validation_runs where id=old.validation_run_id for update;
    if parent_status in ('PASSED','FAILED') then
      raise exception 'Validation-result evidence cannot be moved out of a terminal run';
    end if;
  end if;
  if tg_op='DELETE' then return old; end if;
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_validation_result_parent_open on validation_results;
create trigger trg_validation_result_parent_open
before insert or update or delete on validation_results
for each row execute function enforce_open_validation_result_parent();

create or replace function enforce_terminal_validation_result_manifest() returns trigger as $$
declare
  result_manifest jsonb;
  expected_count integer;
  expected_hash text;
begin
  if new.status not in ('PASSED','FAILED') or (tg_op='UPDATE' and old.status in ('PASSED','FAILED')) then return new; end if;
  select coalesce(jsonb_agg(jsonb_build_object(
           'validation_case_id',vr.validation_case_id,
           'passed',vr.passed,
           'detected_families',vr.detected_families,
           'missing_families',vr.missing_families,
           'prohibited_detected',vr.prohibited_detected,
           'grounded',vr.grounded,
           'notes',vr.notes,
           'raw_result',vr.raw_result
         ) order by vr.validation_case_id),'[]'::jsonb),count(*)::integer
    into result_manifest,expected_count
    from validation_results vr where vr.validation_run_id=new.id;
  expected_hash:=encode(digest(convert_to(canonical_jsonb_text(result_manifest),'UTF8'),'sha256'),'hex');
  if (new.summary->>'resultCount')::integer is distinct from expected_count or
     lower(coalesce(new.summary->>'resultManifestHash',''))<>expected_hash then
    raise exception 'Terminal validation run summary must bind the exact canonical validation-result manifest';
  end if;
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_terminal_validation_result_manifest on validation_runs;
create trigger trg_terminal_validation_result_manifest
before insert or update on validation_runs
for each row execute function enforce_terminal_validation_result_manifest();

create or replace function prevent_terminal_validation_run_mutation() returns trigger as $$
begin
  if tg_op='DELETE' then
    if old.status in ('PASSED','FAILED') then raise exception 'Terminal validation evidence is immutable'; end if;
    return old;
  end if;
  if old.status in ('PASSED','FAILED') and to_jsonb(new) is distinct from to_jsonb(old) then
    raise exception 'Terminal validation evidence is immutable';
  end if;
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_terminal_validation_runs_immutable on validation_runs;
create trigger trg_terminal_validation_runs_immutable
before update or delete on validation_runs
for each row execute function prevent_terminal_validation_run_mutation();

-- Final run-scoped idempotency definitions. Rejected outputs are evidence of a
-- rejected proposal, not a permanent key reservation against corrected output.
create or replace function suppress_duplicate_term_dependency() returns trigger as $$
begin
  if new.origin='MODEL' and exists (
    select 1 from term_dependencies d
     where d.processing_job_id=new.processing_job_id
       and d.source_term_id=new.source_term_id
       and d.target_term_id=new.target_term_id
       and d.dependency_type=new.dependency_type
       and d.origin='MODEL'
       and d.review_status in ('UNREVIEWED','VALIDATED')
  ) then return null; end if;
  if new.origin='COUNSEL' and exists (
    select 1 from term_dependencies d
     where d.matter_id=new.matter_id
       and d.source_term_id=new.source_term_id
       and d.target_term_id=new.target_term_id
       and d.dependency_type=new.dependency_type
       and d.origin='COUNSEL'
       and d.review_status in ('UNREVIEWED','VALIDATED')
  ) then return null; end if;
  return new;
end;
$$ language plpgsql;

create or replace function suppress_duplicate_document_relation() returns trigger as $$
begin
  if new.origin='MODEL' and exists (
    select 1 from document_relations r
     where r.processing_job_id=new.processing_job_id
       and r.source_document_id=new.source_document_id
       and r.target_document_id=new.target_document_id
       and r.relation_type=new.relation_type
       and r.origin='MODEL'
       and r.review_status in ('UNREVIEWED','VALIDATED')
  ) then return null; end if;
  if new.origin='COUNSEL' and exists (
    select 1 from document_relations r
     where r.matter_id=new.matter_id
       and r.source_document_id=new.source_document_id
       and r.target_document_id=new.target_document_id
       and r.relation_type=new.relation_type
       and r.origin='COUNSEL'
       and r.review_status in ('UNREVIEWED','VALIDATED')
  ) then return null; end if;
  return new;
end;
$$ language plpgsql;

do $$
begin
  if exists (
    select 1 from term_dependencies
     where origin='MODEL' and processing_job_id is not null and review_status in ('UNREVIEWED','VALIDATED')
     group by processing_job_id,source_term_id,target_term_id,dependency_type having count(*)>1
  ) or exists (
    select 1 from term_dependencies
     where origin='COUNSEL' and review_status in ('UNREVIEWED','VALIDATED')
     group by matter_id,source_term_id,target_term_id,dependency_type having count(*)>1
  ) then
    raise exception 'Duplicate active dependency objects must be reconciled before run-scoped uniqueness can be applied';
  end if;
  if exists (
    select 1 from document_relations
     where origin='MODEL' and processing_job_id is not null and review_status in ('UNREVIEWED','VALIDATED')
     group by processing_job_id,source_document_id,target_document_id,relation_type having count(*)>1
  ) or exists (
    select 1 from document_relations
     where origin='COUNSEL' and review_status in ('UNREVIEWED','VALIDATED')
     group by matter_id,source_document_id,target_document_id,relation_type having count(*)>1
  ) then
    raise exception 'Duplicate active precedence objects must be reconciled before run-scoped uniqueness can be applied';
  end if;
end;
$$;

create unique index if not exists uq_model_dependency_active_per_job
  on term_dependencies(processing_job_id,source_term_id,target_term_id,dependency_type)
  where origin='MODEL' and processing_job_id is not null and review_status in ('UNREVIEWED','VALIDATED');
create unique index if not exists uq_counsel_dependency_active
  on term_dependencies(matter_id,source_term_id,target_term_id,dependency_type)
  where origin='COUNSEL' and review_status in ('UNREVIEWED','VALIDATED');
create unique index if not exists uq_model_relation_active_per_job
  on document_relations(processing_job_id,source_document_id,target_document_id,relation_type)
  where origin='MODEL' and processing_job_id is not null and review_status in ('UNREVIEWED','VALIDATED');
create unique index if not exists uq_counsel_relation_active
  on document_relations(matter_id,source_document_id,target_document_id,relation_type)
  where origin='COUNSEL' and review_status in ('UNREVIEWED','VALIDATED');

create or replace function enforce_execution_review_attestations() returns trigger as $$
declare
  source_document_ids text[];
  current_term_run_ids text[];
  dependency_state jsonb;
  precedence_state jsonb;
  dependency_input_hash text;
  precedence_input_hash text;
  dependency_job_id uuid;
  precedence_job_id uuid;
begin
  if new.status<>'EXECUTED' or old.status='EXECUTED' then return new; end if;

  select coalesce(array_agg(avd.document_id::text order by avd.document_id::text),array[]::text[])
    into source_document_ids
    from agreement_version_documents avd where avd.agreement_version_id=new.id;
  if cardinality(source_document_ids)=0 then
    raise exception 'Execution requires an agreement-version source set';
  end if;

  if exists (
    select 1
      from unnest(source_document_ids) as source_document(document_id)
      cross join (values('CLAUSE_RISK'),('TERM_EXTRACTION')) as required_scope(run_type)
      left join analysis_engine_policies policy on policy.scope_type=required_scope.run_type and policy.active=true
      left join lateral (
        select ar.id,ar.status,ar.model_name,ar.prompt_version,ar.schema_version,ar.input_sha256,ar.source_chunk_count,ar.rejected_ungrounded_count
          from analysis_runs ar
         where ar.document_id=source_document.document_id::uuid
           and ar.matter_id=new.matter_id and ar.run_type=required_scope.run_type
         order by ar.started_at desc,ar.id desc limit 1
      ) current_run on true
     where policy.id is null or current_run.id is null or current_run.status<>'SUCCEEDED' or
           current_run.model_name is distinct from policy.model_name or
           current_run.prompt_version is distinct from policy.prompt_version or
           current_run.schema_version is distinct from policy.schema_version or
           current_run.rejected_ungrounded_count<>0 or
           current_run.source_chunk_count is distinct from (
             select count(*)::integer from document_chunks dc where dc.document_id=source_document.document_id::uuid
           ) or current_run.source_chunk_count=0 or
           lower(current_run.input_sha256) is distinct from (
             select encode(digest(convert_to(string_agg(lower(dc.content_sha256),':' order by coalesce(dc.page_number,0),dc.chunk_index,dc.id),'UTF8'),'sha256'),'hex')
               from document_chunks dc where dc.document_id=source_document.document_id::uuid
           ) or not exists (
       select 1 from analysis_review_attestations a
        where a.analysis_run_id=current_run.id and a.scope_type=required_scope.run_type and a.matter_id=new.matter_id
     )
  ) then
    raise exception 'Execution requires counsel-completion attestations for every current clause-risk and term-extraction run';
  end if;

  select coalesce(array_agg(current_run.id::text order by current_run.id::text),array[]::text[])
    into current_term_run_ids
    from (
      select distinct on (ar.document_id) ar.id,ar.document_id
        from analysis_runs ar
       where ar.matter_id=new.matter_id and ar.run_type='TERM_EXTRACTION'
         and ar.document_id=any(source_document_ids::uuid[])
       order by ar.document_id,ar.started_at desc,ar.id desc
    ) current_run;

  select jsonb_build_object(
           'sourceDocumentIds',to_jsonb(source_document_ids),
           'sourceRunIds',to_jsonb(current_term_run_ids),
           'terms',coalesce(jsonb_agg(jsonb_build_object(
             'id',t.id::text,
             'analysis_run_id',t.analysis_run_id::text,
             'clause_family',t.clause_family,
             'term_type',t.term_type,
             'normalized_statement',t.normalized_statement,
             'trigger_event',t.trigger_event
           ) order by t.created_at,t.id) filter(where t.id is not null),'[]'::jsonb)
         )
    into dependency_state
    from contract_terms t
   where t.matter_id=new.matter_id and t.document_id=any(source_document_ids::uuid[])
     and t.analysis_run_id=any(current_term_run_ids::uuid[]) and t.review_status<>'SUPERSEDED';
  if jsonb_array_length(dependency_state->'terms')>250 then
    raise exception 'Execution dependency evidence exceeds the governed 250-term limit';
  end if;
  dependency_input_hash:=encode(digest(convert_to(canonical_jsonb_text(dependency_state),'UTF8'),'sha256'),'hex');

  select coalesce(jsonb_agg(jsonb_build_object(
           'id',d.id::text,
           'filename',d.filename,
           'documentType',d.document_type,
           'sourceChunks',coalesce((
             select jsonb_agg(jsonb_build_object('id',ranked.id::text,'content_sha256',ranked.content_sha256)
                              order by ranked.relevance_rank,ranked.page_rank,ranked.chunk_index,ranked.id)
               from (
                 select dc.id,dc.content_sha256,
                        case when dc.content ~* '(preced|conflict|amend|supersed|control|incorporat|govern|order of precedence)' then 0 else 1 end relevance_rank,
                        coalesce(dc.page_number,0) page_rank,dc.chunk_index
                   from document_chunks dc where dc.document_id=d.id
                  order by relevance_rank,page_rank,dc.chunk_index,dc.id limit 12
               ) ranked
           ),'[]'::jsonb),
           'sha256',lower(d.sha256)
         ) order by d.uploaded_at,d.id),'[]'::jsonb)
    into precedence_state
    from documents d where d.id=any(source_document_ids::uuid[]);
  precedence_input_hash:=encode(digest(convert_to(canonical_jsonb_text(precedence_state),'UTF8'),'sha256'),'hex');

  if not exists (
    select 1 from economics_runs er
    join analysis_engine_policies policy on policy.scope_type='DEPENDENCY' and policy.active=true
     where er.matter_id=new.matter_id and er.agreement_version_id=new.id
       and er.review_status='VALIDATED' and er.formula_version=policy.economics_formula_version
  ) then
    raise exception 'Execution requires validated economics using the current governed formula version';
  end if;

  select pj.id into dependency_job_id
    from processing_jobs pj
    join analysis_engine_policies policy on policy.scope_type='DEPENDENCY' and policy.active=true
   where pj.matter_id=new.matter_id and pj.job_type='DEPENDENCY' and pj.status='SUCCEEDED'
     and pj.input->>'agreementVersionId'=new.id::text
     and pj.input->>'graphVersion'=policy.graph_version
     and pj.input->'sourceDocumentIds'=to_jsonb(source_document_ids)
     and pj.input->'sourceTermAnalysisRunIds'=to_jsonb(current_term_run_ids)
     and pj.output->'sourceDocumentIds'=to_jsonb(source_document_ids)
     and pj.output->'sourceRunIds'=to_jsonb(current_term_run_ids)
     and pj.output->>'modelName'=policy.model_name
     and pj.output->>'promptVersion'=policy.prompt_version
     and pj.output->>'schemaVersion'=policy.schema_version
     and lower(pj.output->>'inputHash')=dependency_input_hash
     and (pj.output->>'dependencyCount')::integer=jsonb_array_length(pj.output->'objectIds')
     and (pj.output->>'rawCandidateCount')::integer=(pj.output->>'dependencyCount')::integer
     and (pj.output->>'rejectedCandidateCount')::integer=0
     and exists(select 1 from analysis_review_attestations a where a.processing_job_id=pj.id and a.scope_type='DEPENDENCY' and lower(a.input_sha256)=dependency_input_hash)
   order by pj.finished_at desc,pj.id desc limit 1;
  if dependency_job_id is null then
    raise exception 'Execution requires an attested dependency job bound to the exact current version term runs';
  end if;

  select pj.id into precedence_job_id
    from processing_jobs pj
    join analysis_engine_policies policy on policy.scope_type='PRECEDENCE' and policy.active=true
   where pj.matter_id=new.matter_id and pj.job_type='PRECEDENCE' and pj.status='SUCCEEDED'
     and pj.input->>'agreementVersionId'=new.id::text
     and pj.input->>'graphVersion'=policy.graph_version
     and pj.input->'sourceDocumentIds'=to_jsonb(source_document_ids)
     and pj.input->'sourceTermAnalysisRunIds'=to_jsonb(current_term_run_ids)
     and pj.output->'sourceDocumentIds'=to_jsonb(source_document_ids)
     and pj.output->>'modelName'=policy.model_name
     and pj.output->>'promptVersion'=policy.prompt_version
     and pj.output->>'schemaVersion'=policy.schema_version
     and lower(pj.output->>'inputHash')=precedence_input_hash
     and (pj.output->>'relationCount')::integer=jsonb_array_length(pj.output->'objectIds')
     and (pj.output->>'rawCandidateCount')::integer=(pj.output->>'relationCount')::integer
     and (pj.output->>'rejectedCandidateCount')::integer=0
     and exists(select 1 from analysis_review_attestations a where a.processing_job_id=pj.id and a.scope_type='PRECEDENCE' and lower(a.input_sha256)=precedence_input_hash)
   order by pj.finished_at desc,pj.id desc limit 1;
  if precedence_job_id is null then
    raise exception 'Execution requires an attested precedence job bound to the exact current version source set';
  end if;
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_agreement_execution_attestations on agreement_versions;
drop trigger if exists trg_agreement_execution_review_attestations on agreement_versions;
create trigger trg_agreement_execution_review_attestations
before update of status on agreement_versions
for each row execute function enforce_execution_review_attestations();

create index if not exists idx_dependencies_processing_job on term_dependencies(processing_job_id);
create index if not exists idx_relations_processing_job on document_relations(processing_job_id);
create index if not exists idx_documents_extraction_job on documents(extraction_job_id);
