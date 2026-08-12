create table if not exists api_rate_events (
  id bigserial primary key,
  actor_user_id text not null,
  action text not null,
  occurred_at timestamptz not null default now()
);

create index if not exists idx_api_rate_events_lookup
  on api_rate_events(actor_user_id, action, occurred_at desc);
