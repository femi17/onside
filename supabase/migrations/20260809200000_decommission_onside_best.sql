-- Onside Double supersedes Onside Best as the flagship "bet this today". Decommission the Best
-- pipeline: stop its */15 cron and drop its build function. The onside_best TABLE and its data are
-- KEPT for now (no data loss) — they can be dropped in a separate migration later. The old
-- run-strategies LLM fallback that also wrote onside_best was removed in the same change, so with
-- the cron gone nothing writes this table anymore.
select cron.unschedule('onside-best-gate');
drop function if exists public.build_onside_best();
