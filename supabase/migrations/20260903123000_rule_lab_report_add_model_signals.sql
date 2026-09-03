-- Mirror of remotely applied migration rule_lab_report_add_model_signals (2026-09-03).
-- Extends the routine's read RPC with the cross-market model-signal farming (model_signal_lab).
-- Returns the top cross-market cells (each signal's own native market excluded — those are just
-- calibration, not discovery) so the daily review agent can surface them in the owner's DM even
-- via the plain-HTTP fallback path.
create or replace function public.rule_lab_report(p_token text)
returns jsonb
language plpgsql
stable
security definer
set search_path to ''
as $$
declare
  tok text;
begin
  select decrypted_secret into tok from vault.decrypted_secrets where name = 'routine_token';
  if tok is null or p_token is distinct from tok then
    raise exception 'invalid token';
  end if;

  return jsonb_build_object(
    'generated_at', now(),
    'proven_rules', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'market_key', pr.market_key, 'market_label', pr.market_label,
        'rule_text', pr.rule_text, 'n', pr.n, 'won', pr.won, 'hit', pr.hit,
        'source', pr.source, 'computed_at', pr.computed_at) order by pr.hit desc), '[]'::jsonb)
      from public.proven_rules pr
    ),
    'lab_top', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'market_key', t.market_key, 'cond_key', t.cond_key, 'rule_text', t.rule_text,
        'train_n', t.train_n, 'train_won', t.train_won,
        'holdout_n', t.holdout_n, 'holdout_won', t.holdout_won,
        'wilson_lb', t.wilson_lb, 'computed_at', t.computed_at) order by t.market_key, t.wilson_lb desc), '[]'::jsonb)
      from (
        select rl.*, row_number() over (partition by rl.market_key order by rl.wilson_lb desc) rn
        from public.rule_lab rl
        where rl.train_n >= 25
      ) t
      where t.rn <= 3
    ),
    'lab_cells_total', (select count(*) from public.rule_lab),
    'lab_last_mined', (select max(computed_at) from public.rule_lab),
    -- cross-market signal farming (review-only): top signal->other-market cells, native pairs excluded
    'model_signals_top', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'signal_key', m.signal_key, 'threshold', m.threshold,
        'market_key', m.market_key, 'market_label', m.market_label,
        'n', m.n, 'won', m.won, 'hit', m.hit, 'wilson_lb', m.wilson_lb) order by m.wilson_lb desc), '[]'::jsonb)
      from (
        select * from public.model_signal_lab msl
        where msl.n >= 50 and msl.hit >= 75
          and not (
            (msl.signal_key='home_score_prob' and msl.market_key='home_to_score') or
            (msl.signal_key='away_score_prob' and msl.market_key='away_to_score') or
            (msl.signal_key='btts_prob' and msl.market_key='btts') or
            (msl.signal_key='over25_prob' and msl.market_key='over_2_5') or
            (msl.signal_key='home_win_prob' and msl.market_key in ('home_win','double_chance_1x')) or
            (msl.signal_key='away_win_prob' and msl.market_key in ('away_win','double_chance_x2'))
          )
        order by msl.wilson_lb desc
        limit 15
      ) m
    ),
    'model_signals_count', (select count(*) from public.model_signal_lab),
    'model_signals_last', (select max(computed_at) from public.model_signal_lab)
  );
end;
$$;
