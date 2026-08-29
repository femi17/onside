-- Afternoon channel slot (owner request 2026-08-29): the 2:30pm post is now the "perfect agent
-- card". If any agent swept its WHOLE card yesterday (Lagos), community-broadcast posts that
-- perfect-agent flyer image (/flyer/results) to @onsideai; on days with no sweep it falls back to
-- the product_gap text lesson (unchanged old behaviour). Same 13:30 UTC = 14:30 Lagos slot as
-- before — only the slot name the cron passes changes (product_gap -> perfect_agent).
select cron.unschedule('broadcast-product-gap');
select cron.schedule(
  'broadcast-perfect-agent',
  '30 13 * * *',
  $$select public.invoke_community_broadcast('perfect_agent')$$
);
