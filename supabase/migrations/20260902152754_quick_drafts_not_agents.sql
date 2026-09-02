-- Quick-spec drafts are NOT agents (owner-ruled 2026-09-02). Their deliveries are pool material
-- for the acca generator, not agent picks: exclude them from every surface that counts or
-- celebrates AGENT picks — public_record (totals, day cards, perfect-day spotlight, bands),
-- perfect-day + first-win congratulation targets (including the Richard-standard open-pick gate,
-- where a pending quick pick must not BLOCK a real celebration), and my_record's week_agents
-- tile. Tracked generator slips are tickets, so the user's own tracked record is untouched.
-- Learning surfaces (band learning, insight miner) stay inclusive — more graded data is good data.

create or replace function public.public_record()
returns jsonb
language sql
stable
security definer
set search_path to ''
as $function$
  select jsonb_build_object(
    'all_time', (
      select jsonb_build_object(
        'graded', count(*),
        'won',    count(*) filter (where result = 'won'),
        'since',  min(delivered_at)
      )
      from public.deliveries d
      where result in ('won', 'lost')
        and not exists (select 1 from public.strategies sd where sd.id = d.strategy_id and sd.status = 'draft')
    ),
    'today_delivered', (
      select count(*)
      from public.deliveries d
      where delivered_at >= date_trunc('day', now() at time zone 'Africa/Lagos')
                            at time zone 'Africa/Lagos'
        and not exists (select 1 from public.strategies sd where sd.id = d.strategy_id and sd.status = 'draft')
    ),
    'days', coalesce((
      select jsonb_agg(jsonb_build_object(
               'day', day, 'graded', graded, 'won', won,
               'perfect', perfect, 'perfect_n', perfect_n)
             order by day desc)
      from (
        with per_agent as (
          select (d.delivered_at at time zone 'Africa/Lagos')::date as day,
                 d.strategy_id,
                 count(*) as delivered,
                 count(*) filter (where d.result in ('won', 'lost')) as g,
                 count(*) filter (where d.result = 'won') as w
          from public.deliveries d
          where d.delivered_at >= now() - interval '35 days'
            and not exists (select 1 from public.strategies sd where sd.id = d.strategy_id and sd.status = 'draft')
          group by 1, 2
        )
        select day,
               sum(g) as graded,
               sum(w) as won,
               count(*) filter (where strategy_id is not null and delivered >= 3 and w = delivered) as perfect,
               max(delivered) filter (where strategy_id is not null and delivered >= 3 and w = delivered) as perfect_n
        from per_agent
        group by day
        having sum(g) > 0
        order by day desc
        limit 30
      ) t
    ), '[]'::jsonb),
    'perfect_details', coalesce((
      select jsonb_agg(jsonb_build_object('day', day, 'sweeps', sweeps) order by day desc)
      from (
        with pa as (
          select (d.delivered_at at time zone 'Africa/Lagos')::date as day, d.strategy_id,
                 count(*) as delivered
          from public.deliveries d
          where d.delivered_at >= now() - interval '14 days'
            and d.strategy_id is not null
            and not exists (select 1 from public.strategies sd where sd.id = d.strategy_id and sd.status = 'draft')
          group by 1, 2
          having count(*) >= 3
             and count(*) filter (where d.result = 'won') = count(*)
        ),
        picks as (
          select pa.day, pa.strategy_id, pa.delivered,
                 jsonb_agg(jsonb_build_object(
                   'home', f.home_team, 'away', f.away_team,
                   'market', coalesce(nullif(d.market_label, ''), d.market_key),
                   'score', coalesce(d.settle_score,
                            coalesce(f.ft_home, f.home_goals)::text || '-' || coalesce(f.ft_away, f.away_goals)::text)
                 ) order by d.delivered_at) as legs
          from pa
          join public.deliveries d on d.strategy_id = pa.strategy_id
            and (d.delivered_at at time zone 'Africa/Lagos')::date = pa.day
          join public.fixtures f on f.id = d.fixture_id
          group by 1, 2, 3
        )
        select day,
               jsonb_agg(jsonb_build_object('n', delivered, 'legs', legs) order by delivered desc) as sweeps
        from picks
        group by day
        order by day desc
        limit 3
      ) t
    ), '[]'::jsonb),
    'bands', coalesce((
      select jsonb_agg(jsonb_build_object('band', band, 'n', n, 'won', won, 'claimed', claimed)
                       order by band)
      from (
        select least(floor(d.model_prob * 10) * 10, 90)::int as band,
               count(*) as n,
               count(*) filter (where d.result = 'won') as won,
               round(avg(d.model_prob) * 100)::int as claimed
        from public.deliveries d
        where d.model_prob is not null and d.result in ('won', 'lost')
          and not exists (select 1 from public.strategies sd where sd.id = d.strategy_id and sd.status = 'draft')
        group by 1
        having count(*) >= 25
      ) b
    ), '[]'::jsonb)
  )
$function$;

