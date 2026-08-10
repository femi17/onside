-- Community leaderboard shows landed/settled (e.g. 17/20) and ranks by landed count, not edge%.
-- Add a `landed` (won) count to community_agent_stats and populate it in both fillers.
alter table public.community_agent_stats add column if not exists landed integer not null default 0;

create or replace function public.refresh_community_leaderboard()
returns void
language plpgsql
security definer
set search_path to ''
as $function$
begin
  delete from public.community_agent_stats;
  insert into public.community_agent_stats (user_id, handle, agent_name, edge, sample_size, landed)
  select d.user_id, pr.handle, st.name,
         (sum((d.result = 'won')::int)::numeric / count(*)) - (sum(d.market_prob) / count(*)),
         count(*),
         sum((d.result = 'won')::int)
  from public.deliveries d
  join public.strategies st on st.id = d.strategy_id
  join public.profiles pr on pr.id = d.user_id
  where d.result in ('won', 'lost') and d.market_prob is not null and d.market_prob > 0 and d.market_prob < 1
    and pr.leaderboard_opt_in = true and pr.handle is not null
    and public.strategy_has_full_day(d.strategy_id)
  group by d.user_id, pr.handle, st.name
  having count(*) >= 20;
end $function$;

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
    insert into public.community_agent_stats (user_id, handle, agent_name, edge, sample_size, landed)
    select d.user_id, pr.handle, st.name,
           (sum((d.result = 'won')::int)::numeric / count(*)) - (sum(d.market_prob) / count(*)),
           count(*),
           sum((d.result = 'won')::int)
    from public.deliveries d
    join public.strategies st on st.id = d.strategy_id
    join public.profiles pr on pr.id = d.user_id
    where d.user_id = auth.uid() and d.result in ('won', 'lost') and d.market_prob is not null and d.market_prob > 0 and d.market_prob < 1
      and pr.handle is not null
      and public.strategy_has_full_day(d.strategy_id)
    group by d.user_id, pr.handle, st.name
    having count(*) >= 20;
  end if;
end $function$;

-- backfill landed for any existing rows
select public.refresh_community_leaderboard();
