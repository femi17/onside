-- Refined own-goal rule for "N goals in a row" (user-ruled 2026-08-15, Seoul v Daejeon):
-- an og is a scoreboard goal FOR the credited team, so it BREAKS the opponent's streak
-- (it is a "reply between"), but it never EXTENDS the credited team's streak (nobody
-- actively scored it). Supersedes the earlier og-fully-ignored version from today.
create or replace function public.goals_in_row_maxes(evs jsonb)
 returns table(mx_any integer, mx_home integer, mx_away integer)
 language plpgsql
 immutable
as $function$
declare
  s text; k text;
  cur text;
  run_any int := 0; max_any int := 0;
  run_home int := 0; max_home int := 0;
  run_away int := 0; max_away int := 0;
begin
  for s, k in
    select elem->>'side', elem->>'kind'
    from jsonb_array_elements(coalesce(evs, '[]'::jsonb)) as elem
    where elem->>'kind' in ('goal', 'pen', 'og')
    order by coalesce((elem->>'min')::int, 0), coalesce((elem->>'extra')::int, 0)
  loop
    if k = 'og' then
      -- reply by the credited side: reset the OTHER team's run; extend nothing
      if cur is not null and s is distinct from cur then cur := null; run_any := 0; end if;
      if s = 'away' then run_home := 0; end if;
      if s = 'home' then run_away := 0; end if;
      continue;
    end if;
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
