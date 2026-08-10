// Onside betslip screenshot parser. Reads an uploaded slip image with Claude vision,
// extracts each selection, maps it to an Onside market, and matches it to a fixture.
// Uses Haiku to keep vision cost low. Needs an Anthropic key as either an edge
// function secret (ANTHROPIC_API_KEY / anthropic_api_key) or in the get_secret store.
//
// One slip can arrive as several images: a long acca spread over multiple screenshots,
// and/or a tall screenshot the client sliced into vertical strips (the vision API
// downscales any single image to ~1.15MP, so a tall stacked slip loses per-leg
// resolution). All images arrive as `paths[]` and are read together as ONE slip / one read.
import { createClient } from "npm:@supabase/supabase-js@2";
import { encodeBase64 } from "jsr:@std/encoding/base64";

const MODEL = "claude-haiku-4-5";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const sb = createClient(SUPABASE_URL, SERVICE_KEY);

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const MARKET_KEYS = [
  "over_0_5", "over_1_5", "over_2_5", "over_3_5", "under_2_5", "under_3_5",
  "btts", "home_to_score", "away_to_score", "home_win", "away_win", "draw",
  "double_chance_1x", "double_chance_x2", "double_chance_12", "over_8_5_corners",
  "home_to_qualify", "away_to_qualify", "custom",
];

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    // slip-level money summary — 0/"" when not visible on the screenshot
    slip: {
      type: "object",
      additionalProperties: false,
      properties: {
        bookmaker: { type: "string" },
        stake: { type: "number" },
        potential_return: { type: "number" },
        currency: { type: "string" },
        leg_count: { type: "number" },
      },
      required: ["bookmaker", "stake", "potential_return", "currency", "leg_count"],
    },
    selections: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          home: { type: "string" },
          away: { type: "string" },
          league: { type: "string" },
          market_key: { type: "string", enum: MARKET_KEYS },
          market_label: { type: "string" },
          raw_market: { type: "string" },
          value: { type: "string" },
          line: { type: "number" },
          confidence: { type: "string", enum: ["high", "low"] },
        },
        required: ["home", "away", "league", "market_key", "market_label", "raw_market", "value", "line", "confidence"],
      },
    },
  },
  required: ["slip", "selections"],
};

