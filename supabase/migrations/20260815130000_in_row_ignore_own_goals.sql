-- "N goals in a row" = the team ACTIVELY scoring N consecutive goals. An OWN GOAL is credited to
-- the opponent's tally on the scoreboard but is NOT that team scoring — so og events no longer
-- extend (or break) a streak. Ruled 2026-08-15 after FC Seoul v Daejeon: Seoul's 48' + 62'(og) +
-- 81' was counted as 3-in-a-row and false-settled the "no" bets; true active streak was 2.
-- (The settle_goals_in_row trigger's un-settle branch reopens wrongly-settled rows on the next
-- events change; the affected Seoul-fixture rows were reopened manually the same day.)
create or replace function public.goals_in_row_maxes(evs jsonb)
 returns table(mx_any integer, mx_home integer, mx_away integer)
 language plpgsql
 immutable
as $function$
declare
  s text;
  cur text;
  run_any int := 0; max_any int := 0;
  run_home int := 0; max_home int := 0;
  run_away int := 0; max_away int := 0;
begin
  for s in
    select elem->>'side'
    from jsonb_array_elements(coalesce(evs, '[]'::jsonb)) as elem
    where elem->>'kind' in ('goal', 'pen')  -- og excluded: an own goal is nobody's "scored" goal
    order by coalesce((elem->>'min')::int, 0), coalesce((elem->>'extra')::int, 0)
  loop
    if s is distinct from cur then cur := s; run_any := 1; else run_any := run_any + 1; end if;
    if run_any > max_any then max_any := run_any; end if;
    if s = 'home' then run_home := run_home + 1; if run_home > max_home then max_home := run_home; end if;
    else run_home := 0; end if;
    if s = 'away' then run_away := run_away + 1; if run_away > max_away then max_away := run_away; end if;
    else run_away := 0; end if;
  end loop;
  mx_any := max_any; mx_home := max_home; mx_away := max_away;
  return next;
end;
$function$;
