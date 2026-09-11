// daily-digest: the once-a-day habit anchor. Every morning @OnsideAIbot DMs each Telegram-linked
// user a personal card — today's agent picks + yesterday's result — so the reason to come back is
// "my agent worked while I was away". Fired by pg_cron via invoke_daily_digest() at 07:00 UTC
// (08:00 Lagos), after the morning agent runs have delivered. Idempotent per Lagos day (digest_runs).
//
// Three shapes, by what the user actually has today:
//   A. has picks today            -> today's slip (top 3) + yesterday's W/L
//   B. has an agent, none today   -> yesterday's W/L (if any) + the free banker of the day
//   C. no picks at all            -> free banker of the day + a build-an-agent nudge
//
// Body: { dry?: true, to?: "owner", force?: true }. dry = build + return a sample, send nothing.
import { createClient } from "npm:@supabase/supabase-js@2";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_KEY = Deno.env.get("SUPABASE_SECRET_KEY") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const sb = createClient(SB_URL, SB_KEY);
const SITE = "https://onside.com.ng";
const OWNER = "91a63237-6a50-41bc-950d-7954450e3046";

async function getSecret(name: string): Promise<string | null> {
  try { const { data } = await sb.rpc("get_secret", { secret_name: name }); return (data as string) ?? null; } catch { return null; }
}
async function sendTelegram(chatId: number, text: string): Promise<boolean> {
  const token = await getSecret("telegram_bot_token");
  if (!token) return false;
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
    });
    const j = await res.json();
    return j?.ok === true;
  } catch { return false; }
}

// Lagos (UTC+1, no DST) day boundaries as real UTC Date objects.
const LAGOS_MS = 60 * 60 * 1000;
function lagosMidnightUTC(daysAgo = 0): Date {
  const l = new Date(Date.now() + LAGOS_MS);
  const ms = Date.UTC(l.getUTCFullYear(), l.getUTCMonth(), l.getUTCDate() - daysAgo, 0, 0, 0);
  return new Date(ms - LAGOS_MS);
}
function lagosDayKey(): string {
  const l = new Date(Date.now() + LAGOS_MS);
  return `${l.getUTCFullYear()}-${String(l.getUTCMonth() + 1).padStart(2, "0")}-${String(l.getUTCDate()).padStart(2, "0")}`;
}
const pct = (p: number | null | undefined) => (p != null ? `${Math.round(p * 100)}%` : "");
const fxName = (f: any) => (f ? `${f.home_team} v ${f.away_team}` : "your pick");
const koTime = (iso: string) => new Date(iso).toLocaleString("en-GB", { timeZone: "Africa/Lagos", weekday: "short", hour: "2-digit", minute: "2-digit" });

