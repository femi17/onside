-- Per-user window onto agent_quality so the feed can compute the Onside score client-side.
-- agent_quality itself stays service-role-only (it aggregates EVERY user's strategies);
-- this view filters to the caller's own strategies via auth.uid(), so granting it to
-- authenticated leaks nothing cross-user.
create or replace view public.my_agent_quality as
  select aq.strategy_id, aq.settled, aq.win_rate, aq.shrunk_rate
  from public.agent_quality aq
  join public.strategies s on s.id = aq.strategy_id
  where s.user_id = auth.uid();

grant select on public.my_agent_quality to authenticated;
revoke all on public.my_agent_quality from anon;
