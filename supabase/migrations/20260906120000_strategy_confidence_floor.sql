-- Per-agent confidence floor (owner-directed 2026-09-06).
-- Makes the owner-ruled 0.5 delivery floor ("a pick must be more likely to land than not")
-- configurable per agent. NULL keeps the original 0.5, so every EXISTING agent is unchanged.
-- New confidence-default agents set this (e.g. 0.70) via the builder; edge (min_edge) becomes an
-- optional advanced lane rather than the mandatory default. run-strategies reads it as `confFloor`.
alter table public.strategies add column if not exists confidence_floor numeric;

comment on column public.strategies.confidence_floor is
  'Per-agent minimum shown model probability (0-1) required to deliver a pick. NULL = 0.5 (owner delivery floor). The confidence-default replacement for edge-based selectivity; min_edge remains an optional layer on top.';
