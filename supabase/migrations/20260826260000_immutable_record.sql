-- OWNER-RULED: the public record never shrinks. When an account or agent is deleted, the
-- PERSON's data dies absolutely, but SETTLED deliveries survive as anonymous ledger rows
-- (fixture/market/result — platform facts with no identity attached). Pending picks are
-- swept at delete time (nothing graded to preserve, nobody left to own them).
--
-- Mechanics: deliveries.user_id/strategy_id become nullable with ON DELETE SET NULL;
-- BEFORE DELETE triggers on profiles and strategies sweep that owner's PENDING deliveries
-- so only settled rows remain to be anonymised by the FK. Blast radius checked: read paths
-- filter by auth.uid() (null rows invisible), the dedup index allows multiple nulls,
-- poll only grades pending rows (which no longer exist for deleted owners), and the model
-- calibration keeps learning from anonymous settled rows.

-- 1) settled rows survive their owner
alter table public.deliveries alter column user_id drop not null;
alter table public.deliveries alter column strategy_id drop not null;
alter table public.deliveries drop constraint deliveries_user_id_fkey;
alter table public.deliveries add constraint deliveries_user_id_fkey
  foreign key (user_id) references public.profiles(id) on delete set null;
alter table public.deliveries drop constraint deliveries_strategy_id_fkey;
alter table public.deliveries add constraint deliveries_strategy_id_fkey
  foreign key (strategy_id) references public.strategies(id) on delete set null;

-- 2) pending picks die with their owner (settled ones are all the FK will anonymise)
create or replace function public.sweep_pending_deliveries()
returns trigger
language plpgsql
security definer
set search_path to ''
as $function$
begin
  if tg_table_name = 'profiles' then
    delete from public.deliveries
    where user_id = old.id and (result is null or result not in ('won', 'lost', 'void'));
  else
    delete from public.deliveries
    where strategy_id = old.id and (result is null or result not in ('won', 'lost', 'void'));
  end if;
  return old;
end;
$function$;
drop trigger if exists trg_sweep_pending_deliveries on public.profiles;
create trigger trg_sweep_pending_deliveries
  before delete on public.profiles
  for each row execute function public.sweep_pending_deliveries();
drop trigger if exists trg_sweep_pending_deliveries_strategy on public.strategies;
create trigger trg_sweep_pending_deliveries_strategy
  before delete on public.strategies
  for each row execute function public.sweep_pending_deliveries();
