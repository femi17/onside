// delete-account: permanent self-service account deletion from the Profile page. verify_jwt
// keeps anonymous traffic out, and the ONLY account this can ever delete is the CALLER'S own
// (taken from their JWT — no user id is accepted as input). Admin accounts refuse, so the
// owner can't nuke the platform account with a mis-tap. Deletion path: community content is
// swept explicitly (those tables carry no user FK — ghosts would survive otherwise), then
// auth.admin.deleteUser cascades auth.users → profiles → agents/tickets/accas/deliveries/
// imports/subscriptions; payments and team_aliases SET NULL (anonymised audit rows remain).
import { createClient } from "npm:@supabase/supabase-js@2";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_KEY = Deno.env.get("SUPABASE_SECRET_KEY") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const sb = createClient(SB_URL, SB_KEY);

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { "Content-Type": "application/json", ...CORS } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  const { data: userData } = await sb.auth.getUser(jwt);
  const user = userData?.user;
  if (!user) return json({ error: "not signed in" }, 401);

  const { data: prof } = await sb.from("profiles").select("is_admin").eq("id", user.id).maybeSingle();
  if (prof?.is_admin) return json({ error: "Admin accounts can't be self-deleted." }, 403);

  // community tables have no user FK — sweep the user's content so no ghost rows survive
  await sb.from("community_reactions").delete().eq("user_id", user.id);
  await sb.from("community_comments").delete().eq("user_id", user.id);
  await sb.from("community_posts").delete().eq("user_id", user.id);

  const { error } = await sb.auth.admin.deleteUser(user.id);
  if (error) return json({ error: error.message }, 500);
  return json({ ok: true });
});
