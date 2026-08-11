-- Community leaderboard = the day's best agents (not all-time). Top agents by how many of TODAY's
-- settled picks landed, among opted-in members. Returns landed/settled (e.g. 4/4). SECURITY DEFINER
-- so it can read opted-in members' picks (aggregate only); authenticated-only.
create or replace function public.community_daily_leaderboard()
returns table(user_id uuid, handle text, agent_name text, landed integer, settled integer)
language sql
security definer
set search_path to ''
as $function$
  select d.user_id, pr.handle, st.name as agent_name,
    sum((d.result = 'won')::int)::integer as landed,
    count(*)::integer as settled
  from public.deliveries d
  join public.strategies st on st.id = d.strategy_id
  join public.profiles pr on pr.id = d.user_id
  where d.result in ('won', 'lost')
    and (d.delivered_at at time zone 'Africa/Lagos')::date = (now() at time zone 'Africa/Lagos')::date
    and pr.leaderboard_opt_in = true and pr.handle is not null
  group by d.user_id, pr.handle, st.name
  order by sum((d.result = 'won')::int) desc, count(*) asc
  limit 3;
$function$;

revoke execute on function public.community_daily_leaderboard() from anon;
grant execute on function public.community_daily_leaderboard() to authenticated;
