-- Weekly agent checkup (owner request): users whose RUNNING agents delivered nothing in the
-- last 7 days get one Friday email diagnosing why (quiet leagues vs strict rule) plus a
-- platform-proven recipe suggestion. This RPC returns one row per affected user with their
-- starving agents + how many games each agent's leagues actually had this week (the key
-- diagnostic: no games = widen the net; games but no picks = the bar filtered everything).
create or replace function public.agent_checkup_targets()
returns table(user_id uuid, email text, agents jsonb)
language sql
stable
security definer
set search_path to ''
as $function$
  with starving as (
    select s.id, s.user_id, u.email, s.name, s.market_key, s.league_ids, s.league_mode,
           s.rule_text
    from public.strategies s
    join auth.users u on u.id = s.user_id
    left join public.profiles p on p.id = s.user_id
    where s.status = 'running'
      and s.created_at < now() - interval '24 hours'
      and u.deleted_at is null
      and coalesce(p.is_admin, false) = false
      and u.email not in ('tyewoduola@gmail.com', 'demo@onside.com.ng', 'oduolafemi17@gmail.com')
      and not exists (select 1 from public.deliveries d
                      where d.strategy_id = s.id
                        and d.delivered_at > now() - interval '7 days')
  )
  select st.user_id, st.email::text,
    jsonb_agg(jsonb_build_object(
      'name', st.name,
      'market', st.market_key,
      'leagues', coalesce(array_length(st.league_ids, 1), 0),
      'mode', coalesce(st.league_mode, 'fixed'),
      'has_rule', st.rule_text is not null and st.rule_text <> '',
      'games_7d', case when st.league_ids is null then null else
        (select count(*) from public.fixtures f
         where f.league_id = any(st.league_ids)
           and f.kickoff_utc > now() - interval '7 days' and f.kickoff_utc < now()) end
    ))
  from starving st
  group by st.user_id, st.email
$function$;
revoke all on function public.agent_checkup_targets() from public, anon, authenticated;
grant execute on function public.agent_checkup_targets() to service_role;
-- the checkup email quotes live recipe receipts — let the service role read them too
grant execute on function public.starter_recipes() to service_role;
