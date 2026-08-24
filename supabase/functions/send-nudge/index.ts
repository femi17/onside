// Onside lifecycle nudger — the full ladder, one touch per (kind, user) EVER:
//   confirm  — email signup stuck at confirmation → magic link (confirms + signs in)
//   onboard  — confirmed, onboarding unfinished    → magic link to /onboarding
//   activate — onboarded 24h+, no slip & no agent  → today's card count + upload CTA
//   upsell   — free plan with an agent 24h+ old    → their agent's real record + Pro pitch
// Audiences come from nudge_targets() (SQL over auth.users — service-role only). Channel:
// web PUSH when the user has a subscription, EMAIL (Resend) otherwise — never both.
// Idempotency: api_cache `nudge:{kind}:{user}` claimed BEFORE sending, released only on a
// send failure — reruns and stray invocations can never double-touch anyone. The copy earns
// its weight with real numbers (fixtures today, their own graded picks, the platform week),
// never manufactured urgency.
import { createClient } from "npm:@supabase/supabase-js@2";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_KEY = Deno.env.get("SUPABASE_SECRET_KEY") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const sb = createClient(SB_URL, SB_KEY);
const RESEND_KEY = Deno.env.get("RESEND_API_KEY");
const FROM = "Onside <support@onside.com.ng>";
const SITE = "https://onside.com.ng";

type Kind = "confirm" | "onboard" | "activate" | "upsell";
type Target = { kind: Kind; userId: string; email: string };

function shell(inner: string): string {
  return `<!doctype html><html><body style="margin:0;padding:0;background:#0e1a1b;">
  <div style="max-width:520px;margin:0 auto;padding:36px 24px;font-family:Arial,Helvetica,sans-serif;">
    <div style="font-size:22px;font-weight:800;letter-spacing:-0.5px;margin-bottom:24px;">
      <span style="color:#f3f6f4;">ON</span><span style="color:#f0a828;">SIDE</span>
    </div>
    ${inner}
    <p style="color:#7d8f8a;font-size:11px;line-height:1.6;margin-top:32px;border-top:1px solid #223432;padding-top:16px;">
      18+ · Track responsibly · If this wasn't you, just ignore this email.<br>
      Onside · Thinka Platforms LTD · <a href="${SITE}" style="color:#7d8f8a;">onside.com.ng</a>
    </p>
  </div></body></html>`;
}
const button = (href: string, label: string) =>
  `<a href="${href}" style="display:inline-block;background:#f0a828;color:#101613;font-weight:700;font-size:15px;text-decoration:none;padding:13px 26px;border-radius:12px;margin-top:18px;">${label}</a>`;
const para = (t: string) => `<p style="color:#c9d6d2;font-size:15px;line-height:1.65;margin:0 0 12px;">${t}</p>`;

// facts that make the copy carry weight — fetched once per run, shared by every recipient
type RunFacts = {
  gamesToday: number;
  week: { graded: number; won: number };
  agentStats: Map<string, { name: string; graded: number; won: number }>; // by user_id
};
async function gatherFacts(userIds: string[]): Promise<RunFacts> {
  const dayStart = new Date(); dayStart.setUTCHours(0, 0, 0, 0);
  const dayEnd = new Date(dayStart); dayEnd.setUTCDate(dayEnd.getUTCDate() + 1);
  const { count: gamesToday } = await sb.from("fixtures")
    .select("id", { count: "exact", head: true })
    .gte("kickoff_utc", dayStart.toISOString()).lt("kickoff_utc", dayEnd.toISOString());
  const { data: wk } = await sb.rpc("public_record");
  const week = { graded: 0, won: 0 };
  for (const d of (wk?.days ?? []) as { graded: number; won: number }[]) { week.graded += d.graded; week.won += d.won; }
  const agentStats = new Map<string, { name: string; graded: number; won: number }>();
  if (userIds.length) {
    const { data: strat } = await sb.from("strategies").select("id, user_id, name").in("user_id", userIds);
    const byStrat = new Map((strat ?? []).map((s: { id: string; user_id: string; name: string }) => [s.id, s]));
    const ids = (strat ?? []).map((s: { id: string }) => s.id);
    if (ids.length) {
      const { data: dels } = await sb.from("deliveries").select("strategy_id, result").in("strategy_id", ids).in("result", ["won", "lost"]);
      for (const d of dels ?? []) {
        const s = byStrat.get(d.strategy_id as string);
        if (!s) continue;
        const cur = agentStats.get(s.user_id) ?? { name: s.name ?? "Your agent", graded: 0, won: 0 };
        cur.graded++; if (d.result === "won") cur.won++;
        agentStats.set(s.user_id, cur);
      }
      // users whose agent has no graded picks yet still get their agent's name
      for (const s of strat ?? []) if (!agentStats.has(s.user_id)) agentStats.set(s.user_id, { name: s.name ?? "Your agent", graded: 0, won: 0 });
    }
  }
  return { gamesToday: gamesToday ?? 0, week, agentStats };
}

