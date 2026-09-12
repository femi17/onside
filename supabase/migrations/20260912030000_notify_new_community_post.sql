-- Mirror of remotely applied migration notify_new_community_post (2026-09-12).
-- Idea tracker: after the founder asked users to post what they want in the community, ping every
-- admin on Telegram the instant a new (non-hidden) post lands — author + text + a link to reply.
-- Posts persist in community_posts as the record; this is the real-time signal for a fast founder
-- reply (the retention lever). Skips the poster's own admin account. Filter by `kind` later if busy.
create or replace function public.notify_new_community_post()
returns trigger language plpgsql security definer set search_path to '' as $function$
declare v_token text; r record;
begin
  if coalesce(NEW.hidden,false) then return NEW; end if;
  select decrypted_secret into v_token from vault.decrypted_secrets where name='telegram_bot_token' limit 1;
  if v_token is null then return NEW; end if;
  for r in
    select telegram_chat_id from public.profiles
    where is_admin = true and telegram_chat_id is not null and id <> NEW.user_id
  loop
    perform net.http_post(
      url := 'https://api.telegram.org/bot' || v_token || '/sendMessage',
      headers := jsonb_build_object('Content-Type','application/json'),
      body := jsonb_build_object(
        'chat_id', r.telegram_chat_id, 'disable_web_page_preview', true,
        'text', '💡 New community post — ' || coalesce(NEW.author_handle,'someone') || E':\n\n'
                || left(coalesce(NEW.body,'(no text)'),400) || E'\n\n→ onside.com.ng/community'
      ),
      timeout_milliseconds := 8000);
  end loop;
  return NEW;
end;
$function$;

drop trigger if exists trg_new_community_post on public.community_posts;
create trigger trg_new_community_post
  after insert on public.community_posts
  for each row execute function public.notify_new_community_post();
