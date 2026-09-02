// Onside lifecycle nudger — the full ladder, one touch per (kind, user) EVER:
//   confirm  — email signup stuck at confirmation → magic link (confirms + signs in)
//   onboard  — confirmed, onboarding unfinished    → magic link to /onboarding
//   activate — onboarded 24h+, no slip & no agent  → today's card count + upload CTA
//   upsell   — free plan with an agent 24h+ old    → their agent's real record + Pro pitch
// Plus the repeatable perfect-day congratulation: an agent whose whole delivered day (3+
// picks) settled won → congrats + plan-matched upsell, at most once per (user, day).
// Plus the once-EVER first-win congratulation (owner-ruled, Bobby's 1/1 case): the first
// graded win of a user's agent — any card size — earns one celebration; a perfect-day
// already celebrated covers it (the bigger honour wins). Bypasses the weekly cap like
// perfect days (earned + time-sensitive), stamps the cooldown after.
// Plus a one-time bot DM inviting Telegram-linked users into the @onsideai channel
// (skipped-but-claimed when getChatMember says they're already in).
// Audiences come from nudge_targets() (SQL over auth.users — service-role only). Channel:
// web PUSH when the user has a subscription, EMAIL (Resend) otherwise — never both.
// Idempotency: api_cache `nudge:{kind}:{user}` claimed BEFORE sending, released only on a
// send failure — reruns and stray invocations can never double-touch anyone. On top of that,
// a GLOBAL weekly cooldown (owner-ruled): at most ONE nudge touch per user per 7 days across
// every kind and channel (`nudge:last:{user}`). A cooldown-blocked nudge is NOT claimed — it
// simply waits and fires on the first tick after the week passes. EXCEPTION (owner-ruled
// 2026-08-26): perfect-day congratulations BYPASS the cap — an earned, time-sensitive reward
// always sends — but still stamp the cooldown so other marketing waits behind it. The copy earns its weight
// with real numbers (fixtures today, their own graded picks, the platform week), never
// manufactured urgency.
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

// ---- perfect-day congratulation + plan-matched upsell ----
type PerfectRow = { user_id: string; email: string; plan: string; agent: string; day: string; n: number };

function perfectEmail(r: PerfectRow, link: string): { subject: string; html: string } {
  const score = `${r.n}/${r.n}`;
  const head =
    para(`<b style="color:#f3f6f4;">${r.agent}</b> delivered <b style="color:#f3f6f4;">${r.n} picks</b> and every single one landed. <b style="color:#f3f6f4;">${score}. A perfect day.</b>`) +
    para("No cherry-picking — that's the whole day's card, graded in the open like everything on Onside.");
  if (r.plan === "pro") return {
    subject: `🎯 ${r.agent} went ${score} — a perfect day`,
    html: shell(head +
      para(`Imagine that across more of the map: <b style="color:#f3f6f4;">Pro Max (₦1,000/mo)</b> runs 7 agents over all 300+ leagues, with learning on so they self-tune.`) +
      button(link, "See Pro Max →")),
  };
  if (r.plan === "pro_max") return {
    subject: `🎯 ${r.agent} went ${score} — a perfect day`,
    html: shell(head +
      para("That's what a tuned agent looks like. Your record page makes the case for you — worth a share.") +
      button(link, "See my record →")),
  };
  return {
    subject: `🎯 ${r.agent} went ${score} — a perfect day`,
    html: shell(head +
      para(`And here's the thing: it did that <b style="color:#f3f6f4;">locked as built</b> — on Free it can never be tuned. <b style="color:#f3f6f4;">Pro (₦500/mo)</b> hands you the keys: change the rule, market and leagues, and run up to 3 agents at once.`) +
      button(link, "Upgrade to Pro →")),
  };
}

