-- Owner-ruled 2026-08-20 (fourth pass): no generalizing across markets — "it can be failing
-- in one bet area and work for the other". A calibration cell is the EXACT bet: market_key +
-- side + line + period + exact %, so "over 1.5 @ 76%" and "home to score @ 76%" keep separate
-- ledgers. Return signature changes, so the old function drops first.
drop function if exists public.band_calibration();
create function public.band_calibration()
returns table(market_key text, side text, line numeric, period text, pct int, n bigint, won bigint, prob_sum numeric)
language sql
security definer
set search_path = public
stable
as $$
  select
    market_key,
    side,
    line,
    coalesce(period, 'ft') as period,
    round(model_prob * 100)::int as pct,
    count(*) as n,
    count(*) filter (where result = 'won') as won,
    sum(model_prob) as prob_sum
  from deliveries
  where model_prob is not null and result in ('won', 'lost')
  group by 1, 2, 3, 4, 5
$$;
revoke all on function public.band_calibration() from public;
grant execute on function public.band_calibration() to authenticated;
