-- The agent engine intends a strategy to deliver any fixture at most once (enforced app-side by
-- `takenAll` in run-strategies), but that check isn't atomic — overlapping cron runs raced and
-- double-inserted the same pick (seen: 7 exact-duplicate rows, all <0.5s apart). Remove the extra
-- copies (keep the earliest) and make the invariant a hard DB guarantee so any future race is a
-- silent no-op (the engine now upserts with ON CONFLICT DO NOTHING) instead of a duplicate delivery.
delete from public.deliveries
where id in (
  select id from (
    select id,
           row_number() over (
             partition by strategy_id, fixture_id
             order by delivered_at asc, id asc
           ) as rn
    from public.deliveries
  ) t
  where rn > 1
);

create unique index if not exists deliveries_strategy_fixture_uidx
  on public.deliveries (strategy_id, fixture_id);
