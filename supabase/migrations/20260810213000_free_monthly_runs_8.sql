-- Free agents: bump the post-trial monthly delivery allowance 4 -> 8 (~twice a week).
update public.plan_limits set monthly_agent_runs = 8 where plan = 'free';
