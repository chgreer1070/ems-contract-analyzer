-- ContractTwin graph, lineage, async processing, and validation schema

create table if not exists agreement_versions (
  id uuid primary key default gen_random_uuid(),
  matter_id uuid not null references matters(id) on delete cascade,
  version_number integer not null check (version_number > 0),
  label text not null,
  status text not null default 'WORKING' check (status in ('WORKING','APPROVED','EXECUTED','SUPERSEDED')),
  effective_date date,
  created_by text not null,
  created_at timestamptz not null default now(),
  unique(matter_id, version_number)
);

create table if not exists agreement_version_documents (
  agreement_version_id uuid not null references agreement_versions(id) on delete cascade,
  document_id uuid not null references documents(id) on delete cascade,
  display_order integer not null default 0,
  included_by text not null,
  included_at timestamptz not null default now(),
  primary key (agreement_version_id, document_id)
);

create table if not exists document_relations (
  id uuid primary key default gen_random_uuid(),
  matter_id uuid not null references matters(id) on delete cascade,
  source_document_id uuid not null references documents(id) on delete cascade,
  target_document_id uuid not null references documents(id) on delete cascade,
  relation_type text not null check (relation_type in ('AMENDS','SUPERSEDES','INCORPORATES','CONTROLS','CONFLICTS_WITH','IMPLEMENTS','REFERENCES')),
  source_locator text,
  rationale text,
  confidence numeric(5,4) check (confidence is null or (confidence >= 0 and confidence <= 1)),
  review_status text not null default 'UNREVIEWED' check (review_status in ('UNREVIEWED','VALIDATED','REJECTED')),
  created_by text not null,
  created_at timestamptz not null default now(),
  reviewed_by text,
  reviewed_at timestamptz,
  check (source_document_id <> target_document_id)
);

create table if not exists contract_terms (
  id uuid primary key default gen_random_uuid(),
  matter_id uuid not null references matters(id) on delete cascade,
  document_id uuid not null references documents(id) on delete cascade,
  chunk_id uuid references document_chunks(id) on delete set null,
  clause_family text not null,
  section_label text,
  term_type text not null check (term_type in ('OBLIGATION','RIGHT','PROHIBITION','CONDITION','REMEDY','DEFINITION','ALLOCATION')),
  party text,
  counterparty text,
  exact_text text not null,
  exact_text_sha256 text not null check (exact_text_sha256 ~ '^[0-9a-fA-F]{64}$'),
  normalized_statement text not null,
  trigger_event text,
  exceptions jsonb not null default '[]'::jsonb,
  operational_owner text,
  confidence numeric(5,4) not null default 0 check (confidence >= 0 and confidence <= 1),
  review_status text not null default 'UNREVIEWED' check (review_status in ('UNREVIEWED','VALIDATED','REJECTED','SUPERSEDED')),
  model_name text,
  prompt_version text,
  created_by text not null,
  created_at timestamptz not null default now(),
  reviewed_by text,
  reviewed_at timestamptz,
  review_note text
);

create table if not exists term_dependencies (
  id uuid primary key default gen_random_uuid(),
  matter_id uuid not null references matters(id) on delete cascade,
  source_term_id uuid not null references contract_terms(id) on delete cascade,
  target_term_id uuid not null references contract_terms(id) on delete cascade,
  dependency_type text not null check (dependency_type in ('TRIGGERS','LIMITS','OVERRIDES','CONDITIONS','PRICES','ALLOCATES_RISK','REQUIRES','TERMINATES','CONFLICTS_WITH')),
  rationale text not null,
  confidence numeric(5,4) not null default 0 check (confidence >= 0 and confidence <= 1),
  review_status text not null default 'UNREVIEWED' check (review_status in ('UNREVIEWED','VALIDATED','REJECTED')),
  created_by text not null,
  created_at timestamptz not null default now(),
  reviewed_by text,
  reviewed_at timestamptz,
  check (source_term_id <> target_term_id)
);

create table if not exists processing_jobs (
  id uuid primary key default gen_random_uuid(),
  matter_id uuid references matters(id) on delete cascade,
  document_id uuid references documents(id) on delete cascade,
  job_type text not null check (job_type in ('OCR','EXTRACT','ANALYZE','TERM_EXTRACT','DEPENDENCY','PRECEDENCE','EXECUTIVE_SUMMARY','VALIDATION')),
  status text not null default 'QUEUED' check (status in ('QUEUED','RUNNING','WAITING_EXTERNAL','SUCCEEDED','FAILED','CANCELLED')),
  priority integer not null default 100,
  attempts integer not null default 0,
  max_attempts integer not null default 3 check (max_attempts > 0),
  idempotency_key text not null unique,
  input jsonb not null default '{}'::jsonb,
  output jsonb,
  error_message text,
  external_operation_url text,
  locked_by text,
  locked_at timestamptz,
  next_attempt_at timestamptz not null default now(),
  created_by text not null,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz
);

