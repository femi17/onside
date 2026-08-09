-- Community leaderboard: only show an agent once it has run a FULL day — i.e. it has at least one
-- day on which every prediction it delivered is settled (nothing still pending) with real results.
-- Previously an agent appeared on 20+ settled picks regardless of whether any day had fully cleared,
-- so an agent mid-way through its first slate (or with picks scattered across never-finished days)
-- could show up. This adds the "cleared a full day" gate to both leaderboard builders.

-- true once the strategy has any delivered_at day with 0 pending picks and >=1 won/lost result
create or replace function public.strategy_has_full_day(p_strategy_id uuid)
returns boolean
language sql
stable
security definer
set search_path to ''
as $function$
  select exists (
    select 1
    from public.deliveries d
    where d.strategy_id = p_strategy_id and d.delivered_at is not null
    group by (d.delivered_at at time zone 'Africa/Lagos')::date
    having count(*) filter (where d.result = 'pending') = 0
       and count(*) filter (where d.result in ('won', 'lost')) >= 1
  );
$function$;

create or replace function public.set_leaderboard_opt_in(p_on boolean)
returns void
language plpgsql
security definer
set search_path to ''
as $function$
begin
  update public.profiles set leaderboard_opt_in = coalesce(p_on, false) where id = auth.uid();
  delete from public.community_agent_stats where user_id = auth.uid();
  if coalesce(p_on, false) then
    insert into public.community_agent_stats (user_id, handle, agent_name, edge, sample_size)
    select d.user_id, pr.handle, st.name,
           (sum((d.result = 'won')::int)::numeric / count(*)) - (sum(d.market_prob) / count(*)),
           count(*)
    from public.deliveries d
    join public.strategies st on st.id = d.strategy_id
    join public.profiles pr on pr.id = d.user_id
    where d.user_id = auth.uid() and d.result in ('won', 'lost') and d.market_prob is not null and d.market_prob > 0 and d.market_prob < 1
      and pr.handle is not null
      and public.strategy_has_full_day(d.strategy_id)   -- only agents that have cleared a full day
    group by d.user_id, pr.handle, st.name
    having count(*) >= 20;
  end if;
end $function$;

create or replace function public.refresh_community_leaderboard()
returns void
language plpgsql
security definer
set search_path to ''
as $function$
begin
  delete from public.community_agent_stats;
  insert into public.community_agent_stats (user_id, handle, agent_name, edge, sample_size)
  select d.user_id, pr.handle, st.name,
         (sum((d.result = 'won')::int)::numeric / count(*)) - (sum(d.market_prob) / count(*)),
         count(*)
  from public.deliveries d
  join public.strategies st on st.id = d.strategy_id
  join public.profiles pr on pr.id = d.user_id
  where d.result in ('won', 'lost') and d.market_prob is not null and d.market_prob > 0 and d.market_prob < 1
    and pr.leaderboard_opt_in = true and pr.handle is not null
    and public.strategy_has_full_day(d.strategy_id)   -- only agents that have cleared a full day
  group by d.user_id, pr.handle, st.name
  having count(*) >= 20;
end $function$;

-- apply the new gate to the current board immediately
select public.refresh_community_leaderboard();
