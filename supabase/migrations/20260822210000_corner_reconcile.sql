-- Corner reconcile sweep (poll): the provider's live corner feed can FREEZE late in a game and
-- only be corrected on their side well after FT (CSKA v Lokomotiv 2026-08-22: live stats stuck at
-- 4-0 from the 78th minute, true final 5-1 — every settle-time fetch inside the grace window still
-- saw 4-0; replay over all 11 settled corner bets found 9 under-counted). poll now re-fetches the
-- finals once per fixture 90min-24h after FT, heals fixture_stats, and re-grades corner bets —
-- including already-settled ones. Owner-ruled 2026-08-22: a flipped result corrects WITH a push.

-- One-shot flag: reconcile attempted for this fixture. Set even when the provider has no stats —
-- in that case NO fixture_stats marker row is inserted, so the overnight collect-stats backfill
-- (whose candidate query looks for fixtures MISSING a stats row) still owns those fixtures.
alter table public.fixtures add column if not exists stats_reconciled_at timestamptz;

-- Let the landed/missed push RE-fire when an already-settled result is corrected. The old gate
-- (OLD already settled -> never push) predates the reconcile sweep and would have silenced the
-- correction. The no-op guard (same value = no push) stays, and the build-up progress triggers
-- are gated on pending/live, so value-only heals on settled rows remain silent.
create or replace function public.notify_delivery_settled()
returns trigger
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_secret text; v_name text; v_home text; v_away text; v_emoji text; v_verb text;
  v_tracked boolean; v_cat text; v_corr boolean;
begin
  if NEW.result not in ('won','lost') then return NEW; end if;
  if OLD.result is not distinct from NEW.result then return NEW; end if;
  -- reconcile corrected a settled result: still push, but say so in the copy
  v_corr := OLD.result in ('won','lost','void');

  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'push_internal_secret' limit 1;
  if v_secret is null then return NEW; end if;

  select exists (
    select 1 from public.tickets t
    where t.user_id = NEW.user_id and t.fixture_id = NEW.fixture_id
      and t.market_key = NEW.market_key
      and coalesce(t.side, '') = coalesce(NEW.side, '')
      and coalesce(t.line, -1) = coalesce(NEW.line, -1)
      and coalesce(t.period, 'ft') = coalesce(NEW.period, 'ft')
  ) into v_tracked;
  v_cat := case when v_tracked then 'results' else 'agent_games' end;

  select s.name into v_name from public.strategies s where s.id = NEW.strategy_id;
  select f.home_team, f.away_team into v_home, v_away from public.fixtures f where f.id = NEW.fixture_id;
  v_emoji := case when NEW.result = 'won' then '✅' else '❌' end;
  v_verb  := case when NEW.result = 'won' then 'landed' else 'missed' end;
  if v_corr then v_verb := 'actually ' || v_verb; end if;

  perform net.http_post(
    url := 'https://mbrtpetpgsggnlcazhqd.supabase.co/functions/v1/send-push',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-internal-secret', v_secret),
    body := jsonb_build_object(
      'user_id', NEW.user_id, 'category', v_cat, 'mute', not v_tracked,
      'title', v_emoji || ' ' || case when v_corr then 'Correction — ' else '' end || coalesce(v_name, 'Agent'),
      'body', coalesce(v_home, '') || ' v ' || coalesce(v_away, '') || ' — ' || coalesce(NEW.market_label, 'your pick') || ' ' || v_verb || '.',
      'url', '/agent', 'tag', 'settle-' || NEW.id::text
    ),
    timeout_milliseconds := 8000);
  return NEW;
end;
$function$;

create or replace function public.notify_ticket_settled()
returns trigger
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_secret text; v_home text; v_away text; v_emoji text; v_verb text; v_acca boolean; v_corr boolean;
begin
  if NEW.status not in ('won','lost') then return NEW; end if;
  if OLD.status is not distinct from NEW.status then return NEW; end if;
  -- reconcile corrected a settled result: still push, but say so in the copy
  v_corr := OLD.status in ('won','lost','void');
  if coalesce(NEW.tracker_hidden, false) then return NEW; end if;
  if NEW.user_id is null or NEW.fixture_id is null then return NEW; end if;

  -- a matching agent delivery will push this result itself (results category, tracked pick)
  if exists (
    select 1 from public.deliveries d
    where d.user_id = NEW.user_id and d.fixture_id = NEW.fixture_id
      and d.market_key = NEW.market_key
      and coalesce(d.side, '') = coalesce(NEW.side, '')
      and coalesce(d.line, -1) = coalesce(NEW.line, -1)
      and coalesce(d.period, 'ft') = coalesce(NEW.period, 'ft')
  ) then return NEW; end if;

  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'push_internal_secret' limit 1;
  if v_secret is null then return NEW; end if;

  select f.home_team, f.away_team into v_home, v_away from public.fixtures f where f.id = NEW.fixture_id;
  v_emoji := case when NEW.status = 'won' then '✅' else '❌' end;
  v_verb  := case when NEW.status = 'won' then 'landed' else 'missed' end;
  v_acca  := NEW.accumulator_id is not null;

  perform net.http_post(
    url := 'https://mbrtpetpgsggnlcazhqd.supabase.co/functions/v1/send-push',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-internal-secret', v_secret),
    body := jsonb_build_object(
      'user_id', NEW.user_id, 'category', 'results',
      'title', v_emoji || ' ' || case when v_corr then 'Corrected: ' else '' end || initcap(v_verb),
      'body', coalesce(NEW.market_label, NEW.custom_market, 'Your pick') || ' — ' || coalesce(v_home, '') || ' v ' || coalesce(v_away, '') || case when v_acca then ' · acca leg' else '' end,
      'url', case when v_acca then '/accumulators' else '/tracker' end,
      'tag', 'settle-t-' || NEW.id::text
    ),
    timeout_milliseconds := 8000);
  return NEW;
end;
$function$;
