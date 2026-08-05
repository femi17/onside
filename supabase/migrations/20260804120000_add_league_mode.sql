-- Surprise-me leagues: league selection becomes a MODE, not a frozen pick.
-- fixed    -> hunt exactly league_ids
-- all      -> scan every competition (empty league_ids, Pro Max)
-- surprise -> engine re-rolls a random in-window subset every run (league_ids stays empty)
alter table public.strategies
  add column if not exists league_mode text not null default 'fixed'
    check (league_mode in ('fixed', 'surprise', 'all'));

-- Backfill: historically an empty league_ids meant "all competitions" (Pro Max), else "fixed".
update public.strategies
  set league_mode = case
    when league_ids is null or array_length(league_ids, 1) is null then 'all'
    else 'fixed'
  end
  where league_mode = 'fixed';  -- only touch the default-filled rows
