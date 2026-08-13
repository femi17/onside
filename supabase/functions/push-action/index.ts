// Background action handler for web-push notification buttons (currently "Mute"). Called by the
// service worker with the device's own push endpoint — an unguessable capability tied to one user's
// subscription — so no JWT is needed (verify_jwt off). It resolves the owner from push_subscriptions
// and flips a notification_prefs category off. Muting is low-risk (worst case: someone who already has
// your secret endpoint silences your alerts, which you re-enable in Profile · Notifications).
import { createClient } from "npm:@supabase/supabase-js@2";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE = Deno.env.get("SUPABASE_SECRET_KEY") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const admin = createClient(SB_URL, SERVICE);

// whitelist doubles as an injection guard for the dynamic column upsert below
const CATEGORIES = new Set(["agent_picks", "agent_games", "results", "kickoff", "full_time", "goals", "cards", "build_up", "community"]);
const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { "content-type": "application/json", ...CORS } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  const body = await req.json().catch(() => ({}));
  const endpoint = typeof body.endpoint === "string" ? body.endpoint : "";
  const category = typeof body.category === "string" && CATEGORIES.has(body.category) ? body.category : "agent_picks";
  if (!endpoint) return json({ error: "missing endpoint" }, 400);

  const { data: sub } = await admin.from("push_subscriptions").select("user_id").eq("endpoint", endpoint).maybeSingle();
  if (!sub?.user_id) return json({ error: "unknown subscription" }, 404);

  const { error } = await admin.from("notification_prefs").upsert(
    { user_id: sub.user_id, [category]: false, updated_at: new Date().toISOString() },
    { onConflict: "user_id" },
  );
  if (error) return json({ error: error.message }, 500);
  return json({ ok: true, category });
});
