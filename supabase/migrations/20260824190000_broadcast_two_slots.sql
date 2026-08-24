-- Channel broadcasts 6x/day -> 2x/day (owner call, 2026-08-24: small audience, and each
-- post now doubles as social-media copy — fewer, better). Keeping the two slots with the
-- most shareable substance: morning_slate (the day's real fixtures) and results_recap
-- (the receipts). The other four slots stay invocable manually via
-- invoke_community_broadcast(slot) — only their schedules go.
select cron.unschedule('broadcast-education');
select cron.unschedule('broadcast-community');
select cron.unschedule('broadcast-kickoff-buzz');
select cron.unschedule('broadcast-top-picks');
