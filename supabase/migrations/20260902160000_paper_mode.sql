-- Paper mode (owner-directed 2026-09-02). Mirror of remotely applied migration `paper_mode`.
-- Stop waiting for users to bet a market before the proven-rules library can master it. Ten
-- "📄 Paper ·" draft strategies under demo@onside.com.ng (one per common outcome, NO rule, all
-- leagues, min_edge 0 for the widest honest sample above the engine's built-in 50% floor) run
-- daily via cron through the quiet-run path. Drafts are excluded from the feed, /performance,
-- public_record and celebrations by design, and the demo account is excluded from analytics —
-- the picks exist ONLY for grading + the Monday refresh_proven_rules() sweep, which already
-- consumes all settled deliveries. The engine exempts this user from the quickrun quota.

do $$
declare
  v_user uuid := '85a7776e-7c86-4c82-8f53-f8aa81f0bd0b'; -- demo@onside.com.ng
  m record;
begin
  for m in select * from (values
    ('over_1_5',        'Over 1.5 goals',      'over',  1.5::numeric),
    ('over_2_5',        'Over 2.5 goals',      'over',  2.5),
    ('under_3_5',       'Under 3.5 goals',     'under', 3.5),
    ('btts',            'Both teams to score', 'yes',   null),
    ('home_to_score',   'Home team to score',  'home',  null),
    ('away_to_score',   'Away team to score',  'away',  null),
    ('home_win',        'Home win',            'home',  null),
    ('double_chance_1x','Double chance (1X)',  '1x',    null),
    ('double_chance_12','Double chance (12)',  '12',    null),
    ('double_chance_x2','Double chance (X2)',  'x2',    null)
  ) t(mk, label, side, line)
  loop
    insert into public.strategies
      (user_id, name, market_key, market_label, side, line, period, status,
       league_ids, league_mode, target_day, selectivity, min_edge, max_per_prediction,
       deliver_at, channels, learning, timezone)
    select v_user, '📄 Paper · ' || m.label, m.mk, m.label, m.side, m.line, 'ft', 'draft',
           '{}', 'all', 'same_day', 'strong', 0, 30,
           '09:30:00', '{}', false, 'Africa/Lagos'
    where not exists (
      select 1 from public.strategies s
      where s.user_id = v_user and s.name = '📄 Paper · ' || m.label
    );
  end loop;
end $$;

-- fire all paper strategies (async pg_net posts; quiet runs — no push/telegram, invisible
-- everywhere but learning). Same anon-bearer pattern as invoke_send_nudge.
create or replace function public.invoke_paper_runs()
returns void
language plpgsql
security definer
set search_path to ''
as $function$
declare r record;
begin
  for r in
    select id from public.strategies
    where user_id = '85a7776e-7c86-4c82-8f53-f8aa81f0bd0b'
      and status = 'draft' and name like '📄 Paper ·%'
  loop
    perform net.http_post(
      url := 'https://mbrtpetpgsggnlcazhqd.supabase.co/functions/v1/run-strategies',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1icnRwZXRwZ3NnZ25sY2F6aHFkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODU0MjAyMTksImV4cCI6MjEwMDk5NjIxOX0.etTN6LbQ1olV3mMw3VOvIW0C5oGbf68VQyR_-x6vFq4'
      ),
      body := jsonb_build_object('strategy_id', r.id, 'quiet', true),
      timeout_milliseconds := 55000
    );
  end loop;
end;
$function$;

revoke all on function public.invoke_paper_runs() from public;
revoke all on function public.invoke_paper_runs() from anon;
revoke all on function public.invoke_paper_runs() from authenticated;

do $$
begin
  perform cron.unschedule('paper-runs-daily');
exception when others then null;
end $$;
select cron.schedule('paper-runs-daily', '30 9 * * *', $$select public.invoke_paper_runs()$$);
