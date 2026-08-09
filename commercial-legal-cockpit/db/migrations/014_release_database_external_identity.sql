-- Preserve migration 010's immutable database-generated identity while adding
-- a forward-only mapping to the externally approved logical production ID.
-- Release receipts continue to bind the physical database identity; the
-- separately owned target anchor binds the approved logical endpoint identity.

create table public.release_database_external_identity (
  singleton boolean primary key default true,
  external_database_id uuid not null unique,
  release_database_id uuid not null unique references public.release_database_identity(database_id) on update restrict on delete restrict,
  created_at timestamptz not null default clock_timestamp(),
  constraint release_database_external_identity_singleton_check check (singleton)
);

insert into public.release_database_external_identity(
  singleton,external_database_id,release_database_id
)
select
  true,
  coalesce(
    nullif(current_setting('contracttwin.expected_database_id',true),'')::uuid,
    identity_record.database_id
  ),
  identity_record.database_id
from public.release_database_identity identity_record
where identity_record.singleton=true;

create or replace function public.prevent_release_database_external_identity_mutation() returns trigger
language plpgsql
set search_path = pg_catalog, public, pg_temp
as $$
begin
  raise exception 'Release database external identity is immutable';
end;
$$;

create trigger trg_release_database_external_identity_immutable
before insert or update or delete or truncate on public.release_database_external_identity
for each statement execute function public.prevent_release_database_external_identity_mutation();

revoke all privileges on public.release_database_external_identity from public;
revoke execute on function public.prevent_release_database_external_identity_mutation() from public;
