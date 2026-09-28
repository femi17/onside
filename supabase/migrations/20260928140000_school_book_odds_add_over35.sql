-- Onside School — teach school_book_odds() the Over 3.5 line too.
-- When a leg's real Over 2.5 book odds are 1.10 or below the game is so high-scoring that Over 2.5 pays
-- almost nothing; the page then upgrades that leg to Over 3.5 (owner-directed 2026-09-28) and needs the
-- real Over 3.5 median odd to price it. Same bet id 5 (Goals Over/Under), value "Over 3.5". Additive —
-- every existing (fixture, market) row this RPC returned is unchanged.
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
    ('over_3_5', 5, 'Over 3.5'),
    ('dc_1x',   12, 'Home/Draw'),
    ('home',     1, 'Home')
  ) as m(market, bet_id, val)
  where os.fixture_id = any(p_fixture_ids)
    and public.book_median_odd(os.bookmakers, m.bet_id, m.val) is not null;
$function$;

revoke all on function public.school_book_odds(bigint[]) from public, anon;
grant execute on function public.school_book_odds(bigint[]) to authenticated;