function perfectPush(r: PerfectRow): { title: string; body: string; url: string } {
  const score = `${r.n}/${r.n}`;
  if (r.plan === "pro") return { title: `🎯 ${r.agent}: ${score} — perfect day`, body: "Pro Max runs 7 agents across all 300+ leagues, learning on.", url: "/profile" };
  if (r.plan === "pro_max") return { title: `🎯 ${r.agent}: ${score} — perfect day`, body: "The whole day's card landed. Your record makes the case — share it.", url: "/my-record" };
  return { title: `🎯 ${r.agent}: ${score} — perfect day`, body: "It did that locked as built. Pro unlocks tuning — ₦500/mo.", url: "/profile" };
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

  // weekly cooldown ledger: one row per user, refreshed after every successful touch
  const COOLDOWN_MS = 7 * 86400000;
  const { data: lastRows } = await sb.from("api_cache").select("cache_key, payload").like("cache_key", "nudge:last:%");
  const lastTouch = new Map<string, number>(
    (lastRows ?? []).map((r: { cache_key: string; payload: { at?: string } }) =>
      [r.cache_key.slice("nudge:last:".length), Date.parse(r.payload?.at ?? "") || 0]),
  );
  const canTouch = (uid: string) => Date.now() - (lastTouch.get(uid) ?? 0) > COOLDOWN_MS;
  const touched = async (uid: string) => {
    lastTouch.set(uid, Date.now());
    await sb.from("api_cache").upsert({ cache_key: `nudge:last:${uid}`, payload: { at: new Date().toISOString() } });
  };

  const sent: string[] = [], skipped: string[] = [], failed: string[] = [];
  for (const t of targets) {
    if (!canTouch(t.userId)) { skipped.push(`cooldown:${t.kind}:${t.email}`); continue; }
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
    if (ok) { sent.push(`${t.kind}:${channel}:${t.email}`); await touched(t.userId); }
    else {
      failed.push(`${t.kind}:${t.email}`);
      await sb.from("api_cache").delete().eq("cache_key", claimKey); // release for a retry run
    }
  }

  // perfect days: repeatable (each new perfect day can fire), but the claim is per (user, day)
  // so a user with several perfect agents on the same day hears about the biggest batch only
  const { data: pdRows } = await sb.rpc("perfect_day_targets");
  for (const r of (pdRows ?? []) as PerfectRow[]) {
    // no canTouch gate here — congrats are earned and time-sensitive (owner-ruled bypass);
    // the touched() stamp after sending still delays other marketing by a week
    const claimKey = `nudge:perfect:${r.user_id}:${r.day}`;
    const { error: dupe } = await sb.from("api_cache").insert({
      cache_key: claimKey, payload: { email: r.email, agent: r.agent, n: r.n, at: new Date().toISOString() },
    });
    if (dupe) { skipped.push(`perfect:${r.email}`); continue; }

    let ok = false, channel = "email";
    if (hasPush.has(r.user_id) && pushSecret) {
      channel = "push";
      const p = perfectPush(r);
      const resp = await fetch(`${SB_URL}/functions/v1/send-push`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-internal-secret": String(pushSecret) },
        body: JSON.stringify({ user_id: r.user_id, title: p.title, body: p.body, url: p.url, tag: "nudge-perfect" }),
      });
      ok = resp.ok;
    }
    if (!ok) {
      channel = "email";
      const dest = r.plan === "pro_max" ? "/my-record" : "/profile";
      let link = `${SITE}/login`;
      try {
        const { data: lk, error: lkErr } = await sb.auth.admin.generateLink({
          type: "magiclink", email: r.email, options: { redirectTo: `${SITE}${dest}` },
        });
        if (!lkErr && lk?.properties?.action_link) link = lk.properties.action_link;
      } catch { /* plain login link fallback stays */ }
      const msg = perfectEmail(r, link);
      const resp = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${RESEND_KEY}` },
        body: JSON.stringify({ from: FROM, to: r.email, subject: msg.subject, html: msg.html }),
      });
      ok = resp.ok;
    }
    if (ok) { sent.push(`perfect:${channel}:${r.email}`); await touched(r.user_id); }
    else {
      failed.push(`perfect:${r.email}`);
      await sb.from("api_cache").delete().eq("cache_key", claimKey);
    }
  }

  // first wins: once EVER per user; skip anyone a perfect-day already celebrated
  const { data: fwRows } = await sb.rpc("first_win_targets");
  const { data: perfectClaims } = (fwRows?.length)
    ? await sb.from("api_cache").select("cache_key").like("cache_key", "nudge:perfect:%")
    : { data: [] };
  const celebrated = new Set((perfectClaims ?? []).map((r: { cache_key: string }) => r.cache_key.split(":")[2]));
  for (const r of (fwRows ?? []) as { user_id: string; email: string; plan: string; agent: string; game: string; market: string; score: string }[]) {
    if (celebrated.has(r.user_id)) { skipped.push(`first-win:perfect-covered:${r.email}`); continue; }
    const claimKey = `nudge:first-win:${r.user_id}`;
    const { error: dupe } = await sb.from("api_cache").insert({
      cache_key: claimKey, payload: { email: r.email, game: r.game, at: new Date().toISOString() },
    });
    if (dupe) { skipped.push(`first-win:${r.email}`); continue; }

    let ok = false, channel = "email";
    if (hasPush.has(r.user_id) && pushSecret) {
      channel = "push";
      const resp = await fetch(`${SB_URL}/functions/v1/send-push`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-internal-secret": String(pushSecret) },
        body: JSON.stringify({
          user_id: r.user_id,
          title: `🎉 First win: ${r.agent}`,
          body: `${r.game} — ${r.market} ✓ ${r.score}. On the record forever.`,
          url: "/my-record", tag: "nudge-first-win",
        }),
      });
      ok = resp.ok;
    }
    if (!ok) {
      channel = "email";
      let link = `${SITE}/login`;
      try {
        const { data: lk, error: lkErr } = await sb.auth.admin.generateLink({
          type: "magiclink", email: r.email, options: { redirectTo: `${SITE}/my-record` },
        });
        if (!lkErr && lk?.properties?.action_link) link = lk.properties.action_link;
      } catch { /* plain login link stays */ }
      const upsell = r.plan === "free"
        ? para(`And remember — it did that <b style="color:#f3f6f4;">locked as built</b>. <b style="color:#f3f6f4;">Pro (₦500/mo)</b> lets you tune the rule, market and leagues, and run 3 agents at once.`)
        : "";
      const resp = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${RESEND_KEY}` },
        body: JSON.stringify({
          from: FROM, to: r.email,
          subject: `🎉 ${r.agent} just landed its first pick`,
          html: shell(
            para(`<b style="color:#f3f6f4;">${r.agent}</b> just landed its very first graded pick:`) +
            para(`<b style="color:#f3f6f4;">${r.game}</b> — ${r.market} ✓ <b style="color:#f3f6f4;">${r.score}</b>`) +
            para(`That win is on your record now — graded in the open like every Onside pick, and nobody can edit it away.`) +
            upsell +
            button(link, "See my record →")
          ),
        }),
      });
      ok = resp.ok;
    }
    if (ok) { sent.push(`first-win:${channel}:${r.email}`); await touched(r.user_id); }
    else {
      failed.push(`first-win:${r.email}`);
      await sb.from("api_cache").delete().eq("cache_key", claimKey);
    }
  }

  // Telegram-channel invite: linked users get ONE bot DM pointing at @onsideai — ever.
  // Already-members are claimed without a send so they're never checked again.
  const { data: tgRows } = await sb.rpc("telegram_nudge_targets");
  const { data: tgToken } = tgRows?.length ? await sb.rpc("get_secret", { secret_name: "telegram_bot_token" }) : { data: null };
  for (const r of (tgRows ?? []) as { user_id: string; chat_id: number }[]) {
    if (!tgToken) break;
    if (!canTouch(r.user_id)) { skipped.push(`cooldown:tg-channel:${r.chat_id}`); continue; }
    const claimKey = `nudge:tg-channel:${r.user_id}`;
    const { error: dupe } = await sb.from("api_cache").insert({
      cache_key: claimKey, payload: { chat_id: r.chat_id, at: new Date().toISOString() },
    });
    if (dupe) { skipped.push(`tg-channel:${r.chat_id}`); continue; }

    let isMember = false;
    try {
      const chk = await fetch(`https://api.telegram.org/bot${tgToken}/getChatMember`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: "@onsideai", user_id: r.chat_id }),
      });
      const j = await chk.json();
      isMember = chk.ok && ["member", "administrator", "creator"].includes(j?.result?.status);
    } catch { /* treat as not-a-member; the invite is harmless either way */ }
    if (isMember) { skipped.push(`tg-channel:member:${r.chat_id}`); continue; }

    const resp = await fetch(`https://api.telegram.org/bot${tgToken}/sendMessage`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: r.chat_id,
        text: "You get your agent's picks here — but the day's best line-up, results and the running record land on the Onside channel.\n\nJoin: t.me/onsideai\n\nEvery pick graded in the open, misses included.",
        disable_web_page_preview: true,
      }),
    });
    if (resp.ok) { sent.push(`tg-channel:${r.chat_id}`); await touched(r.user_id); }
    else if (resp.status === 403) {
      // the user blocked the bot — permanent; keep the claim so we never retry them
      skipped.push(`tg-channel:blocked:${r.chat_id}`);
    } else {
      failed.push(`tg-channel:${r.chat_id}`);
      await sb.from("api_cache").delete().eq("cache_key", claimKey);
    }
  }

  // ---- one-shot billing rescue (2026-09-02, owner-directed) ----
  // These 12 users reached checkout and typed a REAL card into the test-mode gateway — it can
  // never complete, so they abandoned wanting to pay. Until live billing switches on, the email
  // hands them the access card that unlocks the plan at no charge (the standing conversion
  // play). Hardcoded list on purpose: no request-controlled input, so this can never be turned
  // into a spam vector; once-EVER via the nudge: claim; bypasses the weekly cap like perfect
  // days (it answers the user's own action) but stamps the cooldown after.
  const BILLING_RESCUE: { user_id: string; email: string }[] = [
    { user_id: "edd61211-d0b8-49c7-9a92-4b931a6b4cd1", email: "adegokeluqman997@gmail.com" },
    { user_id: "f5c91648-9fe5-4e28-bf03-a811aef0afb9", email: "ezragamboemmanuel@gmail.com" },
    { user_id: "e0b4380a-f11d-4e4b-8fe3-081dea9e3e1d", email: "iifechukwu655@gmail.com" },
    { user_id: "7b575206-2b50-4544-b21c-cc25c53f129d", email: "naallahmudashir@gmail.com" },
    { user_id: "d1ab7261-70b3-49f8-92e9-e79d124c03da", email: "onyiiemma08@gmail.com" },
    { user_id: "0f4d7bec-9201-449f-b992-d01dae3093f3", email: "philiphassan65@gmail.com" },
    { user_id: "2a29cea7-ad05-4c75-9ce0-791bbf682fa6", email: "sannikb64@gmail.com" },
    { user_id: "5712342d-d5b2-4fd0-a899-a2c0e3c61007", email: "soteemmanuel3@gmail.com" },
    { user_id: "bc2b75d9-570f-4c0d-bb51-b127fcb9ae90", email: "sundaywisdom440@gmail.com" },
    { user_id: "df688463-1f5c-4c27-b106-279d18c535f6", email: "troyberlin62@gmail.com" },
    { user_id: "a6a65791-4cd5-4699-b12b-9e75bd359db9", email: "wamebankchiedupeters@gmail.com" },
    { user_id: "f98284de-8aa0-41f2-ae64-00598f2d6ee9", email: "www.mandynichole21@gmail.com" },
  ];
  const cardBox = `<div style="background:#16211f;border:1px solid #2a3d3a;border-radius:12px;padding:16px 18px;margin:16px 0;">
    <div style="color:#7d8f8a;font-size:11px;text-transform:uppercase;letter-spacing:0.08em;margin-bottom:8px;">Access card — free, no naira moves</div>
    <div style="color:#f3f6f4;font-family:monospace;font-size:16px;letter-spacing:1px;">4084 0840 8408 4081</div>
    <div style="color:#c9d6d2;font-family:monospace;font-size:12.5px;margin-top:6px;">CVV 408 · any future expiry · PIN 0000 · OTP 123456</div>
  </div>`;
  for (const r of BILLING_RESCUE) {
    // still on free? a user who since got a plan another way needs nothing
    const { data: prof } = await sb.from("profiles").select("plan").eq("id", r.user_id).maybeSingle();
    if (prof?.plan && prof.plan !== "free") { skipped.push(`billing:already-paid:${r.email}`); continue; }
    const claimKey = `nudge:billing:${r.user_id}`;
    const { error: dupe } = await sb.from("api_cache").insert({
      cache_key: claimKey, payload: { email: r.email, at: new Date().toISOString() },
    });
    if (dupe) { skipped.push(`billing:${r.email}`); continue; }

    let link = `${SITE}/login`;
    try {
      const { data: lk, error: lkErr } = await sb.auth.admin.generateLink({
        type: "magiclink", email: r.email, options: { redirectTo: `${SITE}/profile` },
      });
      if (!lkErr && lk?.properties?.action_link) link = lk.properties.action_link;
    } catch { /* plain login link fallback stays */ }
    const resp = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${RESEND_KEY}` },
      body: JSON.stringify({
        from: FROM, to: r.email,
        subject: "Your Onside upgrade didn't go through — that was us, not your bank",
        html: shell(
          para("You tried to upgrade on Onside and the payment wouldn't complete. Nothing was wrong with your card — <b style=\"color:#f3f6f4;\">that was on us</b>.") +
          para("Billing is still in its free early-access phase, so the checkout only accepts a special access card — real cards hit a wall we should have caught. Sorry you ran into it.") +
          para("Until live billing launches, this card unlocks your plan <b style=\"color:#f3f6f4;\">at no charge</b>:") +
          cardBox +
          para("Pick your plan, enter the card exactly as above, and you're in. When real payments switch on, nothing gets charged without asking you properly first.") +
          button(link, "Unlock my plan →")
        ),
      }),
    });
    if (resp.ok) { sent.push(`billing:email:${r.email}`); await touched(r.user_id); }
    else {
      failed.push(`billing:${r.email}`);
      await sb.from("api_cache").delete().eq("cache_key", claimKey); // release for a retry run
    }
  }

  return Response.json({ candidates: targets.length + (pdRows?.length ?? 0) + (tgRows?.length ?? 0), sent, skipped, failed });
});
