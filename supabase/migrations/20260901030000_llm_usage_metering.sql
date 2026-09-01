-- Per-feature Anthropic spend attribution. Every edge-function Claude call logs its token
-- usage here tagged with a purpose (slip_upload / social_post / agent_rules); the admin
-- analytics page prices the tokens per model and shows where the credit goes. The Anthropic
-- cost API can't do this split itself — everything shares one API key.

create table public.llm_usage (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  purpose text not null,
  model text not null,
  input_tokens integer not null default 0,
  output_tokens integer not null default 0,
  cache_read_tokens integer not null default 0,
  cache_creation_tokens integer not null default 0
);

create index llm_usage_at_idx on public.llm_usage (at);

-- No policies: only the service role (edge functions) writes, and reads go through the
-- is_admin-gated RPC below.
alter table public.llm_usage enable row level security;

create or replace function public.admin_llm_usage()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  result jsonb;
begin
  -- same defence-in-depth gate as the other admin_* RPCs
  if not exists (select 1 from profiles where id = auth.uid() and is_admin) then
    return null;
  end if;
  select coalesce(jsonb_agg(row_to_json(t)), '[]'::jsonb) into result from (
    select purpose, model,
      count(*)::int as calls,
      sum(input_tokens)::bigint as input_tokens,
      sum(output_tokens)::bigint as output_tokens,
      sum(cache_read_tokens)::bigint as cache_read_tokens,
      sum(cache_creation_tokens)::bigint as cache_creation_tokens
    from llm_usage
    where at >= now() - interval '30 days'
    group by purpose, model
  ) t;
  return result;
end;
$$;

revoke all on function public.admin_llm_usage() from public;
grant execute on function public.admin_llm_usage() to authenticated;
