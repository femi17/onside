-- Permanent real-odds history. run-strategies already fetches full bookmaker odds (Match Winner,
-- Double Chance, Goals Over/Under, Corners Over/Under, BTTS, ...) for every priced fixture into
-- odds_cache, then purges it after 3 days (run-strategies maybeRecalibrate housekeeping). This
-- snapshots odds_cache into a PERMANENT store so the School and value analysis keep real prices —
-- with ZERO extra API calls. A pg_cron job refreshes it every 30 min; latest pre-kickoff odds win,
-- then persist forever once odds_cache is purged. (Owner-directed 2026-09-27.)
create table if not exists public.odds_snapshot (
  fixture_id bigint primary key,
  bookmakers jsonb not null,
  captured_at timestamptz not null default now()
);
alter table public.odds_snapshot enable row level security;
-- No public policies: only service_role / the cron owner (which bypass RLS) write it; app reads go
-- through admin-gated security-definer RPCs (same pattern as odds_cache / school_strategy_legs).
comment on table public.odds_snapshot is
  'Permanent real bookmaker odds per fixture, copied every 30 min from odds_cache before its 3-day purge. Zero extra API calls.';

-- seed immediately from whatever is cached right now
insert into public.odds_snapshot (fixture_id, bookmakers, captured_at)
select fixture_id, bookmakers, now() from public.odds_cache
on conflict (fixture_id) do update set bookmakers = excluded.bookmakers, captured_at = excluded.captured_at;

-- every 30 min: preserve freshly-fetched odds (latest pre-kickoff snapshot wins)
select cron.schedule('snapshot-odds', '*/30 * * * *', $$
  insert into public.odds_snapshot (fixture_id, bookmakers, captured_at)
  select fixture_id, bookmakers, now() from public.odds_cache
  on conflict (fixture_id) do update set bookmakers = excluded.bookmakers, captured_at = excluded.captured_at
$$);
