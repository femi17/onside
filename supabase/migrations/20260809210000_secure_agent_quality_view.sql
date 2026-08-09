-- SECURITY FIX: public.agent_quality leaked every user's data to anon/authenticated.
--
-- It is a SECURITY DEFINER view (no security_invoker) owned by postgres, and it had been granted to
-- both anon and authenticated. A non-invoker view runs as its owner and BYPASSES the RLS on the
-- underlying strategies/deliveries tables, so any caller — including a logged-out anon via
-- /rest/v1/agent_quality — could read every user's agent name, user_id, settled count, wins and
-- win_rate. That is a cross-user data leak.
--
-- Nothing in the app queries this view directly; its only consumer is build_onside_double()
-- (SECURITY DEFINER, runs as the view owner), which does NOT need the anon/authenticated grant.
-- So: revoke public access, and flip the view to security_invoker so it can never bypass RLS again
-- even if it is re-granted later (this also clears the linter's Security Definer View error).
revoke all on public.agent_quality from anon, authenticated;
alter view public.agent_quality set (security_invoker = on);
