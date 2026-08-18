-- Public acca share links — the growth loop. The owner of a slip mints an unguessable token;
-- anyone with the link sees an ANONYMISED read-only card (no user identity, ever). Sharing is
-- explicit (token null until the owner taps Share); soft-deleted slips go dark automatically.
alter table public.accumulators add column if not exists share_token uuid;
create unique index if not exists accumulators_share_token_key on public.accumulators (share_token) where share_token is not null;

-- owner-only: mint (or return) the slip's share token
create or replace function public.share_acca(p_acca_id uuid)
returns uuid
language plpgsql
security definer
set search_path to ''
as $function$
declare v_token uuid;
begin
  update public.accumulators
     set share_token = coalesce(share_token, gen_random_uuid())
   where id = p_acca_id and user_id = auth.uid() and deleted_at is null
   returning share_token into v_token;
  if v_token is null then raise exception 'not your slip'; end if;
  return v_token;
end $function$;

-- public: the shared slip, anonymised — callable signed-out (marketing page + OG image)
create or replace function public.public_acca(p_token uuid)
returns jsonb
language sql
stable
security definer
set search_path to ''
as $function$
  select jsonb_build_object(
    'bookmaker', a.bookmaker,
    'stake', a.stake,
    'potential', a.potential_return,
    'currency', a.currency,
    'leg_count', a.leg_count,
    'status', a.status,
    'created_at', a.created_at,
    'legs', coalesce((
      select jsonb_agg(jsonb_build_object(
        'game', coalesce(f.home_team || ' v ' || f.away_team, 'Match'),
        'market', coalesce(t.market_label, t.custom_market, 'Bet'),
        'league', l.name,
        'status', t.status
      ) order by t.created_at)
      from public.tickets t
      left join public.fixtures f on f.id = t.fixture_id
      left join public.leagues l on l.id = f.league_id
      where t.accumulator_id = a.id
    ), '[]'::jsonb)
  )
  from public.accumulators a
  where a.share_token = p_token and a.deleted_at is null
$function$;
grant execute on function public.public_acca(uuid) to anon;
grant execute on function public.share_acca(uuid) to authenticated;
