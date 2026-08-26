-- Third daily channel post (owner request): the afternoon "product_gap" slot — the
-- broadcast agent measures real platform adoption (push on, agent rules written, slips
-- uploaded, community joined, installs via push proxy), picks the weakest habit not
-- covered in the last 4 gap posts, and teaches it. 13:30 UTC = 14:30 Lagos, between the
-- morning slate (06:30) and the results recap (21:30).
select cron.schedule(
  'broadcast-product-gap',
  '30 13 * * *',
  $$select public.invoke_community_broadcast('product_gap')$$
);
