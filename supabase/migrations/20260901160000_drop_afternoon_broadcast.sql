-- Owner-ruled: the channel posts TWICE a day — morning target-hit flyers, night rule tip.
-- The afternoon product_gap cron survives from the old 3x cadence; drop it. product_gap
-- stays manually invocable via invoke_community_broadcast('product_gap').
select cron.unschedule('broadcast-product-gap');
