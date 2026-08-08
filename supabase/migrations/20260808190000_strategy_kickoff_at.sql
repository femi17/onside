-- Optional kickoff-time pin for agents: "only games starting at 15:00". Stored as a local
-- time-of-day interpreted in the strategy's timezone; null = any kickoff time (old behaviour).
-- The engine (run-strategies) filters candidate fixtures whose local HH:MM matches exactly.
alter table public.strategies add column if not exists kickoff_at time;
