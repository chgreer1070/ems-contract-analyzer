-- EMS Commercial Legal Cockpit application schema
-- Apply only to an approved PostgreSQL database. Better Auth manages its own auth tables.

create extension if not exists pgcrypto;

create table if not exists app_user_roles (
  user_id text primary key,
  role text not null check (role in ('VIEWER','LAWYER','APPROVER','ADMIN')),
  active boolean not null default true,
  granted_by text,
  granted_at timestamptz not null default now()
);

create table if not exists customers (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  external_key text unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists matters (
  id uuid primary key default gen_random_uuid(),
  matter_number text not null unique,
  customer_id uuid not null references customers(id),
  agreement_title text not null,
  region text not null,
  annual_revenue numeric(18,2) not null default 0 check (annual_revenue >= 0),
  stage text not null default 'Intake',
  risk_level text not null default 'Medium' check (risk_level in ('Low','Medium','High','Critical')),
  next_action text not null default 'Complete source-grounded review',
  owner_user_id text not null,
  restricted boolean not null default false,
  status text not null default 'OPEN' check (status in ('OPEN','ON_HOLD','APPROVED','EXECUTED','CLOSED')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists matter_members (
  matter_id uuid not null references matters(id) on delete cascade,
  user_id text not null,
  access_level text not null check (access_level in ('VIEW','EDIT','APPROVE')),
  granted_by text not null,
  granted_at timestamptz not null default now(),
  primary key (matter_id, user_id)
);

create table if not exists documents (
  id uuid primary key default gen_random_uuid(),
  matter_id uuid not null references matters(id) on delete cascade,
  filename text not null,
  document_type text not null check (document_type in ('MSA','SOW','AMENDMENT','EXHIBIT','QUALITY','PRICING','PURCHASE_ORDER','OTHER')),
  version_label text,
  mime_type text not null,
  size_bytes bigint not null check (size_bytes >= 0),
  blob_url text not null,
  blob_pathname text not null,
  sha256 text check (sha256 is null or sha256 ~ '^[0-9a-fA-F]{64}$'),
  server_sha256 text check (server_sha256 is null or server_sha256 ~ '^[0-9a-fA-F]{64}$'),
  integrity_status text not null default 'CLIENT_HASHED' check (integrity_status in ('PENDING','CLIENT_HASHED','SERVER_VERIFIED','FAILED')),
  extraction_status text not null default 'PENDING' check (extraction_status in ('PENDING','EXTRACTED','OCR_REQUIRED','FAILED')),
  extraction_method text,
  extracted_at timestamptz,
  page_count integer check (page_count is null or page_count >= 0),
  precedence_rank integer,
  source_status text not null default 'CURRENT' check (source_status in ('CURRENT','SUPERSEDED','DRAFT','EXECUTED','REFERENCE')),
  uploaded_by text not null,
  uploaded_at timestamptz not null default now()
);

create table if not exists document_chunks (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references documents(id) on delete cascade,
  matter_id uuid not null references matters(id) on delete cascade,
  page_number integer check (page_number is null or page_number > 0),
  chunk_index integer not null check (chunk_index >= 0),
  content text not null,
  content_sha256 text not null check (content_sha256 ~ '^[0-9a-fA-F]{64}$'),
  created_at timestamptz not null default now(),
  unique(document_id, page_number, chunk_index)
);

create table if not exists negotiation_standards (
  id uuid primary key default gen_random_uuid(),
  clause_family text not null,
  title text not null,
  standard_position text not null,
  fallback_position text,
  no_go_position text,
  approval_authority text,
  business_rationale text,
  active boolean not null default false,
  version text not null,
  effective_date date not null,
  created_by text not null,
  created_at timestamptz not null default now(),
  unique (clause_family, version)
);

create table if not exists findings (
  id uuid primary key default gen_random_uuid(),
  matter_id uuid not null references matters(id) on delete cascade,
  document_id uuid references documents(id) on delete set null,
  clause_family text,
  issue text not null,
  risk_level text not null check (risk_level in ('Low','Medium','High','Critical')),
  rationale text not null,
  operational_consequence text,
  source_excerpt text not null,
  source_locator text,
  primary_position text,
  fallback_position text,
  no_go_position text,
  approval_required text,
  financial_variables jsonb not null default '[]'::jsonb,
  uncertainty text,
  review_status text not null default 'UNREVIEWED' check (review_status in ('UNREVIEWED','VALIDATED','REJECTED','SUPERSEDED')),
  model_name text,
  prompt_version text,
  standard_status text not null default 'MISSING' check (standard_status in ('APPROVED','MISSING','ILLUSTRATIVE')),
  standard_version text,
  created_by text not null,
  created_at timestamptz not null default now(),
  reviewed_by text,
  reviewed_at timestamptz,
  review_note text
);

create table if not exists decisions (
  id uuid primary key default gen_random_uuid(),
  matter_id uuid not null references matters(id) on delete cascade,
  finding_id uuid references findings(id) on delete set null,
  decision_type text not null check (decision_type in ('ACCEPT','NEGOTIATE','ESCALATE','REJECT','APPROVE_EXCEPTION')),
  rationale text not null,
  conditions text,
  decision_status text not null default 'PENDING' check (decision_status in ('PENDING','APPROVED','REJECTED','WITHDRAWN')),
  requested_by text not null,
  required_approver_role text,
  decided_by text,
  requested_at timestamptz not null default now(),
  decided_at timestamptz
);

create table if not exists economics_runs (
  id uuid primary key default gen_random_uuid(),
  matter_id uuid references matters(id) on delete cascade,
  inputs jsonb not null,
  outputs jsonb not null,
  formula_version text not null,
  created_by text not null,
  created_at timestamptz not null default now()
);

create table if not exists audit_events (
  id bigint generated always as identity primary key,
  event_time timestamptz not null default now(),
  actor_user_id text not null,
  actor_name text not null,
  action text not null,
  matter_id uuid references matters(id) on delete set null,
  entity_type text not null,
  entity_id text,
  metadata jsonb not null default '{}'::jsonb
);

create index if not exists idx_matters_customer on matters(customer_id);
create index if not exists idx_matters_owner on matters(owner_user_id);
create index if not exists idx_matter_members_user on matter_members(user_id);
create index if not exists idx_documents_matter on documents(matter_id, uploaded_at desc);
create index if not exists idx_document_chunks_document on document_chunks(document_id, page_number, chunk_index);
create index if not exists idx_document_chunks_matter on document_chunks(matter_id);
create index if not exists idx_findings_matter on findings(matter_id, created_at desc);
create index if not exists idx_findings_review on findings(review_status, risk_level);
create index if not exists idx_decisions_matter on decisions(matter_id, requested_at desc);
create index if not exists idx_audit_matter on audit_events(matter_id, event_time desc);
create index if not exists idx_audit_actor on audit_events(actor_user_id, event_time desc);
create unique index if not exists uq_active_standard_per_family on negotiation_standards(clause_family) where active = true;

create or replace function prevent_audit_event_mutation()
returns trigger language plpgsql as $$
begin
  raise exception 'audit_events is append-only';
end;
$$;

drop trigger if exists audit_events_no_update on audit_events;
create trigger audit_events_no_update
before update or delete on audit_events
for each row execute function prevent_audit_event_mutation();
