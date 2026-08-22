-- Kickoff window end for agents: with kickoff_at set, "only games starting between
-- kickoff_at and kickoff_until" (inclusive, local time in the strategy's timezone).
-- null = the old exact-time pin on kickoff_at alone; kickoff_until < kickoff_at wraps
-- past midnight (22:00–01:00 = late kickoffs). Ignored when kickoff_at is null.
alter table public.strategies add column if not exists kickoff_until time;
