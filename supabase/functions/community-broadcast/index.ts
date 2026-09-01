// community-broadcast: Claude-authored posts to the public @onsideai Telegram channel — 3x/day
// since 2026-08-26: morning_slate (the day ahead), perfect_agent (afternoon — see below),
// results_recap (night). Other slots remain manually invocable.
// The afternoon slot is perfect_agent: if an agent swept its WHOLE card yesterday (Lagos) it
// posts that "perfect agent day" flyer image to the channel; on days with no sweep it falls back
// to the product_gap text lesson (adoption-driven — the old afternoon behaviour, unchanged).
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
const SITE = "https://onside.com.ng"; // the flyer OG route lives here (same host daily-flyer uses)

// Anthropic spend attribution: each Claude call logs its token usage tagged with the feature
// it served; /analytics prices the tokens per model. Metering must never break the feature.
async function logLLM(purpose: string, model: string, u: any): Promise<void> {
  if (!u) return;
  try {
    await sb.from("llm_usage").insert({
      purpose, model,
      input_tokens: u.input_tokens ?? 0,
      output_tokens: u.output_tokens ?? 0,
      cache_read_tokens: u.cache_read_input_tokens ?? 0,
      cache_creation_tokens: u.cache_creation_input_tokens ?? 0,
    });
  } catch { /* best-effort */ }
}

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

  if (slot === "product_gap") {
    // The calculated slot: measure what users are actually (not) doing on the platform and
    // teach the weakest habit. Adoption numbers steer the CHOICE only — they never appear
    // in the post (publishing low adoption reads as weakness). Rotation: skip topics covered
    // in the last 4 gap posts so the channel doesn't nag about the same thing.
    const [{ count: onboarded }, pushRows, { count: agentsTotal }, { count: agentsRuled }, slipRows, { count: joined }, { data: recentRows }] = await Promise.all([
      sb.from("profiles").select("id", { count: "exact", head: true }).eq("onboarded", true),
      sb.from("push_subscriptions").select("user_id").limit(10000),
      sb.from("strategies").select("id", { count: "exact", head: true }),
      sb.from("strategies").select("id", { count: "exact", head: true }).not("rule_text", "is", null).neq("rule_text", ""),
      sb.from("screenshot_imports").select("user_id").limit(10000),
      sb.from("profiles").select("id", { count: "exact", head: true }).not("handle", "is", null),
      sb.from("channel_posts").select("theme").eq("slot", "product_gap").eq("status", "posted").order("created_at", { ascending: false }).limit(4),
    ]);
    const denom = Math.max(1, onboarded ?? 1);
    const pushUsers = new Set((pushRows.data ?? []).map((r: { user_id: string }) => r.user_id)).size;
    const slipUsers = new Set((slipRows.data ?? []).map((r: { user_id: string }) => r.user_id)).size;
    const pushRate = pushUsers / denom;

    const topics = [
      {
        key: "pwa_install",
        adoption: pushRate, // installs aren't tracked directly; push opt-in is the closest proxy
        facts: "Onside installs on your phone like a real app — no app store. Android/Chrome: open Onside in the browser, tap the browser menu, choose 'Add to Home Screen'. iPhone/Safari: tap Share, then 'Add to Home Screen'. After that it opens full-screen from its own icon, one tap.",
        instruction: "Teach readers to install Onside on their phone home screen using exactly these steps. Frame it as the one-minute upgrade that makes the tracker feel like a real app.",
      },
      {
        key: "push_on",
        adoption: pushRate,
        facts: "Onside can push alerts: goals on games you track, the verdict the moment your pick lands or misses, and your agent's fresh picks. Turn it on inside Onside: Profile → Notifications → allow.",
        instruction: "Convince readers to switch notifications on so they never follow a tracked game blind. Use the steps exactly as given.",
      },
      {
        key: "agent_rules",
        adoption: (agentsRuled ?? 0) / Math.max(1, agentsTotal ?? 1),
        facts: "An Onside agent takes its rule in plain English — examples that work well: 'only home teams with strong last-5 form', 'skip cup games', 'only overs when both teams score freely'. One clear condition beats five vague ones. The engine reads the rule and applies it to every day's hunt.",
        instruction: "Teach how to write a sharp agent rule, quoting 1-2 of the example rules verbatim. Position rule-writing as the skill that separates a decent agent from a great one.",
      },
      {
        key: "slip_upload",
        adoption: slipUsers / denom,
        facts: "Any betslip screenshot works on Onside: tap Add, upload the screenshot, and every leg starts tracking itself live — goals, corners, cards — settled exactly how the bookie settles. No typing.",
        instruction: "Show how effortless slip tracking is — screenshot in, every leg live. Aim at people still checking results one app at a time.",
      },
      {
        key: "community",
        adoption: (joined ?? 0) / denom,
        facts: "Onside has a community feed: share a slip, see the agents other people built, talk tactics, and — if you opt in — climb a leaderboard ranked by real graded results, misses included.",
        instruction: "Invite readers into the community side of Onside — the feed and the opt-in leaderboard where only real graded results decide the ranking.",
      },
    ];
    const recent = new Set((recentRows ?? []).map((r: { theme: string }) => r.theme.replace(/^gap:/, "")));
    const pool = topics.filter((t) => !recent.has(t.key));
    const pick = (pool.length ? pool : topics).sort((a, b) => a.adoption - b.adoption)[0];
    return { theme: `gap:${pick.key}`, facts: pick.facts, instruction: pick.instruction };
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

// Posts go out as plain text (no parse_mode) — markdown tokens would render literally.
const stripMd = (s: string) => s.replace(/\*\*|__|^#+\s*/gm, "");

async function draft(instruction: string, facts: string): Promise<string> {
  const key = await anthropicKey();
  if (!key) throw new Error("no anthropic key");
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: MODEL, max_tokens: 400, system: SYSTEM, messages: [{ role: "user", content: `${instruction}\n\nFACTS:\n${facts}` }] }),
  });
  const j = await res.json();
  await logLLM("social_post", MODEL, j?.usage);
  return stripMd(((j?.content ?? []) as any[]).filter((b) => b.type === "text").map((b) => b.text).join("").trim());
}