function emailFor(t: Target, link: string, f: RunFacts): { subject: string; html: string } {
  if (t.kind === "confirm") return {
    subject: "Finish creating your Onside account",
    html: shell(
      para("You're one click from in.") +
      para("You started an Onside account but never got through the door — the confirmation step is all that's left. This link confirms your email and signs you straight in:") +
      button(link, "Confirm my account →") +
      para(`<br>Then upload any betslip screenshot and watch every leg track itself, live.`)
    ),
  };
  if (t.kind === "onboard") return {
    subject: "Your Onside setup is 2 minutes from done",
    html: shell(
      para("You're in — but your account isn't working for you yet.") +
      para("Finish setup to upload your first betslip (a screenshot is enough) and put an AI agent on your leagues:") +
      button(link, "Finish my setup →") +
      para(`<br>Every pick on Onside is graded in the open — misses included. See the live record at <a href="${SITE}/record" style="color:#f0a828;">onside.com.ng/record</a>.`)
    ),
  };
  if (t.kind === "activate") return {
    subject: `Your tracker is empty — today's card isn't (${f.gamesToday} games)`,
    html: shell(
      para("You set Onside up, then left it waiting.") +
      para(`There are <b style="color:#f3f6f4;">${f.gamesToday} games</b> on today's card. Next time you place a bet, snap the slip — one screenshot and every leg tracks itself live, settled exactly like the bookie settles it.`) +
      button(link, "Upload my first slip →") +
      para(`<br>Rather have picks come to you? Build an AI agent in plain English — it hunts your leagues and gets graded in public: <a href="${SITE}/record" style="color:#f0a828;">the record so far</a>.`)
    ),
  };
  const mine = f.agentStats.get(t.userId);
  const personal = mine && mine.graded > 0
    ? `Your agent <b style="color:#f3f6f4;">${mine.name}</b> has landed <b style="color:#f3f6f4;">${mine.won} of ${mine.graded}</b> graded picks — hunting daily, exactly as you built it. On Free that's the catch: it can <b style="color:#f3f6f4;">never be tuned</b>.`
    : `Your agent hunts every day, exactly as you built it — on Free it can <b style="color:#f3f6f4;">never be tuned</b>.`;
  return {
    subject: mine && mine.graded > 0 ? `${mine.name} landed ${mine.won} of ${mine.graded} — want to tune it?` : "Your agent is locked as built. Pro hands you the keys.",
    html: shell(
      para(personal) +
      para(`This week, Onside agents landed <b style="color:#f3f6f4;">${f.week.won} of ${f.week.graded}</b> graded picks — all in the open on <a href="${SITE}/record" style="color:#f0a828;">the record</a>.`) +
      para(`<b style="color:#f3f6f4;">Pro (₦500/mo)</b> unlocks tuning — change the rule, market and leagues — and runs up to 3 agents at once. <b style="color:#f3f6f4;">Pro Max (₦1,000/mo)</b> runs 7 across all 300+ leagues, with learning on.`) +
      button(link, "Upgrade my plan →")
    ),
  };
}

