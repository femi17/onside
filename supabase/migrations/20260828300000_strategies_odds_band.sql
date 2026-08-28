-- Per-agent odds band: deliver only picks whose DISPLAYED price falls in [min_odds, max_odds].
-- Both nullable; null = no bound on that side (null/null = any odds, current behaviour). Filters on
-- the same price shown on the feed (criteria.odds). Display/selection only — never touches grading.
ALTER TABLE strategies
  ADD COLUMN IF NOT EXISTS min_odds numeric,
  ADD COLUMN IF NOT EXISTS max_odds numeric;

ALTER TABLE strategies
  ADD CONSTRAINT strategies_odds_band_check
  CHECK (
    (min_odds IS NULL OR min_odds >= 1) AND
    (max_odds IS NULL OR max_odds >= 1) AND
    (min_odds IS NULL OR max_odds IS NULL OR max_odds >= min_odds)
  );
