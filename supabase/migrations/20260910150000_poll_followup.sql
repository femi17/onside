-- Poll follow-up (owner-directed 2026-09-10): the daily sentiment poll ("you think e go enter?") gets
-- ONE follow-up when its match settles — NOT another prediction poll. poll_grade reports landed/missed
-- and asks users if they'd added it to their slip. Idempotent via meta.followed_up on the poll post.
-- community-broadcast deployed separately; cron every 30 min (skips until the polled pick settles).
do $$ begin perform cron.unschedule('broadcast-poll-grade'); exception when others then null; end $$;
select cron.schedule('broadcast-poll-grade', '*/30 * * * *', $$select public.invoke_community_broadcast('poll_grade')$$);
