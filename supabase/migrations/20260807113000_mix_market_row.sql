-- strategies.market_key is FK-constrained to the markets catalog, so the 'mix' pseudo-market
-- (mixed-outcome agents, see 20260807110000_strategy_market_mix.sql) needs a catalog row.
-- tracks is null: each delivered pick carries its own concrete market/period/value, so the
-- tracker settles per-pick, not per-strategy.
insert into markets (key, label, kind, tracks, description)
values ('mix', 'Mixed outcomes', 'mix', null, 'Best of a user-chosen set of bet outcomes, weighed per game')
on conflict (key) do nothing;
