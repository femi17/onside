-- Daily activity counts for /analytics (owner request): slip uploads, predictions delivered,
-- and games tracked — per day, last 30 days, REAL USERS only (same internal exclusion rule as
-- admin_analytics). Its own small RPC so the big analytics function stays untouched.
create or replace function public.admin_daily_activity()
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_admin boolean;
  v_excl uuid[];
begin
  select is_admin into v_admin from public.profiles where id = auth.uid();
  if not coalesce(v_admin, false) then raise exception 'not authorized'; end if;

  select coalesce(array_agg(p.id), '{}') into v_excl
  from public.profiles p
  left join auth.users u on u.id = p.id
  where p.is_admin = true
     or u.email in ('tyewoduola@gmail.com', 'demo@onside.com.ng', 'oduolafemi17@gmail.com');

  return jsonb_build_object(
    'uploads_daily', (select coalesce(jsonb_agg(jsonb_build_object('day', d, 'n', c) order by d), '[]'::jsonb)
        from (select date_trunc('day', created_at)::date d, count(*) c
              from public.screenshot_imports
              where user_id <> all(v_excl) and created_at > now() - interval '30 days'
              group by 1) s),
    'deliveries_daily', (select coalesce(jsonb_agg(jsonb_build_object('day', d, 'n', c) order by d), '[]'::jsonb)
        from (select date_trunc('day', delivered_at)::date d, count(*) c
              from public.deliveries
              where user_id <> all(v_excl) and delivered_at > now() - interval '30 days'
              group by 1) s),
    'tickets_daily', (select coalesce(jsonb_agg(jsonb_build_object('day', d, 'n', c) order by d), '[]'::jsonb)
        from (select date_trunc('day', created_at)::date d, count(*) c
              from public.tickets
              where user_id <> all(v_excl) and created_at > now() - interval '30 days'
              group by 1) s)
  );
end;
$function$;
revoke all on function public.admin_daily_activity() from public, anon;
grant execute on function public.admin_daily_activity() to authenticated;
