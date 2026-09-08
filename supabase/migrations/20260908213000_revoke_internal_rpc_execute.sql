-- SECURITY (advisors 0028/0029, 2026-09-08): these SECURITY DEFINER functions are internal —
-- cron jobs, trigger functions, and mining/sweep/build helpers. They were callable by anon /
-- authenticated via /rest/v1/rpc/* (EXECUTE is granted to PUBLIC by Postgres default), so anyone
-- with the public anon key could trigger settlement sweeps, void bets, rebuild the Double, or run
-- expensive mining. Revoke EXECUTE from public/anon/authenticated. service_role (edge functions)
-- and postgres (pg_cron + triggers) keep their EXPLICIT grants, so nothing internal breaks.
-- None of these is called from the frontend (verified against every supabase.rpc() call in src/).
-- Left intentionally callable: the public/authenticated RPCs the app uses, and the token-gated
-- routine functions (platform_health / routine_send_dm / rule_lab_report — protected by p_token).

revoke execute on function public._insight_sample(timestamp with time zone, integer) from public, anon, authenticated;
revoke execute on function public._push_fixture_groups(text, jsonb, jsonb, text, text, text, text) from public, anon, authenticated;
revoke execute on function public.build_onside_double() from public, anon, authenticated;
revoke execute on function public.build_onside_triple() from public, anon, authenticated;
revoke execute on function public.enforce_generated_acca_limit() from public, anon, authenticated;
revoke execute on function public.guard_in_row_row() from public, anon, authenticated;
revoke execute on function public.invoke_capture_closing() from public, anon, authenticated;
revoke execute on function public.mine_all_insights() from public, anon, authenticated;
revoke execute on function public.mine_delivery_discoveries() from public, anon, authenticated;
revoke execute on function public.mine_discoveries(integer, integer) from public, anon, authenticated;
revoke execute on function public.mine_model_signals() from public, anon, authenticated;
revoke execute on function public.mine_rule_lab_inner() from public, anon, authenticated;
revoke execute on function public.notify_bet_progress() from public, anon, authenticated;
revoke execute on function public.notify_fixture_event() from public, anon, authenticated;
revoke execute on function public.notify_ticket_settled() from public, anon, authenticated;
revoke execute on function public.paper_validate_discoveries() from public, anon, authenticated;
revoke execute on function public.protect_free_agent() from public, anon, authenticated;
revoke execute on function public.settle_goals_in_row() from public, anon, authenticated;
revoke execute on function public.sweep_agent_tickets() from public, anon, authenticated;
revoke execute on function public.sweep_pending_deliveries() from public, anon, authenticated;
revoke execute on function public.void_dead_fixture_bets() from public, anon, authenticated;
