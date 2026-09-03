-- Mirror of remotely applied migration routine_report_fallback (2026-09-03).
-- The rule-lab-review cloud routine's first run (04:33 UTC) did all its work — experiment,
-- lab upsert, library refresh — but the Telegram DM step failed: the prompt had it fetch the
-- bot token and hand-roll the Telegram API POST from the sandbox. These two token-gated RPCs
-- collapse that into single calls the routine makes via execute_sql (or plain PostgREST HTTP
-- with the anon key if MCP is ever unavailable). The token lives in vault ('routine_token')
-- and in the routine's private prompt only — the anon key alone cannot invoke either usefully.

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
    'lab_last_mined', (select max(computed_at) from public.rule_lab)
  );
end;
$$;

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
      body := jsonb_build_object('chat_id', cid, 'text', left(p_text, 4000))
    );
    sent := sent + 1;
  end loop;

  return sent;
end;
$$;

revoke all on function public.rule_lab_report(text) from public;
revoke all on function public.routine_send_dm(text, text) from public;
grant execute on function public.rule_lab_report(text) to anon, authenticated, service_role;
grant execute on function public.routine_send_dm(text, text) to anon, authenticated, service_role;
