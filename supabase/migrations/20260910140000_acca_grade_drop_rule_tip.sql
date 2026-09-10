-- Acca grading + retire rule tip (owner-directed 2026-09-10). community-broadcast (deployed
-- separately) gains an `acca_grade` slot: grades the public 5-leg acca as ONE result message, only
-- once EVERY leg has settled (last match ended) — never per-leg, so users aren't bombarded. Idempotent
-- via meta.graded on the acca post. Runs every 30 min; skips until all legs are in.
-- Rule tip retired: rules are now enforced platform-wide via the farming + agent-learning gates, so
-- the nightly "you wan rule for X?" post is redundant.
do $$ begin perform cron.unschedule('broadcast-acca-grade'); exception when others then null; end $$;
select cron.schedule('broadcast-acca-grade', '*/30 * * * *', $$select public.invoke_community_broadcast('acca_grade')$$);
do $$ begin perform cron.unschedule('broadcast-rule-tip'); exception when others then null; end $$;