create table if not exists analysis_runs (
  id uuid primary key default gen_random_uuid(),
  matter_id uuid not null references matters(id) on delete cascade,
  document_id uuid references documents(id) on delete set null,
  run_type text not null check (run_type in ('CLAUSE_RISK','TERM_EXTRACTION','DEPENDENCY','PRECEDENCE','EXECUTIVE_SUMMARY')),
  status text not null check (status in ('RUNNING','SUCCEEDED','FAILED','PARTIAL')),
  model_name text,
  prompt_version text not null,
  schema_version text not null,
  input_sha256 text not null check (input_sha256 ~ '^[0-9a-fA-F]{64}$'),
  source_chunk_count integer not null default 0,
  output_count integer not null default 0,
  rejected_ungrounded_count integer not null default 0,
  metrics jsonb not null default '{}'::jsonb,
  error_message text,
  created_by text not null,
  started_at timestamptz not null default now(),
  finished_at timestamptz
);

create table if not exists validation_cases (
  id text primary key,
  category text not null,
  title text not null,
  source_text text not null,
  expected_families jsonb not null,
  prohibited_families jsonb not null default '[]'::jsonb,
  expected_risk_floor text,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists validation_runs (
  id uuid primary key default gen_random_uuid(),
  run_label text not null,
  model_name text,
  prompt_version text not null,
  corpus_version text not null,
  status text not null check (status in ('RUNNING','PASSED','FAILED')),
  total_cases integer not null default 0,
  passed_cases integer not null default 0,
  grounded_precision numeric(7,6),
  family_recall numeric(7,6),
  unsafe_policy_invention_count integer not null default 0,
  exact_quote_failure_count integer not null default 0,
  started_by text not null,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  summary jsonb not null default '{}'::jsonb
);

create table if not exists validation_results (
  id uuid primary key default gen_random_uuid(),
  validation_run_id uuid not null references validation_runs(id) on delete cascade,
  validation_case_id text not null references validation_cases(id),
  passed boolean not null,
  detected_families jsonb not null default '[]'::jsonb,
  missing_families jsonb not null default '[]'::jsonb,
  prohibited_detected jsonb not null default '[]'::jsonb,
  grounded boolean not null default false,
  notes text,
  raw_result jsonb not null default '{}'::jsonb,
  unique(validation_run_id, validation_case_id)
);

create table if not exists executive_snapshots (
  id uuid primary key default gen_random_uuid(),
  matter_id uuid not null references matters(id) on delete cascade,
  agreement_version_id uuid references agreement_versions(id) on delete set null,
  snapshot_version integer not null,
  top_risks jsonb not null default '[]'::jsonb,
  quantified_exposure jsonb not null default '{}'::jsonb,
  dependencies jsonb not null default '[]'::jsonb,
  negotiation_actions jsonb not null default '[]'::jsonb,
  executive_decisions jsonb not null default '[]'::jsonb,
  next_steps jsonb not null default '[]'::jsonb,
  source_state_hash text not null check (source_state_hash ~ '^[0-9a-fA-F]{64}$'),
  generated_by text not null,
  generated_at timestamptz not null default now(),
  unique(matter_id, snapshot_version)
);

create index if not exists idx_agreement_versions_matter on agreement_versions(matter_id, version_number desc);
create index if not exists idx_document_relations_matter on document_relations(matter_id, relation_type);
create index if not exists idx_contract_terms_matter on contract_terms(matter_id, clause_family, review_status);
create index if not exists idx_contract_terms_document on contract_terms(document_id, created_at desc);
create index if not exists idx_term_dependencies_matter on term_dependencies(matter_id, dependency_type);
create index if not exists idx_processing_jobs_ready on processing_jobs(status, next_attempt_at, priority, created_at);
create index if not exists idx_analysis_runs_matter on analysis_runs(matter_id, started_at desc);
create index if not exists idx_validation_results_run on validation_results(validation_run_id);
create index if not exists idx_executive_snapshots_matter on executive_snapshots(matter_id, snapshot_version desc);
