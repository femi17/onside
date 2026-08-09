-- Onside Best: the pick-of-the-picks layer for multi-agent plans (pro / pro_max).
-- Once every running agent scheduled for the day has delivered, run-strategies has Claude read
-- the whole board and keep only the strongest picks (at most 15, ranked, one reason each).
-- One set per user per local day; written by the engine (service role), read by the owner.
create table public.onside_best (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  set_date date not null,
  picks jsonb not null,          -- [{ delivery_id, rank, reason }]
  summary text,
  created_at timestamptz not null default now(),
  unique (user_id, set_date)
);
alter table public.onside_best enable row level security;
create policy "read own best" on public.onside_best for select using (auth.uid() = user_id);
