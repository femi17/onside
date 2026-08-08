-- Shared cross-isolate cache for API-Football lookups (team form, head-to-head). The engine's
-- in-memory day caches die with each isolate and are per-shard, so two shards (or a cold start)
-- used to re-buy the same team's form on the same day. One fetch now lands here and every
-- isolate reuses it. Service-role only (RLS on, no policies); pruned daily by run-strategies.
create table if not exists public.api_cache (
  cache_key text primary key,
  payload jsonb not null,
  fetched_at timestamptz not null default now()
);
alter table public.api_cache enable row level security;
create index if not exists api_cache_fetched_idx on public.api_cache (fetched_at);