create or replace function public.perfect_day_targets()
returns table(user_id uuid, email text, plan text, agent text, day date, n bigint)
language sql
stable
security definer
set search_path to ''
as $function$
  select d.user_id, u.email::text, coalesce(p.plan, 'free'),
         coalesce(s.name, 'Your agent'), d.delivered_at::date, count(*)
  from public.deliveries d
  join auth.users u on u.id = d.user_id
  join public.profiles p on p.id = d.user_id
  left join public.strategies s on s.id = d.strategy_id
  where d.delivered_at > now() - interval '3 days'
    and u.deleted_at is null
    and u.email not in ('demo@onside.com.ng', 'oduolafemi17@gmail.com')
    and coalesce(s.status, '') <> 'draft'
  group by d.user_id, u.email, p.plan, s.name, d.delivered_at::date
  having count(*) >= 3
     and count(*) filter (where d.result = 'won') = count(*)
  order by count(*) desc
$function$;

create or replace function public.first_win_targets()
returns table(user_id uuid, email text, plan text, agent text, game text, market text, score text)
language sql
stable
security definer
set search_path to ''
as $function$
  with firsts as (
    select d.user_id, min(d.settled_at) as first_settle
    from public.deliveries d
    where d.result = 'won' and d.settled_at is not null
      and not exists (select 1 from public.strategies sd where sd.id = d.strategy_id and sd.status = 'draft')
    group by d.user_id
    having min(d.settled_at) > now() - interval '7 days'
  )
  select distinct on (d.user_id)
         d.user_id, u.email::text, coalesce(p.plan, 'free'),
         coalesce(s.name, 'Your agent'),
         f.home_team || ' v ' || f.away_team,
         coalesce(nullif(d.market_label, ''), d.market_key),
         coalesce(d.settle_score, f.ft_home::text || '-' || f.ft_away::text)
  from firsts w
  join public.deliveries d on d.user_id = w.user_id and d.result = 'won' and d.settled_at = w.first_settle
  join auth.users u on u.id = d.user_id
  join public.profiles p on p.id = d.user_id
  left join public.strategies s on s.id = d.strategy_id
  join public.fixtures f on f.id = d.fixture_id
  where u.deleted_at is null
    and coalesce(p.is_admin, false) = false
    and u.email not in ('tyewoduola@gmail.com', 'demo@onside.com.ng', 'oduolafemi17@gmail.com')
    and coalesce(s.status, '') <> 'draft'
    -- the Richard standard: no congratulation while any pick from that day is still open —
    -- but a pending QUICK-SPEC pick is pool material, not a pick, and must not block it
    and not exists (
      select 1 from public.deliveries dx
      where dx.user_id = d.user_id
        and (dx.delivered_at at time zone 'Africa/Lagos')::date
            = (d.delivered_at at time zone 'Africa/Lagos')::date
        and (dx.result is null or dx.result not in ('won', 'lost', 'void'))
        and not exists (select 1 from public.strategies sx where sx.id = dx.strategy_id and sx.status = 'draft')
    )
  order by d.user_id, d.delivered_at
$function$;

create or replace function public.my_record()
returns jsonb
language sql
stable
security definer
set search_path to ''
as $function$
  with mine as (
    select t.status, t.market_key, t.created_at, t.settled_at
    from public.tickets t
    where t.user_id = auth.uid()
  ),
  graded as (
    select *, case
      when market_key like '%corner%' then 'Corners'
      when market_key like '%card%' or market_key like '%booking%' then 'Cards'
      when market_key ~ '^(over|under)_' or market_key in ('total_goals_ou','btts','home_to_score','away_to_score','teams_to_score','home_goals_ou','away_goals_ou','odd_even','exact_goals','goal_range','multigoals','btts_2plus') then 'Goals'
      when market_key in ('home_win','away_win','draw','result_1x2','dnb','handicap') or market_key like 'double_chance%' or market_key like '%_1up' or market_key like '%_2up' or market_key like '%never_down' then 'Result'
      else 'Other' end as fam
    from mine where status in ('won','lost')
  ),
  days as (
    select distinct (created_at at time zone 'Africa/Lagos')::date as d from mine
  ),
  streak as (
    select count(*) as n from (
      select d, row_number() over (order by d desc) - 1 as rn from days
    ) s
    where s.d = ((now() at time zone 'Africa/Lagos')::date - s.rn::int)
       or s.d = ((now() at time zone 'Africa/Lagos')::date - 1 - s.rn::int)
  )
  select jsonb_build_object(
    'all_time', (select jsonb_build_object('graded', count(*), 'won', count(*) filter (where status = 'won')) from graded),
    'last30', (select jsonb_build_object('graded', count(*), 'won', count(*) filter (where status = 'won'))
               from graded where created_at > now() - interval '30 days'),
    'families', (select coalesce(jsonb_agg(jsonb_build_object('family', fam, 'graded', n, 'won', w) order by n desc), '[]'::jsonb)
                 from (select fam, count(*) n, count(*) filter (where status = 'won') w from graded group by fam) f),
    'week_slips', (select jsonb_build_object('graded', count(*), 'won', count(*) filter (where status = 'won'))
                   from graded where coalesce(settled_at, created_at) > now() - interval '7 days'),
    'week_agents', (select jsonb_build_object('graded', count(*), 'won', count(*) filter (where result = 'won'))
                    from public.deliveries d
                    where d.user_id = auth.uid() and d.result in ('won','lost')
                      and d.delivered_at > now() - interval '7 days'
                      and not exists (select 1 from public.strategies sd where sd.id = d.strategy_id and sd.status = 'draft')),
    'streak_days', (select n from streak),
    'first_tracked', (select min(created_at) from mine)
  );
$function$;
