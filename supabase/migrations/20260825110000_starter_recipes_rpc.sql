-- Starter recipes: live platform-wide receipts for the three curated first-agent templates
-- the activation card offers ("start from a recipe that's landing right now"). Aggregates
-- only, last 14 days, graded picks — the same honesty source as /record. The UI hides any
-- recipe below its evidence bar (n>=15, hit>=60%), so a cold recipe never advertises itself.
create or replace function public.starter_recipes()
returns jsonb
language sql
stable
security definer
set search_path to ''
as $function$
  select jsonb_build_object(
    'goals_banker', (
      select jsonb_build_object('graded', count(*) filter (where result in ('won','lost')),
                                'won', count(*) filter (where result = 'won'))
      from public.deliveries
      where market_key = 'over_1_5' and delivered_at > now() - interval '14 days'
    ),
    'safe_double', (
      select jsonb_build_object('graded', count(*) filter (where result in ('won','lost')),
                                'won', count(*) filter (where result = 'won'))
      from public.deliveries
      where market_key in ('double_chance_1x','double_chance_x2','double_chance_12')
        and delivered_at > now() - interval '14 days'
    ),
    'home_scorers', (
      select jsonb_build_object('graded', count(*) filter (where result in ('won','lost')),
                                'won', count(*) filter (where result = 'won'))
      from public.deliveries
      where market_key in ('home_to_score','away_to_score')
        and delivered_at > now() - interval '14 days'
    )
  );
$function$;
revoke all on function public.starter_recipes() from public, anon;
grant execute on function public.starter_recipes() to authenticated, service_role;
