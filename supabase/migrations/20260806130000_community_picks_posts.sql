-- "Publish my agents here" now actually publishes: each agent run posts its top picks (max 5) to
-- the community feed as a compact `picks` post — short and precise, no prose. Inserted by
-- run-strategies (service role) for members with community_opt_in + leaderboard_opt_in + a handle.
alter table community_posts drop constraint community_posts_kind_check;
alter table community_posts add constraint community_posts_kind_check
  check (kind = any (array['note'::text, 'slip'::text, 'result'::text, 'picks'::text]));