// Lagos (UTC+1, no DST) calendar date for "yesterday" — the day the afternoon card celebrates.
function lagosYesterdayKey(): string {
  const lagosNow = new Date(Date.now() + 3600_000);
  const y = new Date(lagosNow); y.setUTCDate(y.getUTCDate() - 1);
  return y.toISOString().slice(0, 10);
}

// The perfect-agent sweep for Lagos-yesterday, if any agent went a full card (n>=3, all won).
// Mirrors the day the /flyer/results OG route renders, so the attached image matches these legs.
async function yesterdaySweep(): Promise<{ n: number; legs: any[] } | null> {
  const { data } = await sb.rpc("public_record");
  const rec = data as { perfect_details?: { day: string; sweeps: { n: number; legs: any[] }[] }[] } | null;
  const entry = (rec?.perfect_details ?? []).find((p) => p.day === lagosYesterdayKey());
  const sweep = entry?.sweeps?.[0];
  if (!sweep || !(sweep.n >= 3) || !(sweep.legs?.length)) return null;
  return { n: sweep.n, legs: sweep.legs };
}

// All the sweeps for Lagos-yesterday (not just the first) — the morning carousel posts one
// target-hit flyer per agent that swept its full card.
async function yesterdaySweeps(): Promise<{ n: number; legs: any[] }[]> {
  const { data } = await sb.rpc("public_record");
  const rec = data as { perfect_details?: { day: string; sweeps: { n: number; legs: any[] }[] }[] } | null;
  const entry = (rec?.perfect_details ?? []).find((p) => p.day === lagosYesterdayKey());
  return (entry?.sweeps ?? []).filter((s) => s.n >= 3 && s.legs?.length);
}

