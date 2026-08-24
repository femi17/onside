// community-broadcast: Claude-authored posts to the public @onsideai Telegram channel — 2x/day
// since 2026-08-24 (morning_slate + results_recap; the other slots remain manually invocable).
// Fired by pg_cron via invoke_community_broadcast(slot). Each slot builds a data brief, Claude drafts
// the copy under strict guardrails, a banned-phrase filter runs, a responsible-gambling footer is
// appended, then it auto-posts. Every attempt is logged to channel_posts.
// The BODY is written to be cross-platform: the owner copy-pastes it verbatim to X, Facebook and
// Instagram, so it must carry no Telegram references and no links (the X domain flag also makes
// link-free bodies the safe default there). The Telegram-only footer is appended at send time.
// Voice is Naija (Nigerian Pidgin, pidgin-forward) — see SYSTEM. The BANNED filter covers both
// English AND pidgin "certainty" phrasing so the no-guaranteed-win rule holds in either register.
import { createClient } from "npm:@supabase/supabase-js@2";

const SB_KEY = Deno.env.get("SUPABASE_SECRET_KEY") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const sb = createClient(Deno.env.get("SUPABASE_URL")!, SB_KEY);
const CHANNEL = "@onsideai";
const MODEL = "claude-haiku-4-5";

async function getSecret(name: string): Promise<string | null> {
  const { data } = await sb.rpc("get_secret", { secret_name: name });
  return (data as string) ?? null;
}
async function anthropicKey(): Promise<string> {
  return Deno.env.get("ANTHROPIC_API_KEY") ?? Deno.env.get("anthropic_api_key") ?? (await getSecret("anthropic_api_key")) ?? "";
}
async function tg(method: string, body: unknown): Promise<any> {
  const token = await getSecret("telegram_bot_token");
  if (!token) return { ok: false, error: "no token" };
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  return await res.json();
}

