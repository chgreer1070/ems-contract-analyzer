-- Better Auth 1.7 identifies a Microsoft account by the Entra directory
-- object id (oid), not by the app-specific subject (sub) stored in 1.6.
-- This table records that the one-time move finished. It does not itself
-- rewrite account rows. The auth migrator does that in the same release,
-- after this table exists, and refuses to finish while any Microsoft row
-- is still unproven. The row is inserted by that migrator, not by this file,
-- so a database that has not run the move cannot look complete.

create table public.microsoft_account_oid_cutover (
  singleton boolean primary key default true,
  better_auth_version text not null,
  provider_ids text[] not null,
  account_row_count integer not null,
  rewritten_row_count integer not null,
  mapping_sha256 text not null,
  applied_at timestamptz not null default clock_timestamp(),
  constraint microsoft_account_oid_cutover_singleton_check check (singleton),
  constraint microsoft_account_oid_cutover_version_check check (better_auth_version = '1.7.14'),
  constraint microsoft_account_oid_cutover_provider_ids_check
    check (provider_ids <@ array['microsoft','microsoft-entra-id']::text[]),
  constraint microsoft_account_oid_cutover_account_row_count_check check (account_row_count >= 0),
  constraint microsoft_account_oid_cutover_rewritten_row_count_check
    check (rewritten_row_count >= 0 and rewritten_row_count <= account_row_count),
  constraint microsoft_account_oid_cutover_mapping_sha256_check
    check (mapping_sha256 ~ '^[0-9a-f]{64}$')
);

create or replace function public.prevent_microsoft_account_oid_cutover_mutation() returns trigger
language plpgsql
set search_path = pg_catalog, public, pg_temp
as $$
begin
  raise exception 'Microsoft account directory-id cutover receipt is immutable';
end;
$$;

create trigger trg_microsoft_account_oid_cutover_immutable
before update or delete or truncate on public.microsoft_account_oid_cutover
for each statement execute function public.prevent_microsoft_account_oid_cutover_mutation();

revoke all privileges on public.microsoft_account_oid_cutover from public;
revoke execute on function public.prevent_microsoft_account_oid_cutover_mutation() from public;