// The morning-slot footer carries the receipts link — this post's whole job is proof + door.
const RECORD_FOOTER = "\n\n———\n📊 Every pick, graded in public → onside.com.ng/record\n📲 Build your own AI agent → @OnsideAIbot\n18+ · Bet responsibly";

// DM preview: {to:"owner"} sends the composed post to the linked admin chat(s) instead of the
// channel — the owner forwards it to WhatsApp status / IG / X. No channel_posts log, so DM
// previews never advance the rotation or pollute the channel history.
async function adminChatIds(): Promise<number[]> {
  const { data } = await sb.from("profiles").select("telegram_chat_id").eq("is_admin", true).not("telegram_chat_id", "is", null);
  return (data ?? []).map((p: { telegram_chat_id: number }) => Number(p.telegram_chat_id));
}

// Morning slot: flyer post about the agents that HIT their target yesterday. One flyer per
// sweeping agent, sent as an album (carousel) when there's more than one so the channel scrolls
// through the receipts. No sweep yesterday → the day-record flyer with an honest caption, so the
// morning is ALWAYS a visual post.
async function agentHitsPost(dry: boolean, dmChats: number[] | null = null): Promise<Response> {
  const sweeps = await yesterdaySweeps();
  const stamp = Date.now();
  const photos = sweeps.length
    ? sweeps.slice(0, 5).map((_, i) => `${SITE}/flyer/results?size=feed&sweep=${i}&d=${stamp}`)
    : [`${SITE}/flyer/results?size=feed&d=${stamp}`];

  let facts: string, instruction: string;
  if (sweeps.length) {
    const cards = sweeps.slice(0, 5).map((s, i) => `Agent ${i + 1}: ${s.n}/${s.n} — ${s.legs.slice(0, 3).map((l: any) => `${l.home} v ${l.away} (${l.market}${l.score ? `, ${l.score}` : ""})`).join("; ")}${s.legs.length > 3 ? " …" : ""}`).join("\n");
    facts = `${sweeps.length} Onside agent${sweeps.length > 1 ? "s" : ""} hit ${sweeps.length > 1 ? "their" : "its"} FULL target yesterday — every pick on the card landed:\n${cards}\nThe flyer image(s) attached show each full card. The public record page shows every pick ever, wins and misses.`;
    instruction = `Write a VERY short caption for ${sweeps.length > 1 ? "a carousel of flyer images, one per agent that swept its full card" : "a flyer image of an agent that swept its full card"} yesterday — the images carry the details, the caption only sparks the scroll. HARD LIMIT: under 280 characters total, 2-3 beats of ONE short sentence each. Celebrate the target hit (variance, never certainty) and nudge building your own agent.`;
  } else {
    facts = "No agent swept a full card yesterday. The attached flyer shows yesterday's honest day record (wins and losses) from the public record, which anyone can check.";
    instruction = "Write a VERY short caption for yesterday's record flyer — under 280 characters, 2-3 one-sentence beats. Honest tone: some days agents eat, some days the market wins — the record stays public. Nudge building your own agent.";
  }

  let body = "";
  try {
    body = await draft(instruction, facts);
    if (BANNED.test(body)) body = await draft(instruction + " IMPORTANT: do not use any language implying a guaranteed or certain outcome.", facts);
  } catch { /* static fallback below */ }
  if (!body || BANNED.test(body)) {
    body = sweeps.length
      ? `🎯 ${sweeps.length > 1 ? `${sweeps.length} agents` : "One agent"} hit ${sweeps.length > 1 ? "their" : "its"} FULL target yesterday — every pick landed.\n\nNo be magic, na value hunting. And the record dey public — check am yourself.\n\nOya build your own agent make e hunt for you.`
      : `Yesterday's card — wins and misses, all on the board. 📊\n\nSome days agents eat, some days market collect. We no dey hide any result.\n\nCheck the record, then build your own agent.`;
  }
  const caption = body.slice(0, 850) + RECORD_FOOTER;

  if (dry) {
    return new Response(JSON.stringify({ status: "dry", slot: "agent_hits", sweeps: sweeps.length, photos, caption }), { status: 200, headers: { "content-type": "application/json" } });
  }

  if (dmChats && dmChats.length) {
    const results = [];
    for (const chat of dmChats) {
      const r = photos.length > 1
        ? await tg("sendMediaGroup", { chat_id: chat, media: photos.map((p, i) => ({ type: "photo", media: p, ...(i === 0 ? { caption } : {}) })) })
        : await tg("sendPhoto", { chat_id: chat, photo: photos[0], caption });
      results.push(r?.ok === true);
    }
    return new Response(JSON.stringify({ status: "dm_sent", slot: "agent_hits", sweeps: sweeps.length, chats: results }), { status: 200, headers: { "content-type": "application/json" } });
  }

  let sent: any;
  if (photos.length > 1) {
    // Telegram album = the carousel; caption rides on the FIRST photo only
    sent = await tg("sendMediaGroup", { chat_id: CHANNEL, media: photos.map((p, i) => ({ type: "photo", media: p, ...(i === 0 ? { caption } : {}) })) });
  } else {
    sent = await tg("sendPhoto", { chat_id: CHANNEL, photo: photos[0], caption });
  }
  const ok = sent?.ok === true;
  await sb.from("channel_posts").insert({
    slot: "agent_hits", theme: sweeps.length ? "agent_hits" : "agent_hits_fallback", body: caption,
    telegram_message_id: ok ? (Array.isArray(sent.result) ? sent.result[0]?.message_id : sent.result?.message_id) : null,
    status: ok ? "posted" : "failed",
    meta: ok ? { photos, sweeps: sweeps.length } : { photos, sweeps: sweeps.length, telegram: sent },
  });
  return new Response(JSON.stringify({ status: ok ? "posted" : "failed", slot: "agent_hits", sweeps: sweeps.length, photos: photos.length }), { status: 200, headers: { "content-type": "application/json" } });
}

