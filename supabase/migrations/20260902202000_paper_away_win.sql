-- Mirror of remotely applied migration `paper_away_win` (2026-09-02).
-- away_win was the one lab outcome missing from the paper roster (owner spotted the family
-- gap). Form-only conditions cap it at 43% on the fixtures backtest — it NEEDS the model
-- condition, which only settled picks can prove, which is exactly what a paper agent grows.
-- Roster is now 13; the LRU tick rotation absorbs it (12 ticks/morning, each strategy still
-- runs ~6 days a week).
do $$
begin
  insert into public.strategies
    (user_id, name, market_key, market_label, side, line, period, status,
     league_ids, league_mode, target_day, selectivity, min_edge, max_per_prediction,
     deliver_at, channels, learning, timezone)
  select '85a7776e-7c86-4c82-8f53-f8aa81f0bd0b', '📄 Paper · Away win', 'away_win', 'Away win', 'away', null, 'ft', 'draft',
         '{}', 'all', 'same_day', 'strong', 0, 30,
         '09:30:00', '{}', false, 'Africa/Lagos'
  where not exists (
    select 1 from public.strategies s
    where s.user_id = '85a7776e-7c86-4c82-8f53-f8aa81f0bd0b' and s.name = '📄 Paper · Away win'
  );
end $$;
