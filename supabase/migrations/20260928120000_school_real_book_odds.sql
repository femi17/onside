-- Onside School — price legs off the REAL bookmaker odds, not the model estimate.
-- Problem: school_strategy_legs()/the live double only carry the model probability; the page turns
-- that into 1/prob (with a 6% margin nudge). The model's Over 2.5 prob runs high, so 1/prob shows
-- ~1.3 where the real book line is ~1.9-2.1 — the displayed odds (and profit) read far too low.
-- Fix: run-strategies already banks full bookmaker odds into odds_snapshot (permanent, refreshed every
-- 30 min, ZERO extra API calls). This exposes the median real odd per (fixture, market) so the page can
-- price on real money. DISPLAY-ONLY: this feeds the shown odds/profit, never selection or settlement.
--
-- Median market odds are public information (anyone can read a book), and admin-entered School odds are
-- already world-readable (school_leg_odds), so this RPC is callable by any signed-in user — the caller
-- can only price fixtures it already passes in.

-- Median decimal odd for a (bet id, outcome value) across a fixture's bookmakers jsonb (API-Football
-- shape: [{ bets: [{ id, values: [{ value, odd }] }] }]). NULL when no book quotes that selection.
create or replace function public.book_median_odd(p_bms jsonb, p_bet_id int, p_value text)
returns numeric
language sql
immutable
set search_path to ''
as $function$
  select percentile_cont(0.5) within group (order by od)
  from (
    select (v->>'odd')::numeric as od
    from jsonb_array_elements(coalesce(p_bms, '[]'::jsonb)) bm,
         jsonb_array_elements(coalesce(bm->'bets', '[]'::jsonb)) bt,
         jsonb_array_elements(coalesce(bt->'values', '[]'::jsonb)) v
    where (bt->>'id') = p_bet_id::text
      and v->>'value' = p_value
      and v->>'odd' ~ '^[0-9]+(\.[0-9]+)?$'
  ) s
  where od > 1;
$function$;

-- Real median odds per (fixture, market) for the School lines. over_2_5 -> Goals O/U (bet 5) "Over 2.5";
-- dc_1x -> Double Chance (bet 12) "Home/Draw"; home -> Match Winner (bet 1) "Home". Rows with no real
-- odds are omitted (the page falls back to the model estimate for those, prefixed "~").
create or replace function public.school_book_odds(p_fixture_ids bigint[])
returns table(fixture_id bigint, market text, book_odds numeric)
language sql
stable
security definer
set search_path to ''
as $function$
  select os.fixture_id, m.market, public.book_median_odd(os.bookmakers, m.bet_id, m.val) as book_odds
  from public.odds_snapshot os
  cross join (values
    ('over_2_5', 5, 'Over 2.5'),
    ('dc_1x',   12, 'Home/Draw'),
    ('home',     1, 'Home')
  ) as m(market, bet_id, val)
  where os.fixture_id = any(p_fixture_ids)
    and public.book_median_odd(os.bookmakers, m.bet_id, m.val) is not null;
$function$;

revoke all on function public.school_book_odds(bigint[]) from public, anon;
grant execute on function public.school_book_odds(bigint[]) to authenticated;
