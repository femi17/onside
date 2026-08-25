-- Pick-level detail for /analytics (owner request): the settlement mix says WHERE picks
-- ended up, but not WHICH games agents delivered to real users. This RPC returns the last
-- 60 deliveries (internal accounts excluded, same rule as admin_analytics) with the fixture,
-- league, market, model %, result and settle score — its own small RPC so the big analytics
-- function stays untouched. Score display: settle_score is what settlement wrote for THAT
-- market (corners/cards show their own counts per the owner ruling), goals fall back to FT.
create or replace function public.admin_recent_picks()
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_admin boolean;
  v_excl uuid[];
begin
  select is_admin into v_admin from public.profiles where id = auth.uid();
  if not coalesce(v_admin, false) then raise exception 'not authorized'; end if;

  select coalesce(array_agg(p.id), '{}') into v_excl
  from public.profiles p
  left join auth.users u on u.id = p.id
  where p.is_admin = true
     or u.email in ('tyewoduola@gmail.com', 'demo@onside.com.ng', 'oduolafemi17@gmail.com');

  return (
    select coalesce(jsonb_agg(jsonb_build_object(
      'at', t.delivered_at,
      'who', t.who,
      'agent', t.agent,
      'home', t.home_team,
      'away', t.away_team,
      'league', t.league,
      'kickoff', t.kickoff_utc,
      'market', t.market,
      'prob', t.model_prob,
      'result', t.result,
      'score', t.score
    ) order by t.delivered_at desc), '[]'::jsonb)
    from (
      select d.delivered_at, d.model_prob,
        coalesce(nullif(p.display_name, ''), nullif(p.handle, ''), left(u.email, 3) || '***') as who,
        coalesce(s.name, 'Deleted agent') as agent,
        f.home_team, f.away_team, f.kickoff_utc,
        coalesce(l.name, '#' || f.league_id::text) as league,
        coalesce(nullif(d.market_label, ''), d.market_key) as market,
        coalesce(d.result, 'pending') as result,
        coalesce(d.settle_score,
          case when f.status in ('FT', 'AET', 'PEN') then f.ft_home::text || '-' || f.ft_away::text end) as score
      from public.deliveries d
      join public.fixtures f on f.id = d.fixture_id
      left join public.leagues l on l.id = f.league_id
      left join public.strategies s on s.id = d.strategy_id
      left join public.profiles p on p.id = d.user_id
      left join auth.users u on u.id = d.user_id
      where d.user_id <> all(v_excl)
      order by d.delivered_at desc
      limit 60
    ) t
  );
end;
$function$;
revoke all on function public.admin_recent_picks() from public, anon;
grant execute on function public.admin_recent_picks() to authenticated;
