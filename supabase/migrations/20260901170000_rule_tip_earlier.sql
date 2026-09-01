-- Owner-ruled: the night rule tip moves from 22:30 Lagos to 19:30 Lagos (18:30 UTC) —
-- mirroring the 7:30am morning slot. 10:30pm was too late for the audience.
select cron.unschedule('broadcast-rule-tip');
select cron.schedule('broadcast-rule-tip', '30 18 * * *', $$select public.invoke_community_broadcast('rule_tip')$$);