// Night slot: one short, human rule tip — "you want a rule for X? try this" — rotating across
// the glossary's market families so the channel never repeats itself back-to-back. Every example
// rule is phrased so the agent rule engine can actually parse it (form / blends / h2h / score
// probability / corner averages), so a reader who copies it verbatim gets a working agent.
const RULE_TIPS: { key: string; name: string; stat: string[]; rules: string[] }[] = [
  { key: "gg", name: "Both teams to score (GG)", stat: ["btts"], rules: [
    "Only take GG when both teams' score probability is 65% or higher",
    "GG only when both teams' goals blend is at least 1.5 over their last 5",
    "Skip GG unless at least 6 of the last 10 head-to-heads ended with both teams scoring",
  ]},
  { key: "home_to_score", name: "Home team to score", stat: ["home_to_score"], rules: [
    "Home to score only when the home team's score probability is 75% or higher",
    "Home to score only when the home team averages 1.5 goals or more over its last 5",
    "Skip the game when the home team's goals blend is under 1.3",
  ]},
  { key: "overs", name: "Over 2.5 goals", stat: ["over_2_5", "over_3_5"], rules: [
    "Overs only when the fixture's goals blend is 3.0 or higher",
    "Over 2.5 only when the head-to-head average goals is at least 3",
    "Skip overs when either team's goals blend is under 1.2",
  ]},
  { key: "unders", name: "Under 3.5 goals", stat: ["under_2_5", "under_3_5"], rules: [
    "Unders only when the fixture's goals blend is 2.4 or less",
    "Skip unders when the head-to-head average goals is above 3",
    "Unders only when both teams average under 1.2 goals scored over their last 5",
  ]},
  { key: "double_chance", name: "Double chance (1X)", stat: ["double_chance_1x", "double_chance_x2"], rules: [
    "1X only when the home team's form is at least 1.8 points per game over its last 5",
    "1X only when the home win probability is 55% or higher",
    "Skip the game when the away team won 3 or more of its last 5",
  ]},
  { key: "away_to_score", name: "Away team to score", stat: ["away_to_score"], rules: [
    "Away to score only when the away team's score probability is 70% or higher",
    "Away to score only when the away team averages 1.5 goals or more over its last 5",
  ]},
  { key: "corners", name: "Corners over/under", stat: ["corners_ou", "over_8_5_corners"], rules: [
    "Corner overs only when the two teams average 10 corners or more between them",
    "Skip corner overs when the teams' combined corner average is under 9",
  ]},
  { key: "match_result", name: "Match result (home win)", stat: ["home_win", "away_win"], rules: [
    "Home win only when the home win probability is 60% or higher",
    "Home win only when home form is at least 2.0 points per game and the away side won 1 or fewer of its last 5",
  ]},
];

