-- Singleton knob store for the agent engine's self-calibration loop. run-strategies reads `temp`
-- (score-matrix temperature) at every invocation and, once a day, measures realized calibration of
-- recent priced picks (model_prob vs outcomes) and nudges temp in small bounded steps — evidence-
-- gated (n >= 200) so it stays at the backtest-fitted value until there's real data to move it.
-- Service-role only: RLS on, no policies.
create table if not exists model_params (
  id int primary key default 1 check (id = 1),
  temp numeric not null default 1,
  last_calib_at timestamptz,
  calibration jsonb,
  updated_at timestamptz not null default now()
);
insert into model_params (id) values (1) on conflict do nothing;
alter table model_params enable row level security;
-- (learning stays a Pro Max-only perk: plan_limits.learning true only for pro_max)
