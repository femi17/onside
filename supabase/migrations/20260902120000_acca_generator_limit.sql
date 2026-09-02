-- Acca Generator: plan gating for generated slips (accumulators.source = 'generated').
--
-- The generator assembles accumulators purely from the signed-in user's OWN agents' pending
-- deliveries — Onside never presents platform-picked bets (legal/positioning ruling). Generated
-- slips are marked with accumulators.source = 'generated': no new column — `source` is the same
-- free-text discriminator the existing flows already write ('screenshot' | 'manual' | 'agent'),
-- and the existing enforce_acca_daily_limit trigger only gates source = 'screenshot', so a new
-- value passes it untouched. Generated slips get their own server-side gate here:
--
--   free          → 1 generated slip per day (profile-timezone day), max 3 legs
--   pro / pro_max → unlimited generated slips, max 5 legs
--
-- Enforced by a BEFORE INSERT trigger so the client-side mirror can't be bypassed. Soft-deleted
-- slips still count (deleted_at is ignored) — same semantics as the screenshot quota: deleting
-- a slip never hands the day's slot back. Any unknown/future plan falls back to the free limits.

create or replace function public.enforce_generated_acca_limit()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_plan text;
  v_tz text;
  v_limit integer;    -- null = unlimited slips per day
  v_max_legs integer;
  v_count integer;
begin
  -- only generated slips are gated here; every other source keeps its existing rules
  if coalesce(new.source, '') <> 'generated' then
    return new;
  end if;

  select plan, coalesce(timezone, 'Africa/Lagos') into v_plan, v_tz from profiles where id = new.user_id;
  v_plan := coalesce(v_plan, 'free');
  v_tz := coalesce(v_tz, 'Africa/Lagos');

  if v_plan in ('pro', 'pro_max') then
    v_limit := null;   -- unlimited generated slips a day
    v_max_legs := 5;
  else
    v_limit := 1;      -- free: one generated slip a day
    v_max_legs := 3;
  end if;

  if coalesce(new.leg_count, 0) > v_max_legs then
    raise exception 'GEN_ACCA_LEGS:%:%', v_plan, v_max_legs using errcode = 'check_violation';
  end if;

  if v_limit is not null then
    select count(*) into v_count from accumulators
      where user_id = new.user_id and source = 'generated'
        and (created_at at time zone v_tz)::date = (now() at time zone v_tz)::date;
    if v_count >= v_limit then
      raise exception 'DAILY_GEN_LIMIT:%:%', v_plan, v_limit using errcode = 'check_violation';
    end if;
  end if;

  return new;
end;
$function$;

drop trigger if exists trg_enforce_generated_acca_limit on public.accumulators;
create trigger trg_enforce_generated_acca_limit
  before insert on public.accumulators
  for each row execute function public.enforce_generated_acca_limit();
