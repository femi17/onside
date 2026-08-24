-- Second daily nudge tick at 17:00 Lagos (16:00 UTC): the pre-evening-kickoff window when
-- slips get built — the moment an "upload your slip" or "your agent could hunt daily" touch
-- lands as useful rather than noise. Same function as the 09:00 UTC tick; the once-per-
-- (kind,user) claim means two ticks only widen the delivery windows, never the volume.
select cron.schedule('send-nudge-evening', '0 16 * * *', 'select public.invoke_send_nudge()');
