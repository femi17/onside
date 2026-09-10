-- Public 5-leg acca broadcast (owner-directed 2026-09-10): "make we track am together, in public".
-- New `acca` slot in community-broadcast (deployed separately) picks the 5 highest-confidence
-- UPCOMING tier-tagged legs with sensible odds (1.25-2.5), one per fixture, posts the slip +
-- combined odds. Deterministic (no Claude). Cron mirrors what was applied live: 12:00 UTC (1pm Lagos).
do $$ begin perform cron.unschedule('broadcast-acca'); exception when others then null; end $$;
select cron.schedule('broadcast-acca', '0 12 * * *', $$select public.invoke_community_broadcast('acca')$$);
