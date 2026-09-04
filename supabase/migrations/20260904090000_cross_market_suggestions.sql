-- Mirror of remotely applied migration cross_market_suggestions (2026-09-04).
-- Surfaces the best farmed cross-market signal per market as a ready-to-apply, plain-English rule.
-- The agent builder shows it opt-in ("🧬 Cross-market edge") below the proven rule, when the market
-- has no proven rule yet or the cross signal has landed a higher %. signal_key IS the engine rule
-- field (home_win_prob, over25_prob, etc. — all added to RULE_FIELDS in c39c318), so the generated
-- rule_text parses straight to that filter. Native pairs (a signal predicting its own market) are
-- excluded — those aren't cross-market discoveries. Read-only.
create or replace function public.cross_market_suggestions()
returns table(market_key text, market_label text, rule_text text, n integer, hit numeric, source text)
language sql
stable
security definer
set search_path to ''
as $$
  select distinct on (m.market_key)
    m.market_key,
    m.market_label,
    ('Only games where the model gives ' || case m.signal_key
        when 'btts_prob' then 'Both teams to score'
        when 'over25_prob' then 'Over 2.5 goals'
        when 'home_win_prob' then 'the home team'
        when 'away_win_prob' then 'the away team'
        when 'home_score_prob' then 'the home team'
        when 'away_score_prob' then 'the away team'
        when 'draw_prob' then 'the draw'
        else m.signal_key end
      || case m.signal_key
        when 'home_win_prob' then ' at least ' || round(m.threshold*100) || '% to win'
        when 'away_win_prob' then ' at least ' || round(m.threshold*100) || '% to win'
        when 'home_score_prob' then ' at least ' || round(m.threshold*100) || '% to score'
        when 'away_score_prob' then ' at least ' || round(m.threshold*100) || '% to score'
        else ' at least ' || round(m.threshold*100) || '% chance' end
    ) as rule_text,
    m.n, m.hit, 'signals'::text as source
  from public.model_signal_lab m
  where m.n >= 100 and m.hit >= 80
    and not (
      (m.signal_key='home_score_prob' and m.market_key='home_to_score') or
      (m.signal_key='away_score_prob' and m.market_key='away_to_score') or
      (m.signal_key='btts_prob' and m.market_key='btts') or
      (m.signal_key='over25_prob' and m.market_key='over_2_5') or
      (m.signal_key='home_win_prob' and m.market_key in ('home_win','double_chance_1x')) or
      (m.signal_key='away_win_prob' and m.market_key in ('away_win','double_chance_x2'))
    )
  order by m.market_key, m.wilson_lb desc;
$$;

grant execute on function public.cross_market_suggestions() to authenticated;