// One-time opener for the rule_tip slot (owner-directed): lead with the live ruled-vs-unruled
// hit rates — the strongest argument for writing a rule — then hand a copyable starter rule.
// Runs once (theme rule_tip:why_rules); numbers are computed at post time and the edition is
// skipped entirely if the live data doesn't clearly back the claim.
async function whyRulesEdition(): Promise<{ facts: string; instruction: string } | null> {
  try {
    const since = new Date(Date.now() - 30 * 86400000).toISOString();
    const { data } = await sb.from("deliveries")
      .select("result, strategies!inner(rule_text)")
      .in("result", ["won", "lost"]).gte("settled_at", since).limit(5000);
    let ruledW = 0, ruledN = 0, freeW = 0, freeN = 0;
    for (const r of (data ?? []) as any[]) {
      const st = Array.isArray(r.strategies) ? r.strategies[0] : r.strategies;
      const hasRule = !!(st?.rule_text && String(st.rule_text).trim());
      if (hasRule) { ruledN++; if (r.result === "won") ruledW++; }
      else { freeN++; if (r.result === "won") freeW++; }
    }
    if (ruledN < 100 || freeN < 100) return null;
    const ruledPct = (ruledW / ruledN) * 100, freePct = (freeW / freeN) * 100;
    if (ruledPct < freePct + 5) return null; // only post it while the data clearly backs it
    const starter = "Only take games where the home team's form is at least 1.8 points per game";
    return {
      facts: `Real 30-day numbers from Onside's settled picks: agents WITH a written rule landed ${ruledPct.toFixed(0)}% of ${ruledN} picks; agents with NO rule landed ${freePct.toFixed(0)}% of ${freeN}. Same engine, same games — the rule is the difference.\nA starter rule, written exactly how the agent engine understands it: "${starter}"`,
      instruction: `Write a SHORT post: 3-4 lines MAXIMUM, under 320 characters. Lead with the two hit rates as the hook (rules ${ruledPct.toFixed(0)}% vs no rules ${freePct.toFixed(0)}% — real numbers, plain variance disclaimer not needed but NEVER imply certainty). Then the starter rule QUOTED VERBATIM, then one line telling readers to drop it into their agent word for word. Sharp friend energy, not an essay.`,
    };
  } catch { return null; }
}

