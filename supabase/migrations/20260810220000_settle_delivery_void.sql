-- Let the agent-feed manual settle VOID a delivery (game off / postponed / abandoned), matching the
-- tracker + acca. Was won/lost only. RLS still scoped via auth.uid(); only pending/void rows change.
create or replace function public.settle_delivery(p_id uuid, p_result text, p_score text default null)
returns void
language plpgsql
security definer
set search_path to ''
as $function$
begin
  if p_result not in ('won', 'lost', 'void') then
    raise exception 'result must be won, lost or void';
  end if;
  update public.deliveries
     set result = p_result,
         settle_score = nullif(btrim(coalesce(p_score, '')), ''),
         settled_at = now()
   where id = p_id and user_id = auth.uid() and result in ('pending', 'void');
end;
$function$;