function pushFor(t: Target, f: RunFacts): { title: string; body: string; url: string } {
  if (t.kind === "activate") return {
    title: `Today's card: ${f.gamesToday} games`,
    body: "Snap your betslip — one screenshot and every leg tracks itself live.",
    url: "/tracker",
  };
  const mine = f.agentStats.get(t.userId);
  return {
    title: mine && mine.graded > 0 ? `${mine.name}: ${mine.won}/${mine.graded} landed` : "Your agent is locked as built",
    body: "Pro unlocks tuning and runs up to 3 agents — from ₦500/mo.",
    url: "/profile",
  };
}

Deno.serve(async (_req) => {
  if (!RESEND_KEY) return Response.json({ error: "RESEND_API_KEY not set" }, { status: 500 });

  const { data: rows, error: tgErr } = await sb.rpc("nudge_targets");
  if (tgErr) return Response.json({ error: tgErr.message }, { status: 500 });
  const targets: Target[] = (rows ?? []).map((r: { kind: string; user_id: string; email: string }) => ({
    kind: r.kind as Kind, userId: r.user_id, email: r.email,
  }));

  const facts = await gatherFacts(targets.filter((t) => t.kind === "upsell").map((t) => t.userId));
  const { data: subs } = await sb.from("push_subscriptions").select("user_id");
  const hasPush = new Set((subs ?? []).map((s: { user_id: string }) => s.user_id));
  const { data: pushSecret } = await sb.rpc("get_secret", { secret_name: "push_internal_secret" });

  const sent: string[] = [], skipped: string[] = [], failed: string[] = [];
  for (const t of targets) {
    const claimKey = `nudge:${t.kind}:${t.userId}`;
    const { error: dupe } = await sb.from("api_cache").insert({
      cache_key: claimKey, payload: { email: t.email, at: new Date().toISOString() },
    });
    if (dupe) { skipped.push(`${t.kind}:${t.email}`); continue; }

    let ok = false, channel = "email";
    // push channel: only for in-product nudges (activate/upsell) and only if subscribed
    if ((t.kind === "activate" || t.kind === "upsell") && hasPush.has(t.userId) && pushSecret) {
      channel = "push";
      const p = pushFor(t, facts);
      const resp = await fetch(`${SB_URL}/functions/v1/send-push`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-internal-secret": String(pushSecret) },
        body: JSON.stringify({ user_id: t.userId, title: p.title, body: p.body, url: p.url, tag: `nudge-${t.kind}` }),
      });
      ok = resp.ok;
    }
    if (!ok) {
      channel = "email";
      // magic link signs them in and lands them where the nudge points
      const dest = t.kind === "upsell" ? "/profile" : t.kind === "activate" ? "/tracker" : "/onboarding";
      let link = `${SITE}/login`;
      try {
        const { data: lk, error: lkErr } = await sb.auth.admin.generateLink({
          type: "magiclink", email: t.email, options: { redirectTo: `${SITE}${dest}` },
        });
        if (!lkErr && lk?.properties?.action_link) link = lk.properties.action_link;
      } catch { /* plain login link fallback stays */ }
      const msg = emailFor(t, link, facts);
      const resp = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${RESEND_KEY}` },
        body: JSON.stringify({ from: FROM, to: t.email, subject: msg.subject, html: msg.html }),
      });
      ok = resp.ok;
    }
    if (ok) sent.push(`${t.kind}:${channel}:${t.email}`);
    else {
      failed.push(`${t.kind}:${t.email}`);
      await sb.from("api_cache").delete().eq("cache_key", claimKey); // release for a retry run
    }
  }

  return Response.json({ candidates: targets.length, sent, skipped, failed });
});
