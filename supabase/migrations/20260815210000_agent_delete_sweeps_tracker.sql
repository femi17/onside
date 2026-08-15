-- Owner rule (2026-08-15): deleting an agent also removes its games from the TRACKER — except a
-- ticket that lives inside an accumulator (the acca is its own bet; the leg survives, merely losing
-- its agent link via ON DELETE SET NULL).
-- tickets.strategy_id records which agent a tracked pick came from (set by the app when tracking;
-- null for slips/manual/legacy).
alter table public.tickets add column if not exists strategy_id uuid references public.strategies(id) on delete set null;
create index if not exists tickets_strategy_id_idx on public.tickets(strategy_id) where strategy_id is not null;

-- BEFORE DELETE on strategies: remove the agent's standalone tracker games (any status — the
-- agent's record leaves with it); acca-tied legs are spared and their strategy_id nulls via the FK.
create or replace function public.sweep_agent_tickets()
returns trigger
language plpgsql
security definer
set search_path to ''
as $function$
begin
  delete from public.tickets t
   where t.strategy_id = OLD.id
     and t.accumulator_id is null;
  return OLD;
end;
$function$;

drop trigger if exists trg_sweep_agent_tickets on public.strategies;
create trigger trg_sweep_agent_tickets
  before delete on public.strategies
  for each row execute function public.sweep_agent_tickets();
