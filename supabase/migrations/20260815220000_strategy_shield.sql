-- 🛡️ Onside Shield (opt-in per agent): when on, the engine refuses to pick games from leagues
-- where THIS agent is measurably failing (>=5 settled picks in the league, under 45% won —
-- recomputed every run, so a league can earn its way back). Toggled from the Performance page.
alter table public.strategies add column if not exists shield boolean not null default false;
