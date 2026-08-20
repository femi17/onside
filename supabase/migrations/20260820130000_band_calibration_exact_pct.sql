-- Owner-ruled 2026-08-20 (second pass): calibration cells are EXACT integer percents, not
-- 10-point bands — "80-90% won't make us know if 82-84 is failing". Every surface (engine
-- bandVeto, feed % colour, /performance calibration card) studies family x exact %.
-- Return signature changes, so the old function must drop first.
drop function if exists public.band_calibration();
create function public.band_calibration()
returns table(family text, pct int, n bigint, won bigint, prob_sum numeric)
language sql
security definer
set search_path = public
stable
as $$
  select
    case
      when market_key ~ 'corner' then 'corners'
      when market_key ~ 'card|booking' then 'cards'
      when market_key ~ '1up|2up|never_down' then 'early'
      when market_key ~ '^(home_win|away_win|draw$|result_1x2|double_chance|dnb|handicap)' then 'result'
      when market_key ~ '^(home_to_score|away_to_score|btts|home_clean_sheet|away_clean_sheet|home_win_to_nil|away_win_to_nil)' then 'score'
      else 'goals'
    end as family,
    round(model_prob * 100)::int as pct,
    count(*) as n,
    count(*) filter (where result = 'won') as won,
    sum(model_prob) as prob_sum
  from deliveries
  where model_prob is not null and result in ('won', 'lost')
  group by 1, 2
$$;
revoke all on function public.band_calibration() from public;
grant execute on function public.band_calibration() to authenticated;