// Blocks any language implying a certain outcome — English and Naija/pidgin both. If a draft trips
// this, draft() is retried once with a stronger warning, then blocked if it still matches.
const BANNED = /\b(guarantee(d|s)?|sure[- ]?(win|bet|thing|banker)|guaranteed profit|100%|can'?t lose|cannot lose|risk[- ]?free|no risk|fixed match|fixed game|confirm win|must win|must enter|surely win|no fit lose)\b/i;
const FOOTER = "\n\n———\n📲 Build your own AI betting agent → @OnsideAIbot\n18+ · Bet responsibly · Not financial advice";

const SYSTEM = `You are the voice of Onside — an AI football-betting assistant where users build "agents" that scan matches for value bets and deliver picks. You write short, punchy posts for the public Telegram channel to grow the audience.

VOICE — Naija all the way:
- Write in Nigerian Pidgin: street-smart and full of energy, like sharp football banter with your guys. Pidgin leads; drop in a little plain English only where it helps understanding. Keep it readable across West Africa (Naija, Ghana…).
- Punchy and football-savvy. Light, tasteful emoji (⚽📈🔥👀) — no hashtag spam, no long epistle.
- Give it room to breathe: break the post into short chunks of 1-2 sentences, with a BLANK LINE between each beat (open with a hook line, then the point, then the nudge). Never one dense block of text — it must be easy to scan on a phone.
- Naija flavour is welcome: "oya", "sabi", "wetin", "no be small thing", "make we", "steady", "with sense", "gbam" (as slang, never as a promise). Keep it clean and inclusive — NO tribal, political, religious or vulgar talk.

CROSS-PLATFORM (the same text is reposted verbatim to X, Facebook and Instagram):
- Never mention Telegram, "this channel", any bot, or platform features — the words must read naturally anywhere.
- Open with a hook line that STANDS ALONE as a tweet (under 200 characters): someone who reads only that first beat gets the full point. The beats after it deepen, never rescue, the hook.
- Say "Onside" by name when nudging — never a handle, never a URL (links and handles are appended per-platform).

HARD RULES (compliance — never break these):
- ONLY use the facts in the brief. Never invent teams, stats, prices or results. If the brief is thin, stay general and educational.
- NEVER promise or imply winning. Do not say guaranteed, sure win, 100%, "e must enter", "confirm win", "sure banker", "e go surely win", can't lose, risk-free or fixed. Frame everything as value, edge and probability — never certainty. Anybody wey dey bet fit lose.
- Under 550 characters. No markdown headers, no links, no disclaimer — those are appended automatically.
- When it fits, gently nudge readers to build their own agent.
Return ONLY the post text.`;

const CONCEPTS = [
  "Expected value: a bet has value only when your estimated win chance beats the odds' implied chance.",
  "Implied probability = 1 / decimal odds. Odds of 2.00 imply a 50% chance.",
  "The overround: bookies price both sides above 100%. That margin is their edge — beating it is the whole game.",
  "Edge = your model's probability minus the market's fair probability. Small, repeatable edges compound.",
  "Over/Under 2.5 is about total goals in the match, not who wins.",
  "BTTS ignores the result — only whether both teams score.",
  "Asian handicap removes the draw by giving one side a goal head-start.",
  "Bankroll discipline: staking a fixed small % survives variance far better than chasing losses.",
  "Form is a hint, not destiny — last-5 results are a tiny sample.",
  "Home advantage is real but shrinking — worth less than a decade ago.",
  "Double chance trades a shorter price for covering two of three outcomes.",
  "Draw No Bet refunds your stake if it ends level — insurance against the draw.",
  "Closing line value: if the price shortens after you bet, you probably found value.",
  "Accumulators multiply the odds and the risk — one leg sinks the whole slip.",
];

function pct(n: number): string { return `${(n * 100).toFixed(0)}%`; }
function fxName(f: any): string { return f ? `${f.home_team} v ${f.away_team}` : ""; }
function league(f: any): string { const l = f?.leagues; return (Array.isArray(l) ? l[0]?.name : l?.name) ?? ""; }
function dedupeByFixture<T extends { fixtures?: any }>(rows: T[]): T[] {
  const seen = new Set<string>(); const out: T[] = [];
  for (const r of rows) { const k = fxName(r.fixtures); if (!k || seen.has(k)) continue; seen.add(k); out.push(r); }
  return out;
}

async function buildBrief(slot: string): Promise<{ theme: string; facts: string; instruction: string }> {
  const now = new Date();
  const startOfDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
  const dayIdx = Math.floor(Date.parse(startOfDay) / 86400000);
  const evergreen = () => ({ theme: "education", facts: CONCEPTS[dayIdx % CONCEPTS.length], instruction: "Turn this one betting concept into a crisp, useful mini-lesson that makes a casual bettor feel sharper. 2-4 sentences." });

  if (slot === "education") return evergreen();

  if (slot === "top_picks" || slot === "morning_slate" || slot === "kickoff_buzz") {
    const { data } = await sb.from("deliveries")
      .select("edge, market_label, bet_value, market_key, fixtures(home_team, away_team, kickoff_utc, status, leagues(name))")
      .gte("delivered_at", startOfDay).order("edge", { ascending: false }).limit(60);
    let rows = dedupeByFixture((data ?? []) as any[]).filter((r) => r.fixtures);

    if (slot === "kickoff_buzz") {
      const soon = now.getTime() + 5 * 3600 * 1000;
      rows = rows.filter((r) => { const k = Date.parse(r.fixtures.kickoff_utc); return k > now.getTime() && k < soon; });
    } else if (slot === "morning_slate") {
      rows = rows.filter((r) => Date.parse(r.fixtures.kickoff_utc) > now.getTime());
    }
    if (rows.length === 0) return evergreen();
    const top = rows.slice(0, 5);
    const lines = top.map((r) => `- ${fxName(r.fixtures)}${league(r.fixtures) ? ` (${league(r.fixtures)})` : ""}: ${r.market_label ?? r.market_key}${r.bet_value ? ` ${r.bet_value}` : ""} — edge ${pct(Number(r.edge))}`).join("\n");
    const facts = `Onside agents flagged ${rows.length} value spot(s) today. Highlights:\n${lines}`;
    const instruction = slot === "morning_slate"
      ? "Write a morning post hyping the day ahead — mention 2-3 of the standout fixtures and that agents are scanning for value. Don't tip a certainty."
      : slot === "kickoff_buzz"
      ? "Write a 'kicking off soon' post spotlighting 2-3 of these games and the value angle agents flagged."
      : "Write a 'top value picks today' post. Present 3-4 of these as value spots (edge = model vs market), not locks.";
    return { theme: slot, facts, instruction };
  }

  if (slot === "results_recap") {
    const since = new Date(now.getTime() - 24 * 3600 * 1000).toISOString();
    const { data } = await sb.from("deliveries")
      .select("result, edge, market_label, bet_value, market_key, fixtures(home_team, away_team, ft_home, ft_away, leagues(name))")
      .gte("settled_at", since).in("result", ["won", "lost"]).limit(800);
    const rows = (data ?? []) as any[];
    if (rows.length === 0) return evergreen();
    const won = rows.filter((r) => r.result === "won").length;
    const hit = won / rows.length;
    const notable = rows.filter((r) => r.result === "won").sort((a, b) => Number(b.edge) - Number(a.edge)).slice(0, 3)
      .map((r) => `- ${fxName(r.fixtures)}: ${r.market_label ?? r.market_key}${r.bet_value ? ` ${r.bet_value}` : ""} ✅${r.fixtures?.ft_home != null ? ` (${r.fixtures.ft_home}-${r.fixtures.ft_away})` : ""}`).join("\n");
    const facts = `Last 24h: ${rows.length} agent picks settled, ${won} landed (${pct(hit)} hit rate).${notable ? `\nStandout wins:\n${notable}` : ""}`;
    return { theme: "results_recap", facts, instruction: "Write an honest results recap. Celebrate the wins and the hit rate without spinning it as guaranteed. Keep it credible." };
  }

  if (slot === "community_spotlight") {
    const { data } = await sb.from("community_agent_stats").select("handle, agent_name, edge, sample_size").order("edge", { ascending: false }).limit(5);
    const rows = (data ?? []) as any[];
    if (rows.length === 0) {
      return { theme: "community_spotlight", facts: "Onside members build custom AI agents that scan matches on their own rules and share results in the community. The public leaderboard ranks members by their edge vs the market.", instruction: "Write an inviting post encouraging people to join Onside, build an agent, and climb the community leaderboard. No fake numbers." };
    }
    const lines = rows.map((r, i) => `${i + 1}. @${r.handle} · ${r.agent_name} — +${pct(Number(r.edge))} edge (${r.sample_size} picks)`).join("\n");
    return { theme: "community_spotlight", facts: `Top members on the Onside leaderboard (edge vs market):\n${lines}`, instruction: "Write a leaderboard spotlight celebrating these members and inviting others to build an agent and climb." };
  }

  return evergreen();
}

async function draft(instruction: string, facts: string): Promise<string> {
  const key = await anthropicKey();
  if (!key) throw new Error("no anthropic key");
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: MODEL, max_tokens: 400, system: SYSTEM, messages: [{ role: "user", content: `${instruction}\n\nFACTS:\n${facts}` }] }),
  });
  const j = await res.json();
  return ((j?.content ?? []) as any[]).filter((b) => b.type === "text").map((b) => b.text).join("").trim();
}

