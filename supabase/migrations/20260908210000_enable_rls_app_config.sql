-- SECURITY (advisor rls_disabled_in_public, 2026-09-08): public.app_config had RLS disabled, so
-- anyone with the anon key could read/edit/delete it via PostgREST. It's a backend-only key-value
-- table (one row: revenue_epoch) read ONLY inside SECURITY DEFINER functions (platform_health etc.),
-- which bypass RLS. Nothing client-side reads it. Enable RLS with NO policy → deny-by-default for
-- anon/authenticated (service_role + definer functions still bypass), exactly like the other
-- backend tables (api_cache, odds_cache, model_params, …). No app behaviour changes.
alter table public.app_config enable row level security;
