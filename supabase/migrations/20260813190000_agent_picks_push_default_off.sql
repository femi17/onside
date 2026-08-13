-- Agent-delivered predictions are for games the user hasn't necessarily tracked, so pushing them by
-- default is noise. Make the agent_picks push category OPT-IN (default off): new prefs rows default
-- false, and existing rows (only ever the auto-seeded default) flip to false. Users opt in via the
-- "Agent predictions" toggle in Profile · Notifications. Picks still show in-app regardless.
alter table public.notification_prefs alter column agent_picks set default false;
update public.notification_prefs set agent_picks = false where agent_picks is distinct from false;