Deno.serve(async (req) => {
  const J = (o: any) => new Response(JSON.stringify(o), { status: 200, headers: { "content-type": "application/json" } });
  let dry = false, toOwner = false, force = false;
  try { const b = await req.json(); dry = b?.dry === true; toOwner = b?.to === "owner"; force = b?.force === true; } catch { /* cron: empty body */ }

  const todayStart = lagosMidnightUTC(0).toISOString();
  const ydayStart = lagosMidnightUTC(1).toISOString();
  const todayEnd = lagosMidnightUTC(-1).toISOString(); // end of today Lagos

  // idempotency: one live send per Lagos day. dry/owner-test/force bypass the guard.
  if (!dry && !toOwner && !force) {
    const { data: claimed } = await sb.from("digest_runs")
      .upsert({ day: lagosDayKey() }, { onConflict: "day", ignoreDuplicates: true }).select();
    if (!claimed || !claimed.length) return J({ status: "skipped", reason: "already sent today", day: lagosDayKey() });
  }

  // recipients: Telegram-linked, digest not disabled
  let rq = sb.from("profiles").select("id, telegram_chat_id, display_name").not("telegram_chat_id", "is", null).neq("daily_digest", false);
  if (toOwner) rq = rq.eq("id", OWNER);
  const { data: users } = await rq;
  if (!users || !users.length) return J({ status: "no_recipients", dry });
  const ids = users.map((u: any) => u.id);

  // today's pending picks (all recipients, one query) — with fixture for the top blocks
  const { data: todayPicks } = await sb.from("deliveries")
    .select("user_id, market_label, market_key, model_prob, tier, fixtures(home_team, away_team, kickoff_utc, leagues(name))")
    .in("user_id", ids).eq("result", "pending").gte("delivered_at", todayStart)
    .order("model_prob", { ascending: false });
  const byUserToday = new Map<string, any[]>();
  for (const r of todayPicks ?? []) (byUserToday.get(r.user_id) ?? byUserToday.set(r.user_id, []).get(r.user_id)!).push(r);

  // yesterday's graded card per user (won/lost on picks delivered yesterday Lagos)
  const { data: yRows } = await sb.from("deliveries")
    .select("user_id, result").in("user_id", ids).in("result", ["won", "lost"])
    .gte("delivered_at", ydayStart).lt("delivered_at", todayStart);
  const byUserYday = new Map<string, { w: number; t: number }>();
  for (const r of yRows ?? []) {
    const b = byUserYday.get(r.user_id) ?? { w: 0, t: 0 };
    b.t++; if (r.result === "won") b.w++;
    byUserYday.set(r.user_id, b);
  }

  // which recipients own at least one agent (case B vs C)
  const { data: agentOwners } = await sb.from("strategies").select("user_id").in("user_id", ids);
  const hasAgent = new Set((agentOwners ?? []).map((r: any) => r.user_id));

  // the free banker of the day: highest-confidence pending pick kicking off today in a tier league
  const { data: bankerRows } = await sb.from("deliveries")
    .select("market_label, model_prob, fixtures!inner(home_team, away_team, kickoff_utc, leagues!inner(name, tier))")
    .eq("result", "pending").gte("delivered_at", todayStart)
    .not("model_prob", "is", null).order("model_prob", { ascending: false }).limit(50);
  const bankerRow = (bankerRows ?? []).find((r: any) => {
    const lg = r.fixtures?.leagues; const tier = Array.isArray(lg) ? lg[0]?.tier : lg?.tier;
    const ko = r.fixtures?.kickoff_utc;
    return tier != null && ko && ko >= todayStart && ko < todayEnd;
  });
  const bankerLine = bankerRow
    ? `🔒 Free banker today: ${fxName(bankerRow.fixtures)} · ${bankerRow.market_label} (${pct(bankerRow.model_prob)})`
    : null;

  const FOOT = `\n\n18+ · bet responsibly. Reply /stop to pause these.`;
  const yLine = (y?: { w: number; t: number }) =>
    y && y.t ? `Yesterday: ${y.w}/${y.t} landed ${y.w === y.t ? "✅" : y.w >= y.t / 2 ? "👍" : "💪"}` : null;

  function buildMessage(u: any): string | null {
    const picks = byUserToday.get(u.id) ?? [];
    const y = byUserYday.get(u.id);
    const hi = "☀️ Morning" + (u.display_name ? ` ${String(u.display_name).split(" ")[0]}` : "") + "!";
    // A) has picks today
    if (picks.length) {
      const top = picks.slice(0, 3).map((p: any) => {
        const lg = p.fixtures?.leagues; const lname = Array.isArray(lg) ? lg[0]?.name : lg?.name;
        const ko = p.fixtures?.kickoff_utc ? ` · ${koTime(p.fixtures.kickoff_utc)}` : "";
        return `• ${fxName(p.fixtures)}${lname ? ` (${lname})` : ""}${ko}\n  → ${p.market_label} (${pct(p.model_prob)})`;
      }).join("\n");
      const more = picks.length > 3 ? `\n…and ${picks.length - 3} more` : "";
      const yl = yLine(y);
      return `${hi} Your agents found ${picks.length} game${picks.length === 1 ? "" : "s"} today.\n\n${top}${more}` +
        `${yl ? `\n\n${yl}` : ""}\n\nSee your full slip → ${SITE}/agent${FOOT}`;
    }
    // B) has an agent, nothing cleared today
    if (hasAgent.has(u.id)) {
      const yl = yLine(y);
      return `${hi}${yl ? ` ${yl}.` : ""} No games cleared your agents' rules for today yet — I'd rather send nothing than a weak pick, and I'll keep scanning.` +
        `${bankerLine ? `\n\n${bankerLine}` : ""}\n\nOpen Onside → ${SITE}/agent${FOOT}`;
    }
    // C) no agent yet — value + activation nudge
    return `${hi} Here's a pick the engine likes today:` +
      `${bankerLine ? `\n\n${bankerLine}` : "\n\nNo standout banker today — check the feed."}` +
      `\n\nYour own AI agent can hunt these for you every day — build one in a minute → ${SITE}${FOOT}`;
  }

  if (dry) {
    const sample = users.slice(0, 3).map((u: any) => ({ user: u.display_name ?? u.id, msg: buildMessage(u) }));
    return J({ status: "dry", recipients: users.length, banker: bankerLine, sample });
  }

  let sent = 0;
  for (const u of users) {
    const msg = buildMessage(u);
    if (!msg || !u.telegram_chat_id) continue;
    if (await sendTelegram(u.telegram_chat_id, msg)) sent++;
  }
  if (!toOwner && !force) await sb.from("digest_runs").update({ sent, ran_at: new Date().toISOString() }).eq("day", lagosDayKey());
  return J({ status: "sent", sent, recipients: users.length, day: lagosDayKey() });
});
