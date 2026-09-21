-- Onside School — per-leg market override (over-lines only).
-- The record defaults each leg to Over 2.5, but the book doesn't always price 2.5 on a given game.
-- This lets an admin switch a leg's LINE (Over 1.5 / 2.5 / 3.5 / 4.5) + enter the real odds taken;
-- the record then grades that leg against the chosen line. Invisible to members — they just see the
-- final pick. Extends school_leg_odds (fixture_id PK) added earlier.

alter table public.school_leg_odds add column if not exists market text not null default 'over_2_5';
-- odds may be absent while only the line is set (graded on the line; price shows once entered)
alter table public.school_leg_odds alter column odds drop not null;

-- Set a leg's line + real odds (admin only). Default line + no odds clears the override.
create or replace function public.school_set_leg_pick(p_fixture_id bigint, p_market text, p_odds numeric)
returns void
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_mkt  text := coalesce(nullif(p_market,''),'over_2_5');
  v_odds numeric := case when p_odds is not null and p_odds > 1 then p_odds else null end;
begin
  if not exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin) then
    raise exception 'Admins only.';
  end if;
  if v_mkt = 'over_2_5' and v_odds is null then
    delete from public.school_leg_odds where fixture_id = p_fixture_id;
    return;
  end if;
  insert into public.school_leg_odds (fixture_id, market, odds, set_by, updated_at)
  values (p_fixture_id, v_mkt, v_odds, auth.uid(), now())
  on conflict (fixture_id) do update
    set market = excluded.market, odds = excluded.odds, set_by = excluded.set_by, updated_at = now();
end $function$;

revoke all on function public.school_set_leg_pick(bigint, text, numeric) from public, anon;
grant execute on function public.school_set_leg_pick(bigint, text, numeric) to authenticated;
