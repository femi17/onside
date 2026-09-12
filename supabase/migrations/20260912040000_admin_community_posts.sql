-- Mirror of remotely applied migration admin_community_posts (2026-09-12).
-- Admin "Ideas" list for /analytics: newest community posts at a glance (the founder asked users to
-- post what they want there). Admin-gated (defence in depth alongside the page's is_admin check).
create or replace function public.admin_community_posts()
returns jsonb language plpgsql security definer set search_path to '' as $function$
declare v_admin boolean;
begin
  select is_admin into v_admin from public.profiles where id = auth.uid();
  if not coalesce(v_admin, false) then raise exception 'not authorized'; end if;
  return (
    select coalesce(jsonb_agg(jsonb_build_object(
      'id', p.id,
      'who', coalesce(p.author_handle, 'anon'),
      'body', p.body,
      'kind', p.kind,
      'likes', p.like_count,
      'comments', p.comment_count,
      'at', p.created_at,
      'hidden', p.hidden
    ) order by p.created_at desc), '[]'::jsonb)
    from (select * from public.community_posts order by created_at desc limit 100) p
  );
end;
$function$;
revoke all on function public.admin_community_posts() from public, anon;
grant execute on function public.admin_community_posts() to authenticated, service_role;