async function ruleTipPost(dry: boolean, dmChats: number[] | null = null): Promise<Response> {
  // rotation: skip families covered in the recent posts so the tips keep changing
  const { data: recent } = await sb.from("channel_posts").select("theme").eq("slot", "rule_tip").eq("status", "posted").order("created_at", { ascending: false }).limit(RULE_TIPS.length - 1);
  const covered = new Set((recent ?? []).map((r: any) => String(r.theme)));

  // the one-time "why rules" opener goes first, before the family rotation begins
  if (!covered.has("rule_tip:why_rules")) {
    const special = await whyRulesEdition();
    if (special) {
      let body = "";
      try {
        body = await draft(special.instruction, special.facts);
        if (BANNED.test(body)) body = await draft(special.instruction + " IMPORTANT: do not use any language implying a guaranteed or certain outcome.", special.facts);
      } catch { /* fall through to rotation below */ }
      if (body && !BANNED.test(body)) {
        const text = body.slice(0, 700) + FOOTER;
        if (dry) return new Response(JSON.stringify({ status: "dry", slot: "rule_tip", family: "why_rules", text }), { status: 200, headers: { "content-type": "application/json" } });
        if (dmChats && dmChats.length) {
          for (const chat of dmChats) await tg("sendMessage", { chat_id: chat, text, disable_web_page_preview: true });
          return new Response(JSON.stringify({ status: "dm_sent", slot: "rule_tip", family: "why_rules" }), { status: 200, headers: { "content-type": "application/json" } });
        }
        const sent = await tg("sendMessage", { chat_id: CHANNEL, text, disable_web_page_preview: true });
        const ok = sent?.ok === true;
        await sb.from("channel_posts").insert({
          slot: "rule_tip", theme: "rule_tip:why_rules", body: text,
          telegram_message_id: ok ? sent.result?.message_id : null,
          status: ok ? "posted" : "failed",
          meta: ok ? null : { telegram: sent },
        });
        return new Response(JSON.stringify({ status: ok ? "posted" : "failed", slot: "rule_tip", family: "why_rules" }), { status: 200, headers: { "content-type": "application/json" } });
      }
    }
  }

  const tip = RULE_TIPS.find((t) => !covered.has(`rule_tip:${t.key}`)) ?? RULE_TIPS[0];
  // vary WHICH example rule within the family by day, so a family's second outing reads fresh
  const rule = tip.rules[Math.floor(Date.now() / 86400000) % tip.rules.length];

  // garnish with the family's real 30-day hit rate when the sample is worth quoting
  let statLine = "";
  try {
    const since = new Date(Date.now() - 30 * 86400000).toISOString();
    const { data } = await sb.from("deliveries").select("result").in("market_key", tip.stat).gte("settled_at", since).in("result", ["won", "lost"]).limit(2000);
    const rows = data ?? [];
    const won = rows.filter((r: any) => r.result === "won").length;
    if (rows.length >= 15) statLine = `\nReal context (quote it as the market's overall agent record, NEVER as the result of this specific rule): agents' ${tip.name} picks overall landed ${won} of ${rows.length} (${pct(won / rows.length)}) over the last 30 days.`;
  } catch { /* stat is garnish */ }

  const facts = `Market family: ${tip.name}.\nA rule that works, written exactly how the Onside agent engine understands it: "${rule}"${statLine}`;
  const instruction = `Write a SHORT rule tip: 3-4 lines MAXIMUM, total under 320 characters. Shape: one hook line like "You wan rule for ${tip.name}?" — then the rule QUOTED VERBATIM exactly as given in the facts — then ONE short closing line (why it filters rubbish, or the real stat if provided). No lists, no headers, no lecture, no extra beats. Sound like a sharp friend sharing what's working, not a bot writing an essay.`;

  let body = "";
  try {
    body = await draft(instruction, facts);
    if (BANNED.test(body)) body = await draft(instruction + " IMPORTANT: do not use any language implying a guaranteed or certain outcome.", facts);
  } catch { /* static fallback below */ }
  if (!body || BANNED.test(body)) {
    body = `You wan rule for ${tip.name}? Try this one 👇\n\n"${rule}"\n\nDrop am inside your agent word for word — the engine sabi read am.`;
  }

  const text = body.slice(0, 700) + FOOTER;
  if (dry) {
    return new Response(JSON.stringify({ status: "dry", slot: "rule_tip", family: tip.key, text }), { status: 200, headers: { "content-type": "application/json" } });
  }
  if (dmChats && dmChats.length) {
    const results = [];
    for (const chat of dmChats) {
      const r = await tg("sendMessage", { chat_id: chat, text, disable_web_page_preview: true });
      results.push(r?.ok === true);
    }
    return new Response(JSON.stringify({ status: "dm_sent", slot: "rule_tip", family: tip.key, chats: results }), { status: 200, headers: { "content-type": "application/json" } });
  }
  const sent = await tg("sendMessage", { chat_id: CHANNEL, text, disable_web_page_preview: true });
  const ok = sent?.ok === true;
  await sb.from("channel_posts").insert({
    slot: "rule_tip", theme: `rule_tip:${tip.key}`, body: text,
    telegram_message_id: ok ? sent.result?.message_id : null,
    status: ok ? "posted" : "failed",
    meta: ok ? { family: tip.key, rule } : { family: tip.key, rule, telegram: sent },
  });
  return new Response(JSON.stringify({ status: ok ? "posted" : "failed", slot: "rule_tip", family: tip.key }), { status: 200, headers: { "content-type": "application/json" } });
}

