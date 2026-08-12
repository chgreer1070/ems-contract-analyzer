-- Bind every approved release to the exact database reached by both the
-- migrator and the least-privilege runtime role. The stable identity detects
-- crossed credentials; the unpredictable per-release receipt also detects a
-- restored clone that preserved the stable identity.

create table public.release_database_identity (
  singleton boolean primary key default true,
  database_id uuid not null unique,
  created_at timestamptz not null default clock_timestamp(),
  constraint release_database_identity_singleton_check check (singleton)
);

insert into public.release_database_identity(singleton,database_id)
values(true,gen_random_uuid());

create table public.release_target_receipts (
  nonce_sha256 text primary key,
  database_id uuid not null references public.release_database_identity(database_id) on update restrict on delete restrict,
  source_sha text not null,
  created_at timestamptz not null default clock_timestamp(),
  constraint release_target_receipts_nonce_sha256_check
    check (nonce_sha256 ~ '^[0-9a-f]{64}$'),
  constraint release_target_receipts_source_sha_check
    check (source_sha ~ '^[0-9a-f]{40}$')
);

create or replace function public.prevent_release_database_identity_mutation() returns trigger
language plpgsql
set search_path = pg_catalog, public, pg_temp
as $$
begin
  raise exception 'Release database identity is immutable';
end;
$$;

create trigger trg_release_database_identity_immutable
before insert or update or delete or truncate on public.release_database_identity
for each statement execute function public.prevent_release_database_identity_mutation();

create or replace function public.prevent_release_target_receipt_mutation() returns trigger
language plpgsql
set search_path = pg_catalog, public, pg_temp
as $$
begin
  raise exception 'Release target receipts are append-only';
end;
$$;

create trigger trg_release_target_receipts_append_only
before update or delete or truncate on public.release_target_receipts
for each statement execute function public.prevent_release_target_receipt_mutation();

-- PL/pgSQL resolves unqualified objects using the caller's search_path unless
-- a function fixes its own path. Pin every existing application function so a
-- runtime role with a misconfigured schema grant cannot shadow lineage,
-- authority, or receipt inputs.
alter function public.canonical_jsonb_text(jsonb) set search_path = pg_catalog, public, pg_temp;
alter function public.enforce_active_counsel_attestation() set search_path = pg_catalog, public, pg_temp;
alter function public.enforce_active_standard_governance() set search_path = pg_catalog, public, pg_temp;
alter function public.enforce_agreement_document_lineage() set search_path = pg_catalog, public, pg_temp;
alter function public.enforce_agreement_execution_controls() set search_path = pg_catalog, public, pg_temp;
alter function public.enforce_analysis_review_attestation() set search_path = pg_catalog, public, pg_temp;
alter function public.enforce_analysis_run_lineage() set search_path = pg_catalog, public, pg_temp;
alter function public.enforce_chunk_execution_freeze() set search_path = pg_catalog, public, pg_temp;
alter function public.enforce_chunk_lineage() set search_path = pg_catalog, public, pg_temp;
alter function public.enforce_decision_condition_lifecycle() set search_path = pg_catalog, public, pg_temp;
alter function public.enforce_decision_condition_lineage() set search_path = pg_catalog, public, pg_temp;
alter function public.enforce_decision_disposition() set search_path = pg_catalog, public, pg_temp;
alter function public.enforce_decision_finding_lineage() set search_path = pg_catalog, public, pg_temp;
alter function public.enforce_decision_version_lifecycle() set search_path = pg_catalog, public, pg_temp;
alter function public.enforce_dependency_lineage() set search_path = pg_catalog, public, pg_temp;
alter function public.enforce_derived_text_hash() set search_path = pg_catalog, public, pg_temp;
alter function public.enforce_economics_run_lifecycle() set search_path = pg_catalog, public, pg_temp;
alter function public.enforce_execution_review_attestations() set search_path = pg_catalog, public, pg_temp;
alter function public.enforce_executive_snapshot_job_lineage() set search_path = pg_catalog, public, pg_temp;
alter function public.enforce_executive_summary_terminal_receipt() set search_path = pg_catalog, public, pg_temp;
alter function public.enforce_extraction_generation_lineage() set search_path = pg_catalog, public, pg_temp;
alter function public.enforce_finding_lineage() set search_path = pg_catalog, public, pg_temp;
alter function public.enforce_graph_job_lineage() set search_path = pg_catalog, public, pg_temp;
alter function public.enforce_graph_origin() set search_path = pg_catalog, public, pg_temp;
alter function public.enforce_human_review_record() set search_path = pg_catalog, public, pg_temp;
alter function public.enforce_legal_object_execution_freeze() set search_path = pg_catalog, public, pg_temp;
alter function public.enforce_open_validation_result_parent() set search_path = pg_catalog, public, pg_temp;
alter function public.enforce_relation_lineage() set search_path = pg_catalog, public, pg_temp;
alter function public.enforce_snapshot_manifest() set search_path = pg_catalog, public, pg_temp;
alter function public.enforce_term_lineage() set search_path = pg_catalog, public, pg_temp;
alter function public.enforce_terminal_validation_result_manifest() set search_path = pg_catalog, public, pg_temp;
alter function public.enforce_verified_document_hash() set search_path = pg_catalog, public, pg_temp;
alter function public.enforce_version_scoped_record() set search_path = pg_catalog, public, pg_temp;
alter function public.enforce_working_version_membership() set search_path = pg_catalog, public, pg_temp;
alter function public.executive_snapshot_receipt_verified(uuid) set search_path = pg_catalog, public, pg_temp;
alter function public.lock_documents_for_legal_publication(uuid[]) set search_path = pg_catalog, public, pg_temp;
alter function public.prevent_active_engine_policy_mutation() set search_path = pg_catalog, public, pg_temp;
alter function public.prevent_append_only_record_mutation() set search_path = pg_catalog, public, pg_temp;
alter function public.prevent_audit_event_mutation() set search_path = pg_catalog, public, pg_temp;
alter function public.prevent_bound_extraction_job_retarget() set search_path = pg_catalog, public, pg_temp;
alter function public.prevent_purge_on_hold() set search_path = pg_catalog, public, pg_temp;
alter function public.prevent_purge_request_on_hold() set search_path = pg_catalog, public, pg_temp;
alter function public.prevent_reviewed_object_mutation() set search_path = pg_catalog, public, pg_temp;
alter function public.prevent_source_identity_mutation() set search_path = pg_catalog, public, pg_temp;
alter function public.prevent_succeeded_job_mutation() set search_path = pg_catalog, public, pg_temp;
alter function public.prevent_terminal_analysis_run_mutation() set search_path = pg_catalog, public, pg_temp;
alter function public.prevent_terminal_decision_mutation() set search_path = pg_catalog, public, pg_temp;
alter function public.prevent_terminal_validation_run_mutation() set search_path = pg_catalog, public, pg_temp;
alter function public.prevent_unscanned_extraction() set search_path = pg_catalog, public, pg_temp;
alter function public.suppress_duplicate_contract_term() set search_path = pg_catalog, public, pg_temp;
alter function public.suppress_duplicate_document_relation() set search_path = pg_catalog, public, pg_temp;
alter function public.suppress_duplicate_term_dependency() set search_path = pg_catalog, public, pg_temp;

revoke all privileges on public.release_database_identity from public;
revoke all privileges on public.release_target_receipts from public;
revoke execute on function public.prevent_release_database_identity_mutation() from public;
revoke execute on function public.prevent_release_target_receipt_mutation() from public;
