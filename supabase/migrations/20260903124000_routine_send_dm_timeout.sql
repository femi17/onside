-- Mirror of remotely applied migration routine_send_dm_timeout (2026-09-03).
-- routine_send_dm was dropping DMs intermittently: net.http_post defaults to a 5s timeout, and the
-- TLS handshake to api.telegram.org sometimes exceeds it (net._http_response showed handshake-time
-- timeouts). The RPC returned "1" because pg_net only QUEUES the request — it never sees the failure.
-- Raise the timeout to 20s and set an explicit Content-Type. Successful sends log ok:true in
-- net._http_response (message_id 720 and 723 confirmed delivered to the owner).
create or replace function public.routine_send_dm(p_token text, p_text text)
returns integer
language plpgsql
security definer
set search_path to ''
as $$
declare
  tok text;
  bot text;
  sent integer := 0;
  cid bigint;
begin
  select decrypted_secret into tok from vault.decrypted_secrets where name = 'routine_token';
  if tok is null or p_token is distinct from tok then
    raise exception 'invalid token';
  end if;
  if p_text is null or length(btrim(p_text)) = 0 then
    return 0;
  end if;

  select decrypted_secret into bot from vault.decrypted_secrets where name = 'telegram_bot_token';
  if bot is null then
    raise exception 'telegram_bot_token missing from vault';
  end if;

  for cid in
    select telegram_chat_id from public.profiles
    where is_admin = true and telegram_chat_id is not null
  loop
    perform net.http_post(
      url := 'https://api.telegram.org/bot' || bot || '/sendMessage',
      body := jsonb_build_object('chat_id', cid, 'text', left(p_text, 4000)),
      headers := jsonb_build_object('Content-Type', 'application/json'),
      timeout_milliseconds := 20000
    );
    sent := sent + 1;
  end loop;

  return sent;
end;
$$;
