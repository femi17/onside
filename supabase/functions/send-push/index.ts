// Web Push sender. Trusted callers may target any user; a signed-in user hits their own devices.
//  - service key (Bearer) OR x-internal-secret header (matches vault push_internal_secret) -> trusted,
//    may target { user_id } / { user_ids } (agent picks from run-strategies; settlement/fixture triggers)
//  - otherwise the user's JWT -> sends to THAT user's own devices (self-test / their alerts)
// verify_jwt is OFF because trusted internal callers (DB triggers) present no JWT; auth is enforced
// here (internal secret, service key, or a validated user JWT). VAPID keys live in the vault.
//
// Per-category preferences are enforced HERE (one place): callers pass a `category`, and targets are
// gated by notification_prefs. Default-on categories send unless turned off (opt-out); default-off
// categories (goals) send only when turned on (opt-in). See CATEGORY_DEFAULT_ON.
import { createClient } from "npm:@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE = Deno.env.get("SUPABASE_SECRET_KEY") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
const admin = createClient(SB_URL, SERVICE);

// per-category default: true = opt-out (on unless turned off), false = opt-in (off unless turned on).
// goals + build_up are noisy so they only fire when explicitly enabled. The keys also whitelist the
// category (SQL-injection guard for the dynamic column select below).
const CATEGORY_DEFAULT_ON: Record<string, boolean> = {
  // agent_picks ("your agent submitted new picks") and agent_games (live/result alerts for the agent's
  // picked games) are two independent OPT-INs — off unless turned on (picks still appear in-app).
  // goals/build_up/cards are opt-in for noise.
  agent_picks: false, agent_games: false, results: true, kickoff: true, full_time: true, goals: false,
  community: true, build_up: false, cards: false,
  // swing = a goal flipped a result-market pick's live verdict (on-track ↔ behind).
  // High-signal by construction, so default ON — raw every-goal stays the opt-in 'goals'.
  swing: true,
};

async function getSecret(name: string): Promise<string | null> {
  const { data } = await admin.rpc("get_secret", { secret_name: name });
  return (data as string) ?? null;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  const authHeader = req.headers.get("Authorization") ?? "";
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  const internalSecret = req.headers.get("x-internal-secret");

  const body = await req.json().catch(() => ({}));
  const title = String(body.title ?? "Onside");
  const message = String(body.body ?? "");
  const url = String(body.url ?? "/tracker");
  const tag = body.tag ? String(body.tag) : undefined;
  const category = body.category && (String(body.category) in CATEGORY_DEFAULT_ON) ? String(body.category) : null;

  // resolve who to send to
  const trustedInternal = !!internalSecret && internalSecret === (await getSecret("push_internal_secret"));
  const trusted = trustedInternal || (!!token && token === SERVICE);
  let targets: string[] = [];
  if (trusted) {
    targets = Array.isArray(body.user_ids) ? body.user_ids.map(String) : body.user_id ? [String(body.user_id)] : [];
  } else {
    if (!token) return json({ error: "unauthorized" }, 401);
    const scoped = createClient(SB_URL, ANON, { global: { headers: { Authorization: authHeader } } });
    const { data: { user } } = await scoped.auth.getUser();
    if (!user) return json({ error: "unauthorized" }, 401);
    targets = [user.id];
  }
  if (!targets.length) return json({ error: "no target" }, 400);

  // per-category preference gate. default-on categories send unless the row says false (opt-out);
  // default-off categories (goals) send only when the row says true (opt-in). A missing row = default.
  let optedOut = 0;
  if (category) {
    const defaultOn = CATEGORY_DEFAULT_ON[category];
    const { data: prefs } = await admin.from("notification_prefs").select(`user_id, ${category}`).in("user_id", targets);
    const prefBy = new Map((prefs ?? []).map((p: any) => [p.user_id, p[category]]));
    const before = targets.length;
    targets = targets.filter((t) => { const v = prefBy.get(t); return defaultOn ? v !== false : v === true; });
    optedOut = before - targets.length;
  }
  if (!targets.length) return json({ sent: 0, optedOut, note: "all targets opted out" });

  const [subject, publicKey, privateKey] = await Promise.all([
    getSecret("vapid_subject"), getSecret("vapid_public_key"), getSecret("vapid_private_key"),
  ]);
  if (!publicKey || !privateKey) return json({ error: "VAPID not configured" }, 500);
  webpush.setVapidDetails(subject || "mailto:admin@onside.com.ng", publicKey, privateKey);

  const { data: subs } = await admin
    .from("push_subscriptions").select("endpoint, p256dh, auth").in("user_id", targets);
  if (!subs?.length) return json({ sent: 0, optedOut, note: "no subscriptions" });

  // opt-in "Mute" action button: a caller (e.g. agent deliveries) sets mute:true, and the SW POSTs the
  // device's own push endpoint to push-action to turn THIS category off — no app open, no JWT needed.
  const mute = !!body.mute && !!category;
  const payload = JSON.stringify({
    title, body: message, url, tag, icon: "/icons/icon-192.png",
    ...(mute ? { actions: [{ action: "mute", title: "Mute agent alerts" }], muteUrl: `${SB_URL}/functions/v1/push-action`, muteCategory: category } : {}),
  });
  let sent = 0, pruned = 0;
  await Promise.all(subs.map(async (s) => {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload);
      sent++;
    } catch (e) {
      const code = (e as { statusCode?: number }).statusCode;
      if (code === 404 || code === 410) { await admin.from("push_subscriptions").delete().eq("endpoint", s.endpoint); pruned++; }
    }
  }));

  return json({ sent, pruned, optedOut, targets: targets.length });
});