// Afternoon slot when there IS a perfect card: post the flyer image + a short Claude caption.
// Returns a Response once handled; returns null when there's no sweep so the caller can fall back.
async function perfectAgentPost(): Promise<Response | null> {
  const sweep = await yesterdaySweep();
  if (!sweep) return null;

  const { n, legs } = sweep;
  const shown = legs.slice(0, 5);
  const legLines = shown.map((l) => `- ${l.home} v ${l.away}: ${l.market}${l.score ? ` (${l.score})` : ""}`).join("\n");
  const facts = `Yesterday one Onside agent swept its ENTIRE card — ${n}/${n} legs, every single one landed:\n${legLines}` +
    (legs.length > shown.length ? `\n…and ${legs.length - shown.length} more, all landed` : "") +
    `\nThe slip image with all the legs is attached to this post.`;
  const instruction = "Write a short, punchy caption for an image showing an Onside agent that swept its whole card yesterday — every leg landed. Celebrate it as a rare perfect day, plain variance, never proof of a sure thing. Gently nudge readers to build their own agent. 2-3 short beats.";

  let body = "";
  try {
    body = await draft(instruction, facts);
    if (BANNED.test(body)) body = await draft(instruction + " IMPORTANT: do not use any language implying a guaranteed or certain outcome.", facts);
  } catch { /* fall through to the static caption below */ }
  if (!body || BANNED.test(body)) {
    body = `⚽ Yesterday one Onside agent swept its whole card — ${n}/${n}, every leg landed. 👀\n\n` +
      `No be everyday e dey happen — but when the value line up with sense, agent fit sweep am.\n\n` +
      `Build your own AI agent on Onside and track am for yourself.`;
  }

  const text = body.slice(0, 900) + FOOTER; // sendPhoto caption cap is 1024; 900 + footer stays under
  const photo = `${SITE}/flyer/results?size=feed&d=${Date.now()}`; // cache-bust so Telegram refetches
  const sent = await tg("sendPhoto", { chat_id: CHANNEL, photo, caption: text });
  const ok = sent?.ok === true;
  await sb.from("channel_posts").insert({
    slot: "perfect_agent", theme: "perfect_agent", body: text,
    telegram_message_id: ok ? sent.result?.message_id : null,
    status: ok ? "posted" : "failed",
    meta: ok ? { photo, n } : { photo, n, telegram: sent },
  });
  return new Response(JSON.stringify({ status: ok ? "posted" : "failed", slot: "perfect_agent", n }), { status: 200, headers: { "content-type": "application/json" } });
}

async function runTextSlot(slot: string): Promise<Response> {
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
}

Deno.serve(async (req) => {
  let slot = "education";
  let dry = false;
  let toOwner = false;
  try { const b = await req.json(); if (b?.slot) slot = String(b.slot); dry = b?.dry === true; toOwner = b?.to === "owner"; } catch { /* default */ }
  const dmChats = toOwner ? await adminChatIds() : null;

  // Morning: the target-hit flyer carousel (or the honest day-record flyer when no agent swept).
  if (slot === "agent_hits") return await agentHitsPost(dry, dmChats);
  // Night: one short rule tip, rotating across the glossary's market families.
  if (slot === "rule_tip") return await ruleTipPost(dry, dmChats);

  // Afternoon: try the perfect-agent card first; fall back to the product_gap lesson if no sweep.
  // (Manual slot now — the cron's afternoon runs product_gap since the morning owns the sweeps.)
  if (slot === "perfect_agent") {
    const posted = await perfectAgentPost();
    if (posted) return posted;
    slot = "product_gap";
  }

  return await runTextSlot(slot);
});
