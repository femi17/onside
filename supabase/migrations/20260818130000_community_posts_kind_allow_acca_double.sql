-- The community_post RPC gained admin-only kinds 'acca' and 'double' but the table's kind
-- check was never widened — posting the Onside Double failed on the constraint.
alter table public.community_posts drop constraint community_posts_kind_check;
alter table public.community_posts add constraint community_posts_kind_check
  check (kind = any (array['note'::text, 'slip'::text, 'result'::text, 'picks'::text, 'acca'::text, 'double'::text]));
