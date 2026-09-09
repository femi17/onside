-- Engagement broadcast slots (owner-directed 2026-09-09): the @onsideai channel was only
-- broadcasting AT the audience (feature cards, rule tips) — no reason to tap/vote/return. Adds three
-- interactive slots in community-broadcast (deployed separately): native Telegram polls + an honest
-- deterministic results receipt. Cron (mirrors what was applied live):
--   receipt 08:00 UTC (09:00 Lagos) · poll 11:00 UTC (12:00) · banker 15:00 UTC (16:00)
-- alongside the existing agent-hits (06:30) and rule-tip (18:30) — 5 posts/day, engagement-forward.
do $$ begin perform cron.unschedule('broadcast-receipt'); exception when others then null; end $$;
do $$ begin perform cron.unschedule('broadcast-poll');    exception when others then null; end $$;
do $$ begin perform cron.unschedule('broadcast-banker');  exception when others then null; end $$;
select cron.schedule('broadcast-receipt', '0 8 * * *',  $$select public.invoke_community_broadcast('receipt')$$);
select cron.schedule('broadcast-poll',    '0 11 * * *', $$select public.invoke_community_broadcast('poll')$$);
select cron.schedule('broadcast-banker',  '0 15 * * *', $$select public.invoke_community_broadcast('banker')$$);
