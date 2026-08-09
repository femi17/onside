-- SECURITY: several SECURITY DEFINER functions were callable straight from the public API
-- (/rest/v1/rpc/...) by anon and/or authenticated. Because they run as their owner (postgres) they
-- bypass RLS, so exposing them lets an outsider trigger internal settlement/build/notify logic —
-- e.g. anon could call void_dead_fixture_bets() (mutates bets), build_onside_double() (runs the
-- build + sends push), or invoke_capture_closing() (fires an edge fn). The trigger functions
-- (settle_goals_in_row / guard_in_row_row / notify_fixture_event / notify_bet_progress) must never
-- be called directly either — triggers still fire regardless of EXECUTE grants.
--
-- These are internal/cron/trigger-only and are NOT called by the app (grep of src/ confirms).
-- Cron and triggers run as postgres, so revoking anon/authenticated does not affect them.
-- App-facing RPCs (settle_delivery, community_*, join_community, set_leaderboard_opt_in,
-- slip_upload_quota, admin_*, api_usage_today, clv_summary, search_fixtures, add_league_coverage)
-- are intentionally left callable by authenticated — they gate on auth.uid()/is_admin internally.
revoke execute on function public.build_onside_double()        from anon, authenticated;
revoke execute on function public.void_dead_fixture_bets()     from anon, authenticated;
revoke execute on function public.invoke_capture_closing()     from anon, authenticated;
revoke execute on function public.settle_goals_in_row()        from anon, authenticated;
revoke execute on function public.guard_in_row_row()           from anon, authenticated;
revoke execute on function public.notify_fixture_event()       from anon, authenticated;
revoke execute on function public.notify_bet_progress()        from anon, authenticated;
revoke execute on function public.strategy_has_full_day(uuid)  from anon, authenticated;