const PROMPT = `You are reading a football betting slip screenshot. Extract EVERY selection on it — do NOT skip, merge, or summarise any leg.
A slip (especially an accumulator) can list many games stacked vertically; return ONE selection object per leg, in the order they appear top to bottom. If the slip shows a leg count or fold number (e.g. "8 selections", "10 legs"), you must return that many selections. Include a leg even when you are unsure — set confidence "low" rather than dropping it.
For each selection return: home team, away team, league (if visible else ""), and map the bet to ONE market_key from this set: ${MARKET_KEYS.join(", ")}.
Use the FULL team names as printed (do not abbreviate).
Mapping guide for the engine markets: "1X"/home or draw -> double_chance_1x; "X2"/draw or away -> double_chance_x2; "12"/home or away -> double_chance_12; GG/BTTS/both teams to score -> btts; "Over 1.5/2.5/3.5" goals -> over_1_5/over_2_5/over_3_5 (nearest supported line 0.5/1.5/2.5/3.5); "Under 2.5/3.5" -> under_2_5/under_3_5; home win/"1" -> home_win; away win/"2" -> away_win; draw/"X" -> draw; home/away to score -> home_to_score/away_to_score; corners over N -> over_8_5_corners with line=N; to qualify/advance -> home_to_qualify/away_to_qualify.
TEAM TOTALS (read carefully — this is common and easy to miss): a plain Over/Under with NO team attached counts BOTH teams' goals (use over_x_5/under_x_5). But an Over/Under is a SINGLE-TEAM total whenever a team's name is attached to it — INCLUDING when the bold line shows only "Over N"/"Under N" and a nearby subtitle or market description reads "<Team> Over/Under", "<Team> Total", or "<Team> Goals". This is exactly how SportyBet and many bookmakers label a team total: e.g. a subtitle "Kuopion Palloseura Over/Under" with a bold "Over 0.5" means Kuopion Palloseura's goals over 0.5 — NOT the match total. Inline forms count too ("Barcelona Over 1.5", "Man City Total Over 2.5"). For ANY single-team total, do NOT use the total over_x_5/under_x_5 keys — use market_key "custom" with market_label "Home over N" / "Home under N" when the named team is the fixture's HOME team, or "Away over N" / "Away under N" when it is the AWAY team (N = the printed line, keep over/under exactly as shown). Decide home vs away by matching the named team to the home/away teams you read for that fixture. Only treat an Over/Under as the match total when NO team name is attached to it.
EVERYTHING ELSE uses market_key "custom": set market_label to a short human name for the market and use the "value" field for the specific detail:
- Player markets (anytime/first/last goalscorer, player to be carded/booked/sent off, to score a header/free-kick, player shots/shots on target/saves/assists/fouls/offsides/passes, to score or assist, most goals/shots/assists): market_label = the market name (e.g. "Anytime goalscorer", "Player to be carded"), value = the PLAYER NAME exactly as printed (include an N+ line if shown, e.g. "Osorio, Jonathan 2+").
- Correct score / HT-FT / handicap / multigoals / goal range / winning margin: market_label = the market name, value = the exact selection (e.g. "2-1", "1/2", "-1.5", "2-3").
- Corners/cards/bookings/shots/fouls/offsides totals: market_label like "Over 9.5 corners", "Under 3.5 cards"; value = "".
raw_market: copy the selection's market text EXACTLY as printed (verbatim), INCLUDING any team name shown beside the Over/Under or Total — e.g. the greyed subtitle "Kuopion Palloseura Over/Under" or "Man City Total". Do NOT paraphrase or drop the team name; this is used to detect single-team totals, so accuracy here matters more than market_label.
When there is no extra value, set value to "". line: the numeric goal/corner line (e.g. 8.5) or 0 if none. confidence: "high" if clearly read, else "low".
Also fill the top-level "slip" object from the slip's money summary (usually at the top or bottom):
- stake: the TOTAL amount wagered ("Stake", "Total Stake", "Amount"). Strip currency symbols and thousands separators: "₦5,000.00" -> 5000.
- potential_return: the potential winnings ("Potential Win", "Possible Win", "To Return", "Est. Payout", "Potential Return"). If the slip shows both a base win and a final amount with bonus, use the FINAL payout amount.
- currency: a 3-letter code inferred from the symbol or text: ₦/NGN -> "NGN", GH₵/GHS -> "GHS", KSh/KES -> "KES", TSh -> "TZS", USh -> "UGX", R -> "ZAR", $ -> "USD", € -> "EUR", £ -> "GBP"; otherwise the symbol exactly as printed.
- bookmaker: the bookmaker's name if identifiable from the slip's branding/layout (e.g. "SportyBet", "Bet365", "1xBet", "Betway", "BetKing", "MSport", "Paripesa").
- leg_count: the selection/fold count PRINTED on the slip (e.g. "32 Games", "15-fold", "8 selections"); 0 if none is shown. This is used to verify you returned every leg.
Use 0 for any amount that is not visible and "" for unknown currency/bookmaker. Never invent amounts.
Return only the structured JSON.`;

// prepended when the slip arrived as several images (multiple screenshots and/or slices)
const MULTI_PREFIX = (n: number) => `The following ${n} images are pieces of ONE betslip — either several screenshots of the same slip or consecutive TOP-TO-BOTTOM slices of one tall screenshot. They may OVERLAP, so the same leg can appear in two images — count it only ONCE. Read all images together as a single slip, in order, and return every distinct leg across all of them.\n`;

function json(b: unknown, s = 200) {
  return new Response(JSON.stringify(b), { status: s, headers: { "Content-Type": "application/json", ...CORS } });
}
async function anthropicKey(): Promise<string> {
  const env = Deno.env.get("ANTHROPIC_API_KEY") || Deno.env.get("anthropic_api_key");
  if (env) return env;
  const { data } = await sb.rpc("get_secret", { secret_name: "anthropic_api_key" });
  if (data) return data as string;
  throw new Error("Anthropic API key not configured (set ANTHROPIC_API_KEY edge secret)");
}

