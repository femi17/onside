-- 1UP joins the paper roster (owner-directed 2026-09-02). Mirror of remotely applied migration
-- `paper_1up`. Home/away "win and go 1 up" can't be backtested from final scores (it settles on
-- the lead PATH — a 1-1 draw wins or loses depending on who led), and only 24 settled picks
-- exist (62.5%). Two more demo-owned paper drafts grow the real graded sample daily through the
-- existing quiet-run cron; the deliveries-based proven-rules grid picks them up as they
-- accumulate. The path-based fixtures backtest needs event sequences (2,763 games covered
-- today) — a collect-stats extension deriving lead-path flags from the batched provider
-- response is the queued follow-up.
do $$
declare
  v_user uuid := '85a7776e-7c86-4c82-8f53-f8aa81f0bd0b'; -- demo@onside.com.ng
  m record;
begin
  for m in select * from (values
    ('home_win_1up', 'Home win · 1UP', 'home'),
    ('away_win_1up', 'Away win · 1UP', 'away')
  ) t(mk, label, side)
  loop
    insert into public.strategies
      (user_id, name, market_key, market_label, side, line, period, status,
       league_ids, league_mode, target_day, selectivity, min_edge, max_per_prediction,
       deliver_at, channels, learning, timezone)
    select v_user, '📄 Paper · ' || m.label, m.mk, m.label, m.side, null, 'ft', 'draft',
           '{}', 'all', 'same_day', 'strong', 0, 30,
           '09:30:00', '{}', false, 'Africa/Lagos'
    where not exists (
      select 1 from public.strategies s
      where s.user_id = v_user and s.name = '📄 Paper · ' || m.label
    );
  end loop;
end $$;