Deno.serve(async (req) => {
  let slot = "education";
  try { const b = await req.json(); if (b?.slot) slot = String(b.slot); } catch { /* default */ }

  let theme = slot; let body = "";
  try {
    const brief = await buildBrief(slot);
    theme = brief.theme;
    body = await draft(brief.instruction, brief.facts);
    if (BANNED.test(body)) {
      body = await draft(brief.instruction + " IMPORTANT: do not use any language implying a guaranteed or certain outcome.", brief.facts);
    }
    if (!body || BANNED.test(body)) {
      await sb.from("channel_posts").insert({ slot, theme, body, status: "blocked", meta: { reason: "empty or banned after retry" } });
      return new Response(JSON.stringify({ status: "blocked" }), { status: 200, headers: { "content-type": "application/json" } });
    }
  } catch (e) {
    await sb.from("channel_posts").insert({ slot, theme, status: "failed", meta: { error: String(e) } });
    return new Response(JSON.stringify({ status: "failed", error: String(e) }), { status: 200, headers: { "content-type": "application/json" } });
  }

  const text = body.slice(0, 900) + FOOTER;
  const sent = await tg("sendMessage", { chat_id: CHANNEL, text, disable_web_page_preview: true });
  const ok = sent?.ok === true;
  await sb.from("channel_posts").insert({
    slot, theme, body: text,
    telegram_message_id: ok ? sent.result?.message_id : null,
    status: ok ? "posted" : "failed",
    meta: ok ? null : { telegram: sent },
  });
  return new Response(JSON.stringify({ status: ok ? "posted" : "failed", slot, theme }), { status: 200, headers: { "content-type": "application/json" } });
});