// --- fuzzy fixture matching ---
export const norm = (s: string) => (s ?? "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
const toks = (s: string) => norm(s).split(" ").filter((w) => w.length >= 3);
// two tokens "match" if equal, one is a prefix of the other (>=3), or they share a >=4-char
// prefix — so "man"~"manchester", "utd"~"utd", "barca"~"barcelona", "atletico"~"atlet".
function tokMatch(x: string, y: string): boolean {
  if (x === y) return true;
  const a = x.length <= y.length ? x : y, b = x.length <= y.length ? y : x;
  if (a.length >= 3 && b.startsWith(a)) return true;
  let i = 0; while (i < a.length && a[i] === b[i]) i++;
  return i >= 4;
}
const overlap = (slip: string[], fx: string[]) => slip.filter((s) => fx.some((f) => tokMatch(s, f))).length;

// total Over/Under key -> {side, line}; null for anything else (incl. corners). Used to remap a
// total O/U to a TEAM total when the printed market text names one of the two teams.
function ouParts(mk: string): { side: "over" | "under"; line: number } | null {
  const m = mk.match(/^(over|under)_(\d)_5$/);
  return m ? { side: m[1] === "under" ? "under" : "over", line: Number(`${m[2]}.5`) } : null;
}

async function loadAliases(): Promise<Map<string, string>> {
  const { data } = await sb.from("team_aliases").select("alias, canonical");
  const m = new Map<string, string>();
  for (const r of data ?? []) m.set(r.alias, r.canonical);
  return m;
}

async function matchFixture(sHome: string, sAway: string, winStart: string, aliases: Map<string, string>) {
  // resolve a learned alias first ("Man Utd" -> "Manchester United"), else use the printed name
  const home = aliases.get(norm(sHome)) ?? sHome;
  const away = aliases.get(norm(sAway)) ?? sAway;
  const terms: string[] = [];
  for (const t of [...toks(home), ...toks(away)]) terms.push(`home_team.ilike.%${t}%`, `away_team.ilike.%${t}%`);
  if (!terms.length) return null;
  const { data: cand } = await sb
    .from("fixtures")
    .select("id, home_team, away_team, kickoff_utc, leagues(name, flag_url, tier)")
    .gte("kickoff_utc", winStart)
    .or(terms.join(","))
    .order("kickoff_utc", { ascending: true })
    .limit(60);
  const sh = toks(home), sa = toks(away);
  let best: any = null, bestScore = 0;
  for (const f of cand ?? []) {
    const ho = overlap(sh, toks(f.home_team));
    const ao = overlap(sa, toks(f.away_team));
    if (ho >= 1 && ao >= 1 && ho + ao > bestScore) { bestScore = ho + ao; best = f; }
  }
  return best;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const authHeader = req.headers.get("Authorization") ?? "";
    const authClient = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: authHeader } } });
    const { data: { user } } = await authClient.auth.getUser();
    if (!user) return json({ error: "unauthorized" }, 401);

    // daily upload cap — keeps vision cost bounded. Beyond it, users add games by hand.
    const { data: quota } = await sb.rpc("slip_upload_quota", { uid: user.id });
    const q = Array.isArray(quota) ? quota[0] : quota;
    if (q && Number(q.used) >= Number(q.quota)) {
      return json({ error: `DAILY_UPLOAD_LIMIT:${q.plan}:${q.quota}` }, 429);
    }

    // one slip may arrive as several images: accept paths[] (preferred) or a single path
    const body = await req.json();
    const paths: string[] = Array.isArray(body?.paths) ? body.paths.filter((p: unknown) => typeof p === "string")
      : typeof body?.path === "string" ? [body.path] : [];
    if (!paths.length) return json({ error: "missing path" }, 400);
    if (paths.length > 16) return json({ error: "too many images" }, 400);
    for (const p of paths) if (!p.startsWith(`${user.id}/`)) return json({ error: "forbidden" }, 403);

    const imageBlocks: any[] = [];
    for (const p of paths) {
      const { data: blob, error: dlErr } = await sb.storage.from("betslips").download(p);
      if (dlErr || !blob) return json({ error: "could not read the upload" }, 400);
      const b64 = encodeBase64(new Uint8Array(await blob.arrayBuffer()));
      const mime = p.endsWith(".png") ? "image/png" : p.endsWith(".webp") ? "image/webp" : "image/jpeg";
      imageBlocks.push({ type: "image", source: { type: "base64", media_type: mime, data: b64 } });
    }
    // the images are now in memory as base64 — we don't keep users' bet-slip screenshots. Delete the
    // stored copies immediately (the daily cap counts screenshot_imports rows, not files, so this is
    // safe). Best-effort: a cleanup failure must not fail the read.
    try { await sb.storage.from("betslips").remove(paths); } catch { /* best-effort cleanup */ }
    const promptText = (paths.length > 1 ? MULTI_PREFIX(paths.length) : "") + PROMPT;
    const key = await anthropicKey();

    // one vision pass over the full image set -> { selections, slip }; throws on a hard failure
    async function runPass(): Promise<{ selections: any[]; slip: any }> {
      const r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
        body: JSON.stringify({
          model: MODEL,
          // generous budget so a long accumulator (many verbose custom/player legs) is never
          // truncated mid-list — truncation was one reason legs went missing before
          max_tokens: 8000,
          output_config: { format: { type: "json_schema", schema: SCHEMA } },
          messages: [{ role: "user", content: [...imageBlocks, { type: "text", text: promptText }] }],
        }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(`vision api ${r.status}: ${d?.error?.message ?? "error"}`);
      if (d.stop_reason === "refusal") throw new Error("REFUSAL");
      if (d.stop_reason === "max_tokens") console.warn("parse-slip hit max_tokens — slip may be very long");
      const tb = (d.content ?? []).find((b: any) => b.type === "text");
      const p = JSON.parse(tb?.text ?? "{}");
      return { selections: Array.isArray(p.selections) ? p.selections : [], slip: p.slip ?? {} };
    }

    // Vision is non-deterministic on tall multi-strip slips: one pass of a long slip can under-read
    // badly (an 18-leg slip came back as 2 on a retry). Take the UNION of up to 3 passes, stopping as
    // soon as a pass adds nothing new. A single un-sliced screenshot reads reliably in one pass, so
    // only multi-image slips pay for the extra passes. Dedup key matches the one used below.
    const selKey = (s: any) => `${norm(s.home)}|${norm(s.away)}|${s.market_key}|${s.line ?? ""}|${norm(s.value ?? "")}|${norm(s.market_label ?? "")}`;
    const selections: any[] = [];
    const rawSlip: any = { bookmaker: null, stake: null, potential_return: null, currency: null, leg_count: 0 };
    const seenPass = new Set<string>();
    const maxPasses = paths.length > 1 ? 3 : 1;
    for (let pass = 0; pass < maxPasses; pass++) {
      let res: { selections: any[]; slip: any };
      try {
        res = await runPass();
      } catch (e) {
        if (pass === 0) {
          const m = String(e instanceof Error ? e.message : e);
          if (m === "REFUSAL") return json({ error: "could not read this image" }, 400);
          return json({ error: m.startsWith("vision api") ? m : `vision api: ${m}` }, 502);
        }
        break; // a later pass failing just ends the union early — keep what we have
      }
      // the money summary sits in only one strip, so first non-null value across passes wins
      rawSlip.bookmaker = rawSlip.bookmaker || res.slip.bookmaker || null;
      rawSlip.currency = rawSlip.currency || res.slip.currency || null;
      if (!rawSlip.stake && Number(res.slip.stake) > 0) rawSlip.stake = res.slip.stake;
      if (!rawSlip.potential_return && Number(res.slip.potential_return) > 0) rawSlip.potential_return = res.slip.potential_return;
      if (!rawSlip.leg_count && Number(res.slip.leg_count) > 0) rawSlip.leg_count = res.slip.leg_count;
      let addedThis = 0;
      for (const s of res.selections) {
        const k = selKey(s);
        if (seenPass.has(k)) continue;
        seenPass.add(k);
        selections.push(s);
        addedThis++;
      }
      if (pass >= 1 && addedThis === 0) break; // converged — nothing new this pass
    }
    const expected = Math.round(Number(rawSlip.leg_count)) || 0;
    const num = (v: unknown) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : null; };
    const str = (v: unknown) => { const s = String(v ?? "").trim(); return s ? s : null; };
    const slip = {
      bookmaker: str(rawSlip.bookmaker),
      stake: num(rawSlip.stake),
      potential_return: num(rawSlip.potential_return),
      currency: str(rawSlip.currency),
    };

    const winStart = new Date(Date.now() - 6 * 3600 * 1000).toISOString();
    const aliases = await loadAliases();
    const out = [];
    const seen = new Set<string>();
    for (const s of selections) {
      // drop a leg the model repeated across an image overlap or the top-up pass. The label is part
      // of the key so two DIFFERENT custom bets on the same game (both value "", line 0) never
      // collapse into one — a real repeat reads back with the same label anyway.
      const dedupe = `${norm(s.home)}|${norm(s.away)}|${s.market_key}|${s.line ?? ""}|${norm(s.value ?? "")}|${norm(s.market_label ?? "")}`;
      if (seen.has(dedupe)) continue;
      seen.add(dedupe);
      const match = await matchFixture(s.home, s.away, winStart, aliases);
      const lg = match?.leagues ?? null;
      const value = (s.value ?? "").trim();
      let mk: string = s.market_key;
      let label = value && s.market_key === "custom" ? `${s.market_label} — ${value}` : s.market_label;
      let side: string | null = null;
      let outLine: number | null = s.market_key === "over_8_5_corners" ? (s.line || 8.5) : null;
      // Team total: a total Over/Under whose printed market text (raw_market) names ONE of the two
      // teams — e.g. SportyBet's "Kuopion Palloseura Over/Under" subtitle with a bold "Over 0.5" — is
      // that team's goals, not the match total. Detect it deterministically here rather than trusting
      // the vision model's classification (which keeps flattening it to over_x_5).
      const ou = ouParts(s.market_key);
      if (ou && match) {
        const rawToks = toks(`${s.raw_market ?? ""} ${s.market_label ?? ""}`);
        const homeHit = overlap(toks(s.home), rawToks);
        const awayHit = overlap(toks(s.away), rawToks);
        if ((homeHit > 0 || awayHit > 0) && homeHit !== awayHit) {
          const isHome = homeHit > awayHit;
          mk = isHome ? "home_goals_ou" : "away_goals_ou";
          side = ou.side;
          outLine = ou.line;
          label = `${isHome ? match.home_team : match.away_team} ${ou.side} ${ou.line}`;
        }
      }
      out.push({
        home: s.home, away: s.away, league: s.league,
        market_key: mk, market_label: label, value: value || null, side,
        line: outLine,
        confidence: s.confidence,
        fixture_id: match?.id ?? null,
        matched: match ? `${match.home_team} v ${match.away_team}` : null,
        league_name: lg?.name ?? (s.league || null),
        league_flag: lg?.flag_url ?? null,
        league_tier: lg?.tier ?? null,
      });
    }

    // record the successful vision call so it counts against the daily cap (one read per slip).
    // ONLY charge when the read actually produced selections — an empty read (unreadable image)
    // shows "Failed, try again" on the client, so it must not burn one of the day's reads.
    if (out.length > 0) {
      await sb.from("screenshot_imports").insert({
        user_id: user.id,
        storage_path: paths[0],
        status: "parsed",
        parsed: { slip, expected, selections: out },
      });
    }

    return json({ slip, expected, selections: out });
  } catch (e) {
    console.error("parse-slip failed:", e);
    return json({ error: String(e instanceof Error ? e.message : e) }, 500);
  }
});
