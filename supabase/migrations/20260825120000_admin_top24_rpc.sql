-- The 24 — admin-only ranked shortlist of TODAY's pending picks by estimated landing
-- probability. Evidence-based ranking (studied 2026-08-25 over all 822 graded deliveries):
--   1. exact-cell history (market+side+line+period+exact %), Bayesian-shrunk toward the
--      family×band rate (k=10) so tiny cells can't shout;
--   2. else family×band actual (k=20 shrink toward the model) — the interaction is real:
--      goals@60s lands 53% while half-goals@60s lands 71%;
--   3. else the raw model % (proven monotone: 64→65→77→87→91 across bands).
--   Big-edge PENALTY, not bonus: edge>6% lands 8pts worse than moderate edge (model-vs-
--   market disagreement is usually the model's error). Bookie prob as tiebreak.
create or replace function public.admin_top24()
returns table(id uuid, p_est numeric, basis text)
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_admin boolean;
begin
  select p.is_admin into v_admin from public.profiles p where p.id = auth.uid();
  if not coalesce(v_admin, false) then raise exception 'not authorized'; end if;

  return query
  with hist as (
    select d.market_key, d.side, d.line, coalesce(d.period, 'ft') as period,
           round(d.model_prob * 100)::int as pct,
           case when d.market_key like '%corner%' then 'corners'
                when d.market_key like '%card%' then 'cards'
                when d.market_key like 'double_chance%' or d.market_key in ('home_win','away_win','draw','dnb','handicap') then 'result'
                when coalesce(d.period, 'ft') in ('1h','2h') then 'half_goals'
                else 'goals' end as fam,
           d.result
    from public.deliveries d
    where d.result in ('won','lost') and d.model_prob is not null
  ),
  cells as (
    select h.market_key, h.side, h.line, h.period, h.pct, count(*) n, count(*) filter (where h.result = 'won') w
    from hist h group by 1, 2, 3, 4, 5
  ),
  fb as (
    select h.fam, (h.pct / 10) * 10 as band, count(*) n, count(*) filter (where h.result = 'won') w
    from hist h group by 1, 2
  ),
  today as (
    select d.id, d.model_prob, d.edge, d.market_prob, d.market_key, d.side, d.line,
           coalesce(d.period, 'ft') as period, round(d.model_prob * 100)::int as pct,
           case when d.market_key like '%corner%' then 'corners'
                when d.market_key like '%card%' then 'cards'
                when d.market_key like 'double_chance%' or d.market_key in ('home_win','away_win','draw','dnb','handicap') then 'result'
                when coalesce(d.period, 'ft') in ('1h','2h') then 'half_goals'
                else 'goals' end as fam
    from public.deliveries d
    where d.user_id = auth.uid()
      and d.model_prob is not null
      and coalesce(d.result, 'pending') = 'pending'
      and d.delivered_at >= date_trunc('day', now() at time zone 'Africa/Lagos') at time zone 'Africa/Lagos'
  )
  select t.id,
    round((
      coalesce(
        case when c.n >= 10 then (c.w + 10 * coalesce(f.w::numeric / nullif(f.n, 0), t.model_prob)) / (c.n + 10) end,
        case when f.n >= 15 then (f.w + 20 * t.model_prob) / (f.n + 20) end,
        t.model_prob
      )
      - case when t.edge > 0.08 then 0.04 when t.edge > 0.06 then 0.02 else 0 end
    )::numeric, 4) as p_est,
    (case when c.n >= 10 then 'cell' when f.n >= 15 then 'family' else 'model' end)::text as basis
  from today t
  left join cells c on c.market_key = t.market_key
    and c.side is not distinct from t.side
    and c.line is not distinct from t.line
    and c.period = t.period
    and c.pct = t.pct
  left join fb f on f.fam = t.fam and f.band = (t.pct / 10) * 10
  order by 2 desc, t.market_prob desc nulls last, t.model_prob desc
  limit 24;
end;
$function$;
revoke all on function public.admin_top24() from public, anon;
grant execute on function public.admin_top24() to authenticated;
