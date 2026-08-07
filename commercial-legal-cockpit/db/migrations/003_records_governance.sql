-- Legal records governance: classification, retention, legal hold, and controlled purge state.

alter table matters
  add column if not exists confidentiality_level text not null default 'CONFIDENTIAL'
    check (confidentiality_level in ('INTERNAL','CONFIDENTIAL','PRIVILEGED','RESTRICTED')),
  add column if not exists privilege_status text not null default 'NOT_ASSESSED'
    check (privilege_status in ('NOT_ASSESSED','PRIVILEGED','WORK_PRODUCT','NON_PRIVILEGED','MIXED')),
  add column if not exists legal_hold boolean not null default false,
  add column if not exists legal_hold_reason text,
  add column if not exists retention_category text,
  add column if not exists retention_until date;

alter table documents
  add column if not exists legal_hold boolean not null default false,
  add column if not exists retention_until date,
  add column if not exists deletion_status text not null default 'ACTIVE'
    check (deletion_status in ('ACTIVE','PENDING_PURGE','PURGED')),
  add column if not exists purged_at timestamptz,
  add column if not exists purged_by text;

create table if not exists legal_hold_events (
  id uuid primary key default gen_random_uuid(),
  matter_id uuid not null references matters(id) on delete restrict,
  document_id uuid references documents(id) on delete restrict,
  action text not null check (action in ('HOLD_APPLIED','HOLD_RELEASED')),
  reason text not null,
  actor_user_id text not null,
  actor_name text not null,
  event_time timestamptz not null default now()
);

create table if not exists purge_requests (
  id uuid primary key default gen_random_uuid(),
  matter_id uuid not null references matters(id) on delete restrict,
  document_id uuid not null references documents(id) on delete restrict,
  requested_by text not null,
  requested_at timestamptz not null default now(),
  reason text not null,
  status text not null default 'PENDING' check (status in ('PENDING','APPROVED','REJECTED','EXECUTED','CANCELLED')),
  approved_by text,
  approved_at timestamptz,
  executed_by text,
  executed_at timestamptz
);

create unique index if not exists uq_open_purge_request_per_document
  on purge_requests(document_id)
  where status in ('PENDING','APPROVED');

create or replace function prevent_purge_on_hold() returns trigger as $$
begin
  if new.deletion_status in ('PENDING_PURGE','PURGED') then
    if new.legal_hold = true or exists(select 1 from matters m where m.id=new.matter_id and m.legal_hold=true) then
      raise exception 'Source document cannot be purged while a legal hold is active';
    end if;
  end if;
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_prevent_purge_on_hold on documents;
create trigger trg_prevent_purge_on_hold
before update of deletion_status on documents
for each row execute function prevent_purge_on_hold();

create index if not exists idx_matters_governance on matters(legal_hold, confidentiality_level, retention_until);
create index if not exists idx_documents_retention on documents(deletion_status, retention_until, legal_hold);
create index if not exists idx_legal_hold_events_matter on legal_hold_events(matter_id, event_time desc);
create index if not exists idx_purge_requests_status on purge_requests(status, requested_at);
