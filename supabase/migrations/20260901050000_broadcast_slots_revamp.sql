-- Channel revamp (owner-directed, 2026-09-01): morning becomes the target-hit flyer carousel
-- (one flyer per agent that swept its full card, album when several; honest day-record flyer
-- when none), afternoon becomes the product lesson directly (morning now owns the sweeps), and
-- night becomes a short rotating rule tip drawn from the glossary's market families.
select cron.unschedule('broadcast-morning-slate');
select cron.unschedule('broadcast-perfect-agent');
select cron.unschedule('broadcast-results-recap');

select cron.schedule('broadcast-agent-hits',  '30 6 * * *',  $$select public.invoke_community_broadcast('agent_hits')$$);
select cron.schedule('broadcast-product-gap', '30 13 * * *', $$select public.invoke_community_broadcast('product_gap')$$);
select cron.schedule('broadcast-rule-tip',    '30 21 * * *', $$select public.invoke_community_broadcast('rule_tip')$$);
