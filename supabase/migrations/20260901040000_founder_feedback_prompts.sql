-- Founder feedback loop: one targeted question at a time, in-app, tied to what the user
-- actually did (staked agent picks, suffered a losing pick, tracked bets...). One ask per
-- user per 7 days, never the same question twice, admins/demo excluded. Answers surface on
-- /analytics via admin_feedback(). Question copy lives in the app (FounderQuestion.tsx);
-- only keys and answers live here.

create table public.user_prompts (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  prompt_key text not null,
  asked_at timestamptz not null default now(),
  answered_at timestamptz,
  answer text,
  note text,
  unique (user_id, prompt_key)
);

create index user_prompts_user_idx on public.user_prompts (user_id, asked_at desc);

-- no direct policies: reads/writes go through the RPCs below (security definer)
alter table public.user_prompts enable row level security;

-- Pick (and record) the next question for the signed-in user, or null if nothing is due.
-- Selecting a question INSERTS the ask row, so an ignored card still counts toward the
-- weekly cap — a user who dismisses is not re-nagged on the next page load.
create or replace function public.next_feedback_prompt()
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid := auth.uid();
  k text;
begin
  if uid is null then return null; end if;
  if exists (select 1 from profiles where id = uid and is_admin) then return null; end if;
  if exists (select 1 from auth.users where id = uid and email = 'demo@onside.com.ng') then return null; end if;
  if exists (select 1 from user_prompts where user_id = uid and asked_at > now() - interval '7 days') then return null; end if;

  -- priority order: the most moment-tied question the user qualifies for and hasn't been asked
  k := case
    when (select count(*) from deliveries where user_id = uid and delivered_at > now() - interval '7 days') >= 3
         and not exists (select 1 from user_prompts where user_id = uid and prompt_key = 'agent_staked')
      then 'agent_staked'
    when exists (select 1 from deliveries where user_id = uid and result = 'lost' and settled_at > now() - interval '7 days')
         and not exists (select 1 from user_prompts where user_id = uid and prompt_key = 'losing_pain')
      then 'losing_pain'
    when exists (select 1 from tickets where user_id = uid and status in ('won', 'lost'))
         and not exists (select 1 from user_prompts where user_id = uid and prompt_key = 'tracking_value')
      then 'tracking_value'
    when (select count(*) from tickets where user_id = uid) + (select count(*) from screenshot_imports where user_id = uid) >= 5
         and not exists (select 1 from user_prompts where user_id = uid and prompt_key = 'pmf')
      then 'pmf'
    when (select count(*) from deliveries where user_id = uid and result in ('won', 'lost')) >= 10
         and not exists (select 1 from user_prompts where user_id = uid and prompt_key = 'agent_quality')
      then 'agent_quality'
    when (exists (select 1 from tickets where user_id = uid) or exists (select 1 from strategies where user_id = uid))
         and not exists (select 1 from user_prompts where user_id = uid and prompt_key = 'improve')
      then 'improve'
    else null
  end;

  if k is null then return null; end if;
  insert into user_prompts (user_id, prompt_key) values (uid, k) on conflict do nothing;
  return k;
end;
$$;

-- Record an answer (or a dismissal when p_answer is null). Only fills an open ask.
create or replace function public.answer_feedback_prompt(p_key text, p_answer text, p_note text)
returns void
language sql
security definer
set search_path = public
as $$
  update user_prompts
  set answer = coalesce(p_answer, '(dismissed)'),
      note = nullif(trim(coalesce(p_note, '')), ''),
      answered_at = now()
  where user_id = auth.uid() and prompt_key = p_key and answered_at is null;
$$;

-- Admin read: answer distribution per question + the recent individual answers with notes.
create or replace function public.admin_feedback()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (select 1 from profiles where id = auth.uid() and is_admin) then
    return null;
  end if;
  return jsonb_build_object(
    'summary', (
      select coalesce(jsonb_agg(row_to_json(t)), '[]'::jsonb) from (
        select prompt_key, answer, count(*)::int as n
        from user_prompts where answered_at is not null
        group by prompt_key, answer
        order by prompt_key, n desc
      ) t
    ),
    'recent', (
      select coalesce(jsonb_agg(row_to_json(r)), '[]'::jsonb) from (
        select up.prompt_key, up.answer, up.note, up.answered_at,
               coalesce(p.display_name, 'user') as who
        from user_prompts up
        left join profiles p on p.id = up.user_id
        where up.answered_at is not null
        order by up.answered_at desc
        limit 40
      ) r
    )
  );
end;
$$;

revoke all on function public.next_feedback_prompt() from public;
revoke all on function public.answer_feedback_prompt(text, text, text) from public;
revoke all on function public.admin_feedback() from public;
grant execute on function public.next_feedback_prompt() to authenticated;
grant execute on function public.answer_feedback_prompt(text, text, text) to authenticated;
grant execute on function public.admin_feedback() to authenticated;
