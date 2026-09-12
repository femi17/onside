-- Disk-IO fix (2026-09-12): fixtures.home_team_id / away_team_id were UNINDEXED foreign keys, so the
-- engine's per-run form + head-to-head queries (buildFormMap / buildH2HMap, run every cron tick ×4
-- shards) sequentially scanned the whole 236 MB fixtures table — 14k seq scans / 5.2 billion rows,
-- the dominant Disk IO consumer flagged by Supabase. These indexes turn those into index scans.
-- (Applied to prod with CREATE INDEX CONCURRENTLY to avoid locking live poll writes; plain here.)
create index if not exists fixtures_home_team_id_idx on public.fixtures (home_team_id);
create index if not exists fixtures_away_team_id_idx on public.fixtures (away_team_id);

-- drop duplicate indexes (advisor 0009) — wasted write IO on every insert
drop index if exists public.profiles_handle_lower_uidx;   -- dup of profiles_handle_unique
drop index if exists public.onside_best_user_date_uq;     -- dup of onside_best_user_id_set_date_key
