-- Mixed-outcome agents: one strategy can hunt SEVERAL bet outcomes (e.g. home win + home over 1.5
-- + corners + 1st-half over 0.5). `markets` holds the list as jsonb
-- [{market_key, label, side, line, period, bet_value}, ...]; when present the engine treats the
-- strategy as a custom best-of set (market_key = 'mix') — per game it prices every outcome and
-- delivers the one that clears the bar, with model-less outcomes (corners/cards/non-FT periods)
-- serving as the unpriced fallback. Null/empty = classic single-market strategy.
alter table strategies add column if not exists markets jsonb;
