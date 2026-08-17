-- Admin-only community post kinds: 'acca' (a landed accumulator highlight) and 'double'
-- (the day's Onside Double). Regular members keep note/slip/result; the existing
-- rate limit and opt-in checks apply to admins too.
create or replace function public.community_post(p_body text, p_kind text default 'note', p_attachment jsonb default null)
returns uuid
language plpgsql
security definer
set search_path to ''
as $function$
declare v_handle text; v_color text; v_optin boolean; v_admin boolean; v_count int; v_id uuid;
begin
  select handle, avatar_color, community_opt_in, coalesce(is_admin, false)
    into v_handle, v_color, v_optin, v_admin
    from public.profiles where id = auth.uid();
  if v_handle is null or not coalesce(v_optin, false) then raise exception 'Join the community first.'; end if;
  if length(coalesce(btrim(p_body), '')) = 0 and p_attachment is null then raise exception 'Nothing to post.'; end if;
  if length(coalesce(p_body, '')) > 1000 then raise exception 'Post is too long (1000 max).'; end if;
  if coalesce(p_kind, 'note') not in ('note','slip','result','acca','double') then raise exception 'bad kind'; end if;
  if coalesce(p_kind, 'note') in ('acca','double') and not v_admin then raise exception 'Admins only.'; end if;
  select count(*) into v_count from public.community_posts where user_id = auth.uid() and created_at > now() - interval '1 day';
  if v_count >= 20 then raise exception 'Daily post limit reached (20).'; end if;
  insert into public.community_posts (user_id, author_handle, author_color, body, kind, attachment)
  values (auth.uid(), v_handle, v_color, nullif(btrim(p_body), ''), coalesce(p_kind, 'note'), p_attachment)
  returning id into v_id;
  return v_id;
end $function$;

-- Recent WON accumulators across all members, ANONYMISED (no handle, no user id, no bookmaker)
-- — powers the admin composer's "share a win" picker. RLS blocks a direct cross-user read,
-- hence security definer with an explicit admin gate; non-admins get an empty list.
create or replace function public.admin_recent_won_accas()
returns jsonb
language sql
security definer
set search_path to ''
as $function$
  select case
    when not exists (select 1 from public.profiles where id = auth.uid() and coalesce(is_admin, false))
    then '[]'::jsonb
    else coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', a.id,
        'won_at', a.created_at,
        'stake', a.stake,
        'potential', a.potential_return,
        'currency', a.currency,
        'legs', coalesce((
          select jsonb_agg(jsonb_build_object(
            'game', coalesce(f.home_team || ' v ' || f.away_team, 'Match'),
            'market', coalesce(t.market_label, t.custom_market, 'Bet')
          ) order by t.created_at)
          from public.tickets t
          left join public.fixtures f on f.id = t.fixture_id
          where t.accumulator_id = a.id
        ), '[]'::jsonb)
      ) order by a.created_at desc)
      from (
        select id, created_at, stake, potential_return, currency
        from public.accumulators where status = 'won'
        order by created_at desc limit 10
      ) a
    ), '[]'::jsonb)
  end
$function$;
