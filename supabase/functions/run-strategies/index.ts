// Onside strategy runner + edge engine + rule engine + per-user delivery scheduler.
// Cron every minute; only DUE strategies run. Target window (same_day/tomorrow/saturday/sunday/
// weekend/future); saturday/sunday fire only on that weekday. Pricing: model_prob (Poisson) vs
// de-vigged market_prob = edge; families price every option and deliver the best. The DELIVERED
// model % is calibrated via blend50 (model-market log-odds midpoint; selection stays raw — see
// blend50). No fixture twice
// per strategy; per-user daily cap = max_agents x cap. Telegram picks show flag + league + time +
// a traffic-light confidence dot.
// Leagues are a MODE (league_mode): fixed = hunt league_ids; all = every competition (Pro Max);
// surprise = re-roll a fresh in-window subset every run (see resolveLeagueIds).
import { createClient } from "npm:@supabase/supabase-js@2";

// New Supabase API keys: prefer the secret key (sb_secret_…, maps to the service_role Postgres
// role); fall back to the platform-injected legacy SERVICE_ROLE_KEY so this keeps working whether
// or not legacy keys have been disabled. This function only needs the privileged client.
const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_KEY = Deno.env.get("SUPABASE_SECRET_KEY") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const sb = createClient(SB_URL, SB_KEY);
const FINISHED_LIVE = ["FT", "AET", "PEN", "1H", "2H", "HT", "ET", "BT", "P", "LIVE", "SUSP", "INT"];
// postponed/cancelled/abandoned/awarded/walkover — these games will never be played as scheduled,
// so they must never appear in a pick (the sync fn flips a status to PST but the fixture keeps a
// valid in-window kickoff, which is how PP games leaked into predictions)
const DEAD = ["PST", "CANC", "ABD", "AWD", "WO"];
const NOT_PICKABLE = [...FINISHED_LIVE, ...DEAD];
const FINISHED = ["FT", "AET", "PEN"];
const ODDS_FETCH_CAP = 90;
const DEF_HOME = 1.45, DEF_AWAY = 1.15;
// Forecast model v2 (Elo + league-relative time-decayed rates + DC/temperature calibration).
// Params fitted on ~172k finished fixtures via perf/backtest.mts (see fitted params there).
// v2 structural fixes over v1: (1) goals normalised by the league each match was PLAYED in — v1
// divided domestic goals by the predicted fixture's league mean, inflating minnows in cup/UEFA ties
// (the source of implausible 30%+ "edges"); (2) venue record blended with overall record (doubles
// the sample); (3) score-matrix temperature fixes tail overconfidence for every derived market.
// The user's rule engine still layers ON TOP of these probabilities.
const SHRINK = 12;            // pseudo-matches pulling a team's rate toward its Elo prior (fitted)
const MIN_TEAM_MATCHES = 4;   // overall weighted-match floor for a "confident" (priced) fixture
const HALF_LIFE_DAYS = 90;    // recency: a match's weight halves every 90 days
const HOME_ADV_ELO = 40;      // Elo points added to the home side
const ELO_K = 10;             // Elo update step
const ELO_BASE = 1500;
const ELO_PER_LOG_GOAL = 300; // Elo points ≈ one e-fold of goal strength (maps Elo → attack/defence prior)
const VENUE_WEIGHT = 0;       // fitted: the overall record beats the venue-split one (venue is already in the league means)
const LEAGUE_SHRINK = 30;     // fitted: pseudo-matches pulling a small league's means toward the global mean
const RHO = 0;                // Dixon–Coles low-score correction (fitted: didn't help)
// Score-matrix temperature. Backtest-fitted anchor is 1; the daily self-calibration loop
// (maybeRecalibrate) nudges it from REALIZED pick outcomes, bounded [1, 1.3], evidence-gated.
let TEMP = 1;
// Beyond this, the model almost certainly disagrees with reality rather than beating the market —
// the pick keeps its true edge in the row but is demoted to amber and ranked at the cap.
const MAX_PLAUSIBLE_EDGE = 0.15;

// CORS: the builder calls this function straight from the browser (rule read-back, run-on-create).
// Without these headers the preflight fails and every in-app invoke silently dies — curl works,
// the app doesn't. Cron/server callers ignore them.
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" };
function json(b: unknown, s = 200) { return new Response(JSON.stringify(b), { status: s, headers: { "Content-Type": "application/json", ...CORS } }); }
async function getSecret(name: string): Promise<string> {
  const { data, error } = await sb.rpc("get_secret", { secret_name: name });
  if (error || !data) throw new Error(`secret ${name}`);
  return data as string;
}
async function getSecretSoft(name: string): Promise<string | null> {
  try { const { data } = await sb.rpc("get_secret", { secret_name: name }); return (data as string) ?? null; } catch { return null; }
}
// Anthropic key: env-first (matches classify-bet), vault fallback. The key is stored as an
// edge-function env secret, NOT in the vault — reading only the vault (the old bug) meant rules
// never parsed and were silently ignored.
async function anthropicKey(): Promise<string | null> {
  const env = Deno.env.get("ANTHROPIC_API_KEY") || Deno.env.get("anthropic_api_key");
  if (env) return env;
  try { const { data } = await sb.rpc("get_secret", { secret_name: "anthropic_api_key" }); return (data as string) ?? null; } catch { return null; }
}
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
async function sendTelegram(chatId: number, text: string): Promise<void> {
  const token = await getSecretSoft("telegram_bot_token");
  if (!token) return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
    });
  } catch { /* non-fatal */ }
}
// Web Push via the send-push edge fn (trusted call with the service key -> may target a user_id).
async function sendPush(userId: string, title: string, body: string, url: string, tag?: string): Promise<void> {
  try {
    await fetch(`${SB_URL}/functions/v1/send-push`, {
      method: "POST",
      headers: { "content-type": "application/json", "Authorization": `Bearer ${SB_KEY}` },
      body: JSON.stringify({ user_id: userId, title, body, url, tag, category: "agent_picks", mute: true }),
    });
  } catch { /* non-fatal */ }
}
// country name -> flag emoji (ISO2 -> regional indicators); UEFA comps -> trophy, World -> globe
const ISO2: Record<string, string> = { "England":"GB","Scotland":"GB","Wales":"GB","Northern-Ireland":"GB","Ireland":"IE","Spain":"ES","Italy":"IT","Germany":"DE","France":"FR","Netherlands":"NL","Portugal":"PT","Belgium":"BE","Turkey":"TR","Russia":"RU","Ukraine":"UA","Greece":"GR","Austria":"AT","Switzerland":"CH","Denmark":"DK","Norway":"NO","Sweden":"SE","Poland":"PL","Croatia":"HR","Serbia":"RS","Romania":"RO","Czech-Republic":"CZ","Hungary":"HU","Finland":"FI","Iceland":"IS","Brazil":"BR","Argentina":"AR","Mexico":"MX","USA":"US","Colombia":"CO","Chile":"CL","Uruguay":"UY","Ecuador":"EC","Peru":"PE","Paraguay":"PY","Bolivia":"BO","Venezuela":"VE","Japan":"JP","South-Korea":"KR","China":"CN","Saudi-Arabia":"SA","Qatar":"QA","UAE":"AE","Iran":"IR","India":"IN","Australia":"AU","Egypt":"EG","Morocco":"MA","Nigeria":"NG","Senegal":"SN","Ghana":"GH","Algeria":"DZ","Tunisia":"TN","Cameroon":"CM","South-Africa":"ZA","Ivory-Coast":"CI","Kenya":"KE" };
function iso2ToEmoji(cc: string): string {
  if (!cc || cc.length !== 2) return "";
  return String.fromCodePoint(...[...cc.toUpperCase()].map((c) => 127397 + c.charCodeAt(0)));
}
function flagFor(country: string | null, tier: string | null): string {
  if (tier === "uefa") return "🏆"; // trophy
  if (!country) return "";
  if (country === "World") return "🌍"; // globe
  return iso2ToEmoji(ISO2[country] ?? "");
}
// Confidence dot — green/yellow/amber, never red. Every game here was PICKED; the dot only grades
// how sure we are. Amber = a real pick with low edge OR no odds/model score to rate (e.g. rule-only
// matches in data-thin leagues), NOT "avoid".
function confDot(tier: string | null, mp: number | null): string {
  if (tier === "elite") return "🟢"; // green — strong value
  if (tier === "strong") return "🟡"; // yellow — solid value
  if (tier === "wide") return "🟠"; // amber — thin value
  const p = mp ?? 0;
  return p >= 0.65 ? "🟢" : p >= 0.55 ? "🟡" : "🟠"; // unpriced/model-only, or unrated → amber
}
function tzOffsetMin(d: Date, tz: string): number {
  const s = d.toLocaleString("en-US", { timeZone: tz, hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const [datePart, timePart] = s.split(", ");
  const [mo, da, yr] = datePart.split("/").map(Number);
  const [hh, mi, se] = timePart.split(":").map(Number);
  return (Date.UTC(yr, mo - 1, da, hh, mi, se) - d.getTime()) / 60000;
}
function tzDay(iso: string, tz: string): string { return new Date(iso).toLocaleDateString("en-CA", { timeZone: tz }); }
function tzEndOfTodayISO(tz: string): string {
  const now = new Date();
  const off = tzOffsetMin(now, tz);
  const [y, m, d] = now.toLocaleDateString("en-CA", { timeZone: tz }).split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d, 23, 59, 59) - off * 60000).toISOString();
}
function tzDayBoundsISO(tz: string, offsetDays: number): [string, string] {
  const now = new Date();
  const off = tzOffsetMin(now, tz);
  const [y, m, d] = now.toLocaleDateString("en-CA", { timeZone: tz }).split("-").map(Number);
  const start = new Date(Date.UTC(y, m - 1, d + offsetDays, 0, 0, 0) - off * 60000).toISOString();
  const end = new Date(Date.UTC(y, m - 1, d + offsetDays, 23, 59, 59) - off * 60000).toISOString();
  return [start, end];
}
function tzDow(tz: string): number {
  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(new Date().toLocaleDateString("en-US", { timeZone: tz, weekday: "short" }));
}
function isDue(s: any, now: Date): boolean {
  if (!s.deliver_at) return false;
  const tz = s.timezone || "Africa/Lagos";
  const target = s.target_day || "same_day";
  const dow = tzDow(tz);
  if (target === "saturday" && dow !== 6) return false;
  if (target === "sunday" && dow !== 0) return false;
  // "This weekend" runs ONLY on the weekend (Sat/Sun) — each day delivers that day's slate. Without
  // this gate it ran every day and pushed the weekend's fixtures out on weekdays (defeating the point).
  if (target === "weekend" && dow !== 6 && dow !== 0) return false;
  const nowTime = now.toLocaleTimeString("en-GB", { timeZone: tz, hour12: false });
  if (nowTime < String(s.deliver_at).slice(0, 8)) return false;
  if (s.last_run_at && tzDay(s.last_run_at, tz) === now.toLocaleDateString("en-CA", { timeZone: tz })) return false;
  return true;
}

type Fixture = { id: number; league_id: number; kickoff_utc: string; home_team_id: number | null; away_team_id: number | null };

// factorials to 30 — corners/cards Poissons run to ~14 events, well past the goals matrix's 10
const FACT: number[] = [1];
for (let i = 1; i <= 30; i++) FACT.push(FACT[i - 1] * i);
const pois = (k: number, l: number) => Math.exp(-l) * Math.pow(l, k) / FACT[k];
const poisOver = (lam: number, line: number) => { let s = 0; for (let k = 0; k <= 30; k++) if (k > line) s += pois(k, lam); return Math.min(1, s); };
// Dixon–Coles low-score dependence correction (no-op at RHO = 0)
function dcTau(x: number, y: number, l: number, m: number): number {
  if (x === 0 && y === 0) return 1 - l * m * RHO;
  if (x === 0 && y === 1) return 1 + l * RHO;
  if (x === 1 && y === 0) return 1 + m * RHO;
  if (x === 1 && y === 1) return 1 - RHO;
  return 1;
}
// ---------- early-payout (1UP/2UP/Never Down) path maths ----------
// Given a final score (i home goals, j away), every ordering of the goals is equally likely under
// Poisson scoring, so "was the team EVER a goal up during the game" has an exact ballot-problem
// formula. That lets both the model AND the bookies' implied matrix price these markets — the
// bookies never quote 1UP directly, but their 1X2 + totals pin down their score matrix.
const C2 = (n: number, r: number) => (r < 0 || r > n ? 0 : FACT[n] / (FACT[r] * FACT[n - r]));
const everUp1 = (i: number, j: number) => (i > j ? 1 : i / (j + 1));
const everUp2 = (i: number, j: number) => (i - j >= 2 ? 1 : i >= 2 ? C2(i + j, i - 2) / C2(i + j, i) : 0);
const neverBehindWin = (i: number, j: number) => (i > j ? (i + 1 - j) / (i + 1) : 0);
const EARLY_KEYS = ["home_win_1up", "away_win_1up", "home_win_2up", "away_win_2up", "home_win_never_down", "away_win_never_down", "double_chance_1x_1up", "double_chance_x2_1up"] as const;
// P(market wins | final score i-j), matching poll's settlement semantics exactly
function earlyCell(mk: string, i: number, j: number): number {
  switch (mk) {
    case "home_win_1up": return everUp1(i, j);
    case "away_win_1up": return everUp1(j, i);
    case "home_win_2up": return i > j ? 1 : everUp2(i, j);
    case "away_win_2up": return j > i ? 1 : everUp2(j, i);
    case "home_win_never_down": return neverBehindWin(i, j);
    case "away_win_never_down": return neverBehindWin(j, i);
    case "double_chance_1x_1up": return i >= j ? 1 : everUp1(i, j);
    case "double_chance_x2_1up": return j >= i ? 1 : everUp1(j, i);
    default: return 0;
  }
}
type Agg = { hw: number; dr: number; aw: number; totalP: number[]; homeScore: number; awayScore: number; btts: number; marg: number[]; hDist: number[]; aDist: number[]; hwNil: number; awNil: number; early: Record<string, number> };
// Full score matrix (DC-corrected, temperature-calibrated, renormalised) → every market read off it,
// so BTTS/team-to-score are proper matrix sums (not the old independent-Poisson product) and all
// probabilities share the same calibration.
function aggregate(lamH: number, lamA: number, N = 10, raw = false): Agg {
  const ph: number[] = [], pa: number[] = [];
  for (let i = 0; i <= N; i++) { ph.push(pois(i, lamH)); pa.push(pois(i, lamA)); }
  // raw = plain Poisson (no calibration temperature) — used for the bookies' implied matrix,
  // which represents THEIR beliefs and must not inherit the model's calibration knob
  const invT = raw ? 1 : 1 / (TEMP || 1);
  const cells: number[][] = [];
  let total = 0;
  for (let i = 0; i <= N; i++) {
    cells[i] = [];
    for (let j = 0; j <= N; j++) {
      let p = Math.max(0, ph[i] * pa[j] * dcTau(i, j, lamH, lamA));
      if (invT !== 1 && p > 0) p = Math.pow(p, invT);
      cells[i][j] = p; total += p;
    }
  }
  let hw = 0, dr = 0, aw = 0, btts = 0, homeScore = 0, awayScore = 0, hwNil = 0, awNil = 0;
  const totalP = new Array(2 * N + 1).fill(0);
  const marg = new Array(2 * N + 1).fill(0);
  const hDist = new Array(N + 1).fill(0); // per-team goal marginals — price team-total lines
  const aDist = new Array(N + 1).fill(0);
  const early: Record<string, number> = {};
  for (const k of EARLY_KEYS) early[k] = 0;
  for (let i = 0; i <= N; i++) for (let j = 0; j <= N; j++) {
    const p = cells[i][j] / total;
    if (i > j) hw += p; else if (i === j) dr += p; else aw += p;
    if (i > 0 && j > 0) btts += p;
    if (i > 0) homeScore += p;
    if (j > 0) awayScore += p;
    if (i > 0 && j === 0) hwNil += p; // win-to-nil needs the joint, so tally it here
    if (j > 0 && i === 0) awNil += p;
    totalP[i + j] += p;
    marg[i - j + N] += p;
    hDist[i] += p;
    aDist[j] += p;
    for (const k of EARLY_KEYS) early[k] += p * earlyCell(k, i, j);
  }
  return { hw, dr, aw, totalP, homeScore, awayScore, btts, marg, hDist, aDist, hwNil, awNil, early };
}
const overP = (agg: Agg, line: number) => { let s = 0; for (let t = 0; t < agg.totalP.length; t++) if (t > line) s += agg.totalP[t]; return s; };
// bet_value range grammar shared with the settlement grader: "2-3", "4+", bare "2"
function parseRange(val: string | null | undefined): [number, number] | null {
  if (!val) return null;
  const s = String(val).trim();
  let m = s.match(/^(\d+)\s*-\s*(\d+)$/); if (m) return [Number(m[1]), Number(m[2])];
  m = s.match(/^(\d+)\s*\+$/); if (m) return [Number(m[1]), 99];
  m = s.match(/^(\d+)$/); if (m) return [Number(m[1]), Number(m[1])];
  return null;
}
function rangeProb(dist: number[], val: string | null | undefined): number | null {
  const r = parseRange(val); if (!r) return null;
  let s = 0; for (let n = 0; n < dist.length; n++) if (n >= r[0] && n <= r[1]) s += dist[n];
  return s;
}
function modelProb(mk: string, side: string | null, line: number | null, agg: Agg, val?: string | null): number | null {
  switch (mk) {
    case "home_win": return agg.hw;
    case "away_win": return agg.aw;
    case "draw": return agg.dr;
    case "result_1x2": return side === "home" ? agg.hw : side === "away" ? agg.aw : agg.dr;
    case "double_chance_1x": return agg.hw + agg.dr;
    case "double_chance_x2": return agg.dr + agg.aw;
    case "double_chance_12": return agg.hw + agg.aw;
    case "over_0_5": return overP(agg, 0.5);
    case "over_1_5": return overP(agg, 1.5);
    case "over_2_5": return overP(agg, 2.5);
    case "over_3_5": return overP(agg, 3.5);
    case "under_2_5": return 1 - overP(agg, 2.5);
    case "under_3_5": return 1 - overP(agg, 3.5);
    case "total_goals_ou": return line == null ? null : (side === "over" ? overP(agg, line) : 1 - overP(agg, line));
    case "btts": return side === "no" ? 1 - agg.btts : agg.btts;
    case "home_to_score": return agg.homeScore;
    case "away_to_score": return agg.awayScore;
    case "home_goals_ou":
    case "away_goals_ou": {
      if (line == null) return null;
      const dist = mk === "home_goals_ou" ? agg.hDist : agg.aDist;
      let over = 0;
      for (let n = 0; n < dist.length; n++) if (n > line) over += dist[n];
      return side === "under" ? 1 - over : over;
    }
    case "dnb": { // draw-no-bet: win prob conditioned on no draw
      const d = agg.hw + agg.aw;
      if (d <= 0) return null;
      return side === "away" ? agg.aw / d : agg.hw / d;
    }
    case "odd_even": {
      let odd = 0; for (let t = 1; t < agg.totalP.length; t += 2) odd += agg.totalP[t];
      return side === "even" ? 1 - odd : odd;
    }
    case "home_odd_even":
    case "away_odd_even": {
      const dist = mk === "home_odd_even" ? agg.hDist : agg.aDist;
      let odd = 0; for (let n = 1; n < dist.length; n += 2) odd += dist[n];
      return side === "even" ? 1 - odd : odd;
    }
    case "exact_goals": {
      const n = parseRange(val)?.[0] ?? (line != null ? Math.round(line) : null);
      return n == null ? null : (agg.totalP[n] ?? 0);
    }
    case "goal_range": case "multigoals": return rangeProb(agg.totalP, val);
    case "home_goal_range": case "home_multigoals": return rangeProb(agg.hDist, val);
    case "away_goal_range": case "away_multigoals": return rangeProb(agg.aDist, val);
    case "home_clean_sheet": { const p = agg.aDist[0]; return side === "no" ? 1 - p : p; }
    case "away_clean_sheet": { const p = agg.hDist[0]; return side === "no" ? 1 - p : p; }
    case "home_win_to_nil": return agg.hwNil;
    case "away_win_to_nil": return agg.awNil;
    case "home_win_1up": case "away_win_1up": case "home_win_2up": case "away_win_2up":
    case "home_win_never_down": case "away_win_never_down":
    case "double_chance_1x_1up": case "double_chance_x2_1up":
      return agg.early[mk] ?? null;
    case "handicap": {
      if (line == null || !side) return null;
      const N = (agg.marg.length - 1) / 2;
      let s = 0;
      for (let d = -N; d <= N; d++) {
        const win = side === "home" ? (d + line) > 0 : (line - d) > 0;
        if (win) s += agg.marg[d + N];
      }
      return s;
    }
    default: return null;
  }
}

function oddOf(bet: any, value: string): number | null {
  const v = (bet?.values ?? []).find((z: any) => String(z.value).toLowerCase() === value.toLowerCase());
  return v ? Number(v.odd) : null;
}
function threeWay(bet: any): { home: number; draw: number; away: number } | null {
  const h = oddOf(bet, "Home"), d = oddOf(bet, "Draw"), a = oddOf(bet, "Away");
  if (!h || !d || !a) return null;
  const ih = 1 / h, id = 1 / d, ia = 1 / a, s = ih + id + ia;
  return { home: ih / s, draw: id / s, away: ia / s };
}
function twoWay(bet: any, yes: string, no: string): number | null {
  const y = oddOf(bet, yes), n = oddOf(bet, no);
  if (!y || !n) return null;
  const iy = 1 / y, ino = 1 / n;
  return iy / (iy + ino);
}
function ouProb(bet: any, line: number, sideWant: "over" | "under"): number | null {
  if (!bet) return null;
  const o = oddOf(bet, `Over ${line}`), u = oddOf(bet, `Under ${line}`);
  if (!o || !u) return null;
  const io = 1 / o, iu = 1 / u;
  const over = io / (io + iu);
  return sideWant === "over" ? over : 1 - over;
}
// period → API-Football bet id, per market group. null = that market isn't quoted for the period.
const P_ID = {
  x1x2: { ft: 1, "1h": 13, "2h": 3 },
  dc: { ft: 12, "1h": 20, "2h": 33 },
  totals: { ft: 5, "1h": 6, "2h": 26 },
  homeTotal: { ft: 16, "1h": 105, "2h": 107 },
  awayTotal: { ft: 17, "1h": 106, "2h": 108 },
  btts: { ft: 8, "1h": 34, "2h": 35 },
  ah: { ft: 4, "1h": 19, "2h": null },
  oddEven: { ft: 21, "1h": 22, "2h": 63 },
  dnb: { ft: null, "1h": 109, "2h": 182 }, // FT DNB derived from 1X2 instead
  corners: { ft: 45, "1h": 77, "2h": 127 },
} as const;
type Period = "ft" | "1h" | "2h";
function bookProb(mk: string, side: string | null, line: number | null, bets: any[], period: Period = "ft"): number | null {
  const bet = (id: number | null) => (id == null ? undefined : bets.find((b) => Number(b.id) === id));
  const ftOnly = (id: number) => (period === "ft" ? bet(id) : undefined);
  // Double chance from the book's OWN double-chance market when quoted — the three DC probs sum
  // to 2, so de-vig by scaling the inverse odds to that. Falls back to deriving from 1X2.
  const dc = (want: "1x" | "12" | "x2"): number | null => {
    const bdc = bet(P_ID.dc[period]);
    if (bdc) {
      const hd = oddOf(bdc, "Home/Draw"), ha = oddOf(bdc, "Home/Away"), da = oddOf(bdc, "Draw/Away");
      if (hd && ha && da) {
        const s = 1 / hd + 1 / ha + 1 / da;
        const p = (want === "1x" ? 1 / hd : want === "12" ? 1 / ha : 1 / da) * (2 / s);
        return Math.min(1, p);
      }
    }
    const t = threeWay(bet(P_ID.x1x2[period]));
    return t ? Math.min(1, want === "1x" ? t.home + t.draw : want === "12" ? t.home + t.away : t.draw + t.away) : null;
  };
  switch (mk) {
    case "home_win": { const t = threeWay(bet(P_ID.x1x2[period])); return t ? t.home : null; }
    case "away_win": { const t = threeWay(bet(P_ID.x1x2[period])); return t ? t.away : null; }
    case "draw": { const t = threeWay(bet(P_ID.x1x2[period])); return t ? t.draw : null; }
    case "result_1x2": { const t = threeWay(bet(P_ID.x1x2[period])); return t ? (side === "home" ? t.home : side === "away" ? t.away : t.draw) : null; }
    case "double_chance_1x": return dc("1x");
    case "double_chance_x2": return dc("x2");
    case "double_chance_12": return dc("12");
    case "dnb": {
      const b = bet(P_ID.dnb[period]);
      if (b) { const p = twoWay(b, "Home", "Away"); return p == null ? null : (side === "away" ? 1 - p : p); }
      if (period !== "ft") return null;
      const t = threeWay(bet(1));
      if (!t) return null;
      const p = t.home / (t.home + t.away);
      return side === "away" ? 1 - p : p;
    }
    case "handicap": {
      // Asian Handicap: the picked side at line L vs the other side at −L, de-vigged as a pair
      if (line == null || (side !== "home" && side !== "away")) return null;
      const b4 = bet(P_ID.ah[period]);
      if (!b4) return null;
      const sgn = (x: number) => (x > 0 ? `+${x}` : `${x}`);
      const mine = oddOf(b4, `${side === "home" ? "Home" : "Away"} ${sgn(line)}`);
      const theirs = oddOf(b4, `${side === "home" ? "Away" : "Home"} ${sgn(-line)}`);
      if (!mine || !theirs) return null;
      const im = 1 / mine, it = 1 / theirs;
      return im / (im + it);
    }
    case "over_0_5": return ouProb(bet(P_ID.totals[period]), 0.5, "over");
    case "over_1_5": return ouProb(bet(P_ID.totals[period]), 1.5, "over");
    case "over_2_5": return ouProb(bet(P_ID.totals[period]), 2.5, "over");
    case "over_3_5": return ouProb(bet(P_ID.totals[period]), 3.5, "over");
    case "under_2_5": return ouProb(bet(P_ID.totals[period]), 2.5, "under");
    case "under_3_5": return ouProb(bet(P_ID.totals[period]), 3.5, "under");
    case "total_goals_ou": return line == null ? null : ouProb(bet(P_ID.totals[period]), line, side === "under" ? "under" : "over");
    case "btts": { const p = twoWay(bet(P_ID.btts[period]), "Yes", "No"); return p == null ? null : (side === "no" ? 1 - p : p); }
    case "home_to_score": return period === "ft" ? twoWay(bet(43), "Yes", "No") : null;
    case "away_to_score": return period === "ft" ? twoWay(bet(44), "Yes", "No") : null;
    case "home_goals_ou": return line == null ? null : ouProb(bet(P_ID.homeTotal[period]), line, side === "under" ? "under" : "over");
    case "away_goals_ou": return line == null ? null : ouProb(bet(P_ID.awayTotal[period]), line, side === "under" ? "under" : "over");
    case "odd_even": { const p = twoWay(bet(P_ID.oddEven[period]), "Odd", "Even"); return p == null ? null : (side === "even" ? 1 - p : p); }
    case "home_odd_even": { const p = twoWay(ftOnly(23), "Odd", "Even"); return p == null ? null : (side === "even" ? 1 - p : p); }
    case "away_odd_even": { const p = twoWay(ftOnly(60), "Odd", "Even"); return p == null ? null : (side === "even" ? 1 - p : p); }
    case "home_clean_sheet": { const p = twoWay(ftOnly(27), "Yes", "No"); return p == null ? null : (side === "no" ? 1 - p : p); }
    case "away_clean_sheet": { const p = twoWay(ftOnly(28), "Yes", "No"); return p == null ? null : (side === "no" ? 1 - p : p); }
    case "home_win_to_nil": return twoWay(ftOnly(29), "Yes", "No");
    case "away_win_to_nil": return twoWay(ftOnly(30), "Yes", "No");
    case "corners_ou": return line == null ? null : ouProb(bet(P_ID.corners[period]), line, side === "under" ? "under" : "over");
    case "home_corners_ou": return line == null ? null : ouProb(ftOnly(57), line, side === "under" ? "under" : "over");
    case "away_corners_ou": return line == null ? null : ouProb(ftOnly(58), line, side === "under" ? "under" : "over");
    case "corners_1x2": { const t = threeWay(ftOnly(55)); return t ? (side === "home" ? t.home : side === "away" ? t.away : t.draw) : null; }
    case "cards_ou": return line == null ? null : ouProb(ftOnly(80), line, side === "under" ? "under" : "over");
    case "home_cards_ou": return line == null ? null : ouProb(ftOnly(82), line, side === "under" ? "under" : "over");
    case "away_cards_ou": return line == null ? null : ouProb(ftOnly(83), line, side === "under" ? "under" : "over");
    default: return null;
  }
}
function marketProb(mk: string, side: string | null, line: number | null, bookmakers: any[], period: Period = "ft"): number | null {
  const ps: number[] = [];
  for (const bm of bookmakers) { const p = bookProb(mk, side, line, bm.bets ?? [], period); if (p != null && p > 0 && p < 1) ps.push(p); }
  if (!ps.length) return null;
  return ps.reduce((a, b) => a + b, 0) / ps.length;
}
// ---------- displayed price for a delivered pick (waterfall: quoted → derived → model) ----------
// Users want to SEE the odds on every pick, even markets the books don't quote. Three tiers, most
// trustworthy first: (1) "quoted" — the real median decimal odd when the exact selection is directly
// listed; (2) "derived" — a fair (de-vigged) odd from the market probability the engine already
// de-margined off related quotes (e.g. a DC price implied by the 1X2 the books DO quote); (3)
// "model" — a fair odd from the model's own probability when there are no odds at all. DISPLAY-ONLY:
// this never feeds selection, edge, grading or settlement — those still run exactly as before.
function selectionOdd(mk: string, side: string | null, line: number | null, bets: any[], period: Period): number | null {
  const bet = (id: number | null) => (id == null ? undefined : bets.find((b) => Number(b.id) === id));
  const ftOnly = (id: number) => (period === "ft" ? bet(id) : undefined);
  const ou = (b: any) => (line == null ? null : oddOf(b, `${side === "under" ? "Under" : "Over"} ${line}`));
  switch (mk) {
    case "home_win": return oddOf(bet(P_ID.x1x2[period]), "Home");
    case "away_win": return oddOf(bet(P_ID.x1x2[period]), "Away");
    case "draw": return oddOf(bet(P_ID.x1x2[period]), "Draw");
    case "result_1x2": return oddOf(bet(P_ID.x1x2[period]), side === "home" ? "Home" : side === "away" ? "Away" : "Draw");
    case "double_chance_1x": return oddOf(bet(P_ID.dc[period]), "Home/Draw");
    case "double_chance_x2": return oddOf(bet(P_ID.dc[period]), "Draw/Away");
    case "double_chance_12": return oddOf(bet(P_ID.dc[period]), "Home/Away");
    case "over_0_5": return oddOf(bet(P_ID.totals[period]), "Over 0.5");
    case "over_1_5": return oddOf(bet(P_ID.totals[period]), "Over 1.5");
    case "over_2_5": return oddOf(bet(P_ID.totals[period]), "Over 2.5");
    case "over_3_5": return oddOf(bet(P_ID.totals[period]), "Over 3.5");
    case "under_2_5": return oddOf(bet(P_ID.totals[period]), "Under 2.5");
    case "under_3_5": return oddOf(bet(P_ID.totals[period]), "Under 3.5");
    case "total_goals_ou": return ou(bet(P_ID.totals[period]));
    case "btts": return oddOf(bet(P_ID.btts[period]), side === "no" ? "No" : "Yes");
    case "home_to_score": return period === "ft" ? oddOf(bet(43), "Yes") : null;
    case "away_to_score": return period === "ft" ? oddOf(bet(44), "Yes") : null;
    case "home_goals_ou": return ou(bet(P_ID.homeTotal[period]));
    case "away_goals_ou": return ou(bet(P_ID.awayTotal[period]));
    case "corners_ou": return ou(bet(P_ID.corners[period]));
    case "home_corners_ou": return ou(ftOnly(57));
    case "away_corners_ou": return ou(ftOnly(58));
    case "cards_ou": return ou(ftOnly(80));
    case "home_cards_ou": return ou(ftOnly(82));
    case "away_cards_ou": return ou(ftOnly(83));
    default: return null;
  }
}
function bookOdd(mk: string, side: string | null, line: number | null, bms: any[], period: Period): number | null {
  const os: number[] = [];
  for (const bm of bms) { const o = selectionOdd(mk, side, line, bm.bets ?? [], period); if (o != null && o > 1) os.push(o); }
  if (!os.length) return null;
  os.sort((a, b) => a - b);
  return os[Math.floor(os.length / 2)]; // median across books
}
type Price = { odd: number; src: "quoted" | "derived" | "model" };
function priceOf(mk: string, side: string | null, line: number | null, bms: any[], period: Period, modelProb: number | null, marketProb: number | null): Price | null {
  const r2 = (x: number) => Math.round(x * 100) / 100;
  const raw = bookOdd(mk, side, line, bms, period);
  if (raw != null) return { odd: r2(raw), src: "quoted" };
  if (marketProb != null && marketProb > 0.01 && marketProb < 0.995) return { odd: r2(1 / marketProb), src: "derived" };
  if (modelProb != null && modelProb > 0.01 && modelProb < 0.995) return { odd: r2(1 / modelProb), src: "model" };
  return null;
}
// ---------- market-implied pricing for EVERY goals-derived market the books don't quote ----------
// Books quote 1X2 (+ over 2.5) for nearly every priced game, and those numbers pin down THEIR
// implied goal rates. Fit lamH/lamA to reproduce them, rebuild the bookies' score matrix, and any
// matrix-derived market — 1UP/2UP/Never Down, goal ranges, exact goals, clean sheets, win to nil,
// odd/even, team totals, halves — can be priced off it with the SAME maths the model uses, so edge
// stays a genuine model-vs-market comparison even where the specific bet was never offered.
const marketLamCache = new Map<string, { lh: number; la: number } | null>();
function plainProbs(lh: number, la: number, N = 10): { hw: number; aw: number; over25: number } {
  const ph: number[] = [], pa: number[] = [];
  for (let k = 0; k <= N; k++) { ph.push(pois(k, lh)); pa.push(pois(k, la)); }
  let hw = 0, aw = 0, over25 = 0, total = 0;
  for (let i = 0; i <= N; i++) for (let j = 0; j <= N; j++) {
    const p = ph[i] * pa[j];
    total += p;
    if (i > j) hw += p; else if (j > i) aw += p;
    if (i + j >= 3) over25 += p;
  }
  return { hw: hw / total, aw: aw / total, over25: over25 / total };
}
function fitLams(hwT: number, awT: number, o25T: number | null): { lh: number; la: number } | null {
  let best: { lh: number; la: number } | null = null;
  let bestE = Infinity;
  const scan = (l0: number, l1: number, a0: number, a1: number, step: number) => {
    for (let lh = l0; lh <= l1; lh += step) for (let la = a0; la <= a1; la += step) {
      const r = plainProbs(lh, la);
      let e = (r.hw - hwT) ** 2 + (r.aw - awT) ** 2;
      if (o25T != null) e += 0.5 * (r.over25 - o25T) ** 2;
      if (e < bestE) { bestE = e; best = { lh, la }; }
    }
  };
  scan(0.2, 3.6, 0.2, 3.6, 0.2);
  if (best) scan(Math.max(0.1, best.lh - 0.2), best.lh + 0.2, Math.max(0.1, best.la - 0.2), best.la + 0.2, 0.05);
  return best && bestE < 0.01 ? best : null; // reject when no lambda pair reproduces the odds
}
function marketLams(bms: any[]): { lh: number; la: number } | null {
  const hw = marketProb("home_win", "home", null, bms), aw = marketProb("away_win", "away", null, bms);
  if (hw == null || aw == null) return null;
  const o25 = marketProb("total_goals_ou", "over", 2.5, bms);
  const ck = `${hw.toFixed(3)}|${aw.toFixed(3)}|${o25?.toFixed(3) ?? "x"}`;
  let lam = marketLamCache.get(ck);
  if (lam === undefined) { lam = fitLams(hw, aw, o25); marketLamCache.set(ck, lam); }
  return lam;
}
// bookies' implied matrix for a period (lams are grid-quantised, so this cache stays small)
const marketAggCache = new Map<string, Agg>();
function marketAggFor(lam: { lh: number; la: number }, share: number): Agg {
  const ck = `${lam.lh}|${lam.la}|${share}`;
  let a = marketAggCache.get(ck);
  if (!a) { a = aggregate(lam.lh * share, lam.la * share, 10, true); marketAggCache.set(ck, a); }
  return a;
}

type Rate = { gf: number; ga: number; n: number }; // time-decay-weighted LEAGUE-RELATIVE ratio sums
type TeamRates = { home: Rate; away: Rate; all: Rate }; // venue split + overall (blended by VENUE_WEIGHT)
type Model = { lHome: Map<number, number>; lAway: Map<number, number>; gHome: number; gAway: number; team: Map<number, TeamRates>; elo: Map<number, number>; eloT: Map<number, number>; tierSeed: Map<number, number> };
// ---- tier-seeded Elo (ADMIN PILOT, dc_1x/x2 only) ----------------------------------------------
// Cup/cross-division fixtures are where flat-1500 Elo is blind: a lower-league side that only ever
// appears in cup draws carries the same starting rating as the top-flight opponent. The pilot arm
// seeds starting Elo by league tier (top ±X/2) and penalises cup-only teams (−Y). X=240/Y=160 were
// fitted walk-forward on 2024-08→2025-07 cross-tier cup ties (perf/backtest-tier.mts: slice
// log-loss −31%, overall unchanged). Served ONLY to admin agents on double_chance_1x/x2; every
// such delivery is stamped criteria.model_ver="tier_v1" so its record never mixes with v2's.
const TIER_SPLIT = 120, TIER_CUPONLY = 160; // Elo points: ±split for tier 1/2, −cuponly for tier 3
const TIER_CUP_RE = /\b(cup|pokal|cupen|beker|copa|coppa|coupe|ta[çc]a|karika[s]?|kup[a]?|puchar|poh[áa]r|trophy|shield)\b/i;
const TIER_FRIENDLY_RE = /friendl/i;
// Build ratings from finished fixtures (two passes). Pass 1: time-decayed goal means per league +
// global, so pass 2 can normalise every match by the league it was PLAYED in — the cross-league fix
// (an Estonian side's domestic goals no longer read against the UEFA-competition mean). Pass 2:
// margin/home-adjusted Elo (chronological) + league-relative attack/defence ratios, venue-split AND
// overall. Elo doubles as the shrinkage prior for thin-data teams. Most recent ~40k in-scope results.
async function buildModel(leagueIds: number[]): Promise<Model> {
  const team = new Map<number, TeamRates>();
  const elo = new Map<number, number>();
  const eloT = new Map<number, number>();
  const tierSeed = new Map<number, number>();
  const lHomeSum = new Map<number, [number, number]>();
  const lAwaySum = new Map<number, [number, number]>();
  let gh = 0, ghn = 0, ga = 0, gan = 0;
  if (leagueIds.length) {
    // PostgREST caps every response at 1000 rows regardless of .limit(), so a single .limit(40000)
    // silently returned only 1000 finished fixtures -> across many leagues every team was starved of
    // history, NOTHING was ever "confident", and every pick came out unpriced. Page in 1000-row
    // chunks (recency-bounded) to actually load the model.
    const PAGE = 1000, MAX_ROWS = 40000;
    const sinceIso = new Date(Date.now() - 365 * 86400000).toISOString();
    const acc: any[] = [];
    for (let off = 0; off < MAX_ROWS; off += PAGE) {
      const { data, error } = await sb.from("fixtures")
        .select("id,league_id,home_team_id,away_team_id,ft_home,ft_away,home_goals,away_goals,kickoff_utc")
        .in("league_id", leagueIds).in("status", FINISHED).gte("kickoff_utc", sinceIso)
        .order("kickoff_utc", { ascending: false }).order("id", { ascending: false })
        .range(off, off + PAGE - 1);
      if (error || !data || !data.length) break;
      acc.push(...data);
      if (data.length < PAGE) break;
    }
    // xG per fixture (xg_v1, backtested 2026-08-29: walk-forward on 184K matches, α=1.0 fitted on
    // May-June and held out on July-Aug — 1X2 log-loss −0.47% on xG-covered fixtures, −0.09%
    // overall, O/U flat). Where the provider recorded xG, the attack/defence RATES learn from it
    // instead of the scoreline (chance quality over luck); Elo and the league goal means stay on
    // actual goals — Elo measures who won, the means keep lambdas calibrated to real scorelines.
    const xgMap = new Map<number, [number, number]>();
    try {
      for (let off = 0; off < 20000; off += 1000) {
        const { data: xr, error: xe } = await sb.from("fixture_stats")
          .select("fixture_id,xg:stats->expected_goals")
          .not("stats->expected_goals", "is", null)
          .order("fixture_id", { ascending: true })
          .range(off, off + 999);
        if (xe || !xr?.length) break;
        for (const r of xr as any[]) {
          const x = r.xg;
          if (Array.isArray(x) && x.length === 2 && (Number(x[0]) > 0 || Number(x[1]) > 0)) {
            xgMap.set(Number(r.fixture_id), [Number(x[0]), Number(x[1])]);
          }
        }
        if (xr.length < 1000) break;
      }
    } catch { /* xG-less build degrades to goals-only — never blocks a run */ }
    const rows = acc.slice().sort((a: any, b: any) => Date.parse(a.kickoff_utc) - Date.parse(b.kickoff_utc));
    const now = rows.length ? Date.parse(rows[rows.length - 1].kickoff_utc) : Date.now();
    const decay = Math.LN2 / (HALF_LIFE_DAYS * 86400000);
    // PASS 1 — time-decayed league + global goal means
    for (const f of rows) {
      const hg = f.ft_home ?? f.home_goals, ag2 = f.ft_away ?? f.away_goals;
      if (hg == null || ag2 == null || f.home_team_id == null || f.away_team_id == null) continue;
      const w = Math.exp(-decay * (now - Date.parse(f.kickoff_utc)));
      const lh = lHomeSum.get(f.league_id) ?? [0, 0]; lh[0] += hg * w; lh[1] += w; lHomeSum.set(f.league_id, lh);
      const la = lAwaySum.get(f.league_id) ?? [0, 0]; la[0] += ag2 * w; la[1] += w; lAwaySum.set(f.league_id, la);
      gh += hg * w; ghn += w; ga += ag2 * w; gan += w;
    }
    const ghMean = ghn > 0 ? gh / ghn : DEF_HOME, gaMean = gan > 0 ? ga / gan : DEF_AWAY;
    // small-league means lean on the global mean until they have LEAGUE_SHRINK matches of their own
    const meanOf = (m: Map<number, [number, number]>, lg: number, g: number) => {
      const e = m.get(lg); const n = e?.[1] ?? 0;
      return Math.max(0.1, n + LEAGUE_SHRINK > 0 ? ((e?.[0] ?? 0) + g * LEAGUE_SHRINK) / (n + LEAGUE_SHRINK) : g);
    };
    // tier seeds for the pilot Elo arm: numeric tier per league from leagues.tier, then each
    // team's tier from where it actually played inside this model window (walk-forward safe —
    // the window itself is history). Cup-only teams (≥2 apps, never in a non-cup competition)
    // are treated as lower-league cup entrants.
    try {
      const lgMeta = new Map<number, { numTier: number | null; cup: boolean }>();
      for (let off = 0; off < 3000; off += 1000) {
        const { data: lgs, error: lgErr } = await sb.from("leagues").select("id,name,tier,type").range(off, off + 999);
        if (lgErr || !lgs?.length) break;
        for (const l of lgs) {
          const friendly = TIER_FRIENDLY_RE.test(l.name ?? "");
          lgMeta.set(l.id, {
            numTier: l.tier === "top" || l.tier === "sa_top" || l.tier === "as_top" ? 1 : l.tier === "mid" ? 2 : null,
            cup: !friendly && (l.type === "Cup" || TIER_CUP_RE.test(l.name ?? "")),
          });
        }
        if (lgs.length < 1000) break;
      }
      const tierCnt = new Map<number, { t1: number; t2: number; total: number; nonCup: number }>();
      for (const f of rows) {
        const m = lgMeta.get(f.league_id);
        if (!m) continue;
        for (const id of [f.home_team_id, f.away_team_id]) {
          if (id == null) continue;
          const c = tierCnt.get(id) ?? { t1: 0, t2: 0, total: 0, nonCup: 0 };
          c.total++; if (!m.cup) c.nonCup++;
          if (m.numTier === 1) c.t1++; else if (m.numTier === 2) c.t2++;
          tierCnt.set(id, c);
        }
      }
      for (const [id, c] of tierCnt) {
        if (c.t1 + c.t2 >= 5) tierSeed.set(id, c.t1 >= c.t2 ? ELO_BASE + TIER_SPLIT : ELO_BASE - TIER_SPLIT);
        else if (c.total >= 2 && c.nonCup === 0) tierSeed.set(id, ELO_BASE - TIER_CUPONLY);
      }
    } catch { /* seedless pilot arm degrades to the base model — never blocks a run */ }
    // PASS 2 — Elo + league-relative ratios (venue + overall)
    const getElo = (id: number) => elo.get(id) ?? ELO_BASE;
    const getEloT = (id: number) => eloT.get(id) ?? tierSeed.get(id) ?? ELO_BASE;
    const newRates = (): TeamRates => ({ home: { gf: 0, ga: 0, n: 0 }, away: { gf: 0, ga: 0, n: 0 }, all: { gf: 0, ga: 0, n: 0 } });
    for (const f of rows) {
      const hg = f.ft_home ?? f.home_goals, ag2 = f.ft_away ?? f.away_goals;
      if (hg == null || ag2 == null || f.home_team_id == null || f.away_team_id == null) continue;
      // Elo update using ratings BEFORE this match (margin- and home-adjusted)
      const rH = getElo(f.home_team_id), rA = getElo(f.away_team_id);
      const exp = 1 / (1 + Math.pow(10, -((rH + HOME_ADV_ELO) - rA) / 400));
      const s = hg > ag2 ? 1 : hg === ag2 ? 0.5 : 0;
      const dr = (rH + HOME_ADV_ELO) - rA;
      const gd = Math.abs(hg - ag2);
      const mult = gd <= 1 ? 1 : Math.log(gd + 1) * (2.2 / (Math.abs(dr) * 0.001 + 2.2));
      const delta = ELO_K * mult * (s - exp);
      elo.set(f.home_team_id, rH + delta); elo.set(f.away_team_id, rA - delta);
      // parallel tier-seeded Elo trajectory (identical update rule, seeded starting ratings)
      const rHT = getEloT(f.home_team_id), rAT = getEloT(f.away_team_id);
      const expT = 1 / (1 + Math.pow(10, -((rHT + HOME_ADV_ELO) - rAT) / 400));
      const drT = (rHT + HOME_ADV_ELO) - rAT;
      const multT = gd <= 1 ? 1 : Math.log(gd + 1) * (2.2 / (Math.abs(drT) * 0.001 + 2.2));
      const deltaT = ELO_K * multT * (s - expT);
      eloT.set(f.home_team_id, rHT + deltaT); eloT.set(f.away_team_id, rAT - deltaT);
      // goals relative to the league THIS match was played in — EFFECTIVE goals where xG exists
      // (α=1.0, the fitted xgWeight: pure chance quality; see the xgMap note above)
      const xgF = xgMap.get(f.id);
      const effH = xgF ? xgF[0] : hg, effA = xgF ? xgF[1] : ag2;
      const w = Math.exp(-decay * (now - Date.parse(f.kickoff_utc)));
      const mh = meanOf(lHomeSum, f.league_id, ghMean), ma = meanOf(lAwaySum, f.league_id, gaMean);
      const nh = effH / mh, na = effA / ma;
      const h = team.get(f.home_team_id) ?? newRates();
      h.home.gf += nh * w; h.home.ga += na * w; h.home.n += w;
      h.all.gf += nh * w; h.all.ga += na * w; h.all.n += w;
      team.set(f.home_team_id, h);
      const a = team.get(f.away_team_id) ?? newRates();
      a.away.gf += na * w; a.away.ga += nh * w; a.away.n += w;
      a.all.gf += na * w; a.all.ga += nh * w; a.all.n += w;
      team.set(f.away_team_id, a);
    }
    const lHome = new Map<number, number>(), lAway = new Map<number, number>();
    for (const [lg] of lHomeSum) lHome.set(lg, meanOf(lHomeSum, lg, ghMean));
    for (const [lg] of lAwaySum) lAway.set(lg, meanOf(lAwaySum, lg, gaMean));
    return { lHome, lAway, gHome: ghMean, gAway: gaMean, team, elo, eloT, tierSeed };
  }
  return { lHome: new Map(), lAway: new Map(), gHome: DEF_HOME, gAway: DEF_AWAY, team, elo, eloT, tierSeed };
}
function lambdas(m: Model, f: Fixture, useTier = false): { lamH: number; lamA: number; confident: boolean } {
  // the current fixture's league scoring environment (already shrunk toward global; floored vs NaN)
  const leagueHome = Math.max(0.1, m.lHome.get(f.league_id) ?? m.gHome);
  const leagueAway = Math.max(0.1, m.lAway.get(f.league_id) ?? m.gAway);
  // Elo → attack/defence prior (relative to an average team); the shrinkage TARGET so a team with
  // few recent games leans on Elo instead of a neutral 1.0. The tier arm reads the seeded
  // trajectory — for a team with no window history at all, the seed itself IS the prior.
  const eloOf = (id: number | null) => (id != null
    ? (useTier ? (m.eloT.get(id) ?? m.tierSeed.get(id)) : m.elo.get(id))
    : undefined) ?? ELO_BASE;
  const attPrior = (id: number | null) => Math.exp((eloOf(id) - ELO_BASE) / ELO_PER_LOG_GOAL);
  const defPrior = (id: number | null) => Math.exp(-(eloOf(id) - ELO_BASE) / ELO_PER_LOG_GOAL);
  const H = f.home_team_id != null ? m.team.get(f.home_team_id) : undefined;
  const A = f.away_team_id != null ? m.team.get(f.away_team_id) : undefined;
  // venue record and overall record are each shrunk toward the Elo prior with their OWN sample
  // size, then blended by VENUE_WEIGHT (ratios are league-relative, so this is cross-league safe)
  const shrink = (raw: number, n: number, prior: number) => (raw * n + prior * SHRINK) / (n + SHRINK);
  const blend = (venue: Rate | undefined, all: Rate | undefined, pick: (x: Rate) => number, prior: number) => {
    const vn = venue?.n ?? 0, an = all?.n ?? 0;
    const v = shrink(vn > 0 ? pick(venue!) / vn : prior, vn, prior);
    const o = shrink(an > 0 ? pick(all!) / an : prior, an, prior);
    return VENUE_WEIGHT * v + (1 - VENUE_WEIGHT) * o;
  };
  const homeAtt = blend(H?.home, H?.all, (x) => x.gf, attPrior(f.home_team_id));
  const homeDef = blend(H?.home, H?.all, (x) => x.ga, defPrior(f.home_team_id));
  const awayAtt = blend(A?.away, A?.all, (x) => x.gf, attPrior(f.away_team_id));
  const awayDef = blend(A?.away, A?.all, (x) => x.ga, defPrior(f.away_team_id));
  const clamp = (x: number) => Math.max(0.15, Math.min(6, x));
  const confident = (H?.all.n ?? 0) >= MIN_TEAM_MATCHES && (A?.all.n ?? 0) >= MIN_TEAM_MATCHES;
  return { lamH: clamp(leagueHome * homeAtt * awayDef), lamA: clamp(leagueAway * awayAtt * homeDef), confident };
}
// ---------- corners/cards stat models (fed by the collect-stats pipeline) ----------
// Same shape as the goals model but lighter: league home/away means + per-team for/against ratios
// (decayed, shrunk toward neutral). fixture_stats only holds what the collector/poll captured, so
// the model self-activates per team as data accrues — under STAT_MIN_N matches a fixture's stat
// markets simply stay unpriced (the mix fallback), exactly the pre-model behaviour.
const STAT_SHRINK = 6, STAT_MIN_N = 3, STAT_HALF_LIFE = 120;
type StatRates = { forr: number; ag: number; n: number };
type StatModel = { lgH: Map<number, number>; lgA: Map<number, number>; gH: number; gA: number; team: Map<number, StatRates> } | null;
async function buildStatModels(): Promise<{ corners: StatModel; cards: StatModel }> {
  const PAGE = 1000, MAX_ROWS = 15000;
  const acc: any[] = [];
  for (let off = 0; off < MAX_ROWS; off += PAGE) {
    const { data, error } = await sb.from("fixture_stats")
      .select("corners_home,corners_away,stats,fixtures!inner(league_id,home_team_id,away_team_id,kickoff_utc,status)")
      .in("fixtures.status", FINISHED)
      .order("fixture_id", { ascending: false })
      .range(off, off + PAGE - 1);
    if (error || !data || !data.length) break;
    acc.push(...data);
    if (data.length < PAGE) break;
  }
  const decay = Math.LN2 / (STAT_HALF_LIFE * 86400000);
  const now = Date.now();
  const build = (get: (r: any) => [number, number] | null): StatModel => {
    const lgHSum = new Map<number, [number, number]>(), lgASum = new Map<number, [number, number]>();
    let gh = 0, ga = 0, gn = 0;
    const rows: { lg: number; h: number; a: number; hid: number; aid: number; w: number }[] = [];
    for (const r of acc) {
      const fx = r.fixtures;
      if (!fx || fx.home_team_id == null || fx.away_team_id == null) continue;
      const v = get(r);
      if (!v) continue;
      const w = Math.exp(-decay * Math.max(0, now - Date.parse(fx.kickoff_utc)));
      rows.push({ lg: fx.league_id, h: v[0], a: v[1], hid: fx.home_team_id, aid: fx.away_team_id, w });
      const lh = lgHSum.get(fx.league_id) ?? [0, 0]; lh[0] += v[0] * w; lh[1] += w; lgHSum.set(fx.league_id, lh);
      const la = lgASum.get(fx.league_id) ?? [0, 0]; la[0] += v[1] * w; la[1] += w; lgASum.set(fx.league_id, la);
      gh += v[0] * w; ga += v[1] * w; gn += w;
    }
    if (gn <= 0) return null;
    const gH = gh / gn, gA = ga / gn;
    // small leagues lean on the global mean (same shrinkage idea as the goals model)
    const mean = (m: Map<number, [number, number]>, lg: number, g: number) => {
      const e = m.get(lg); const n = e?.[1] ?? 0;
      return Math.max(0.1, ((e?.[0] ?? 0) + g * STAT_SHRINK) / (n + STAT_SHRINK));
    };
    const lgH = new Map<number, number>(), lgA = new Map<number, number>();
    for (const [lg] of lgHSum) lgH.set(lg, mean(lgHSum, lg, gH));
    for (const [lg] of lgASum) lgA.set(lg, mean(lgASum, lg, gA));
    const team = new Map<number, StatRates>();
    for (const r of rows) {
      const mh = lgH.get(r.lg) ?? gH, ma = lgA.get(r.lg) ?? gA;
      const H = team.get(r.hid) ?? { forr: 0, ag: 0, n: 0 };
      H.forr += (r.h / mh) * r.w; H.ag += (r.a / ma) * r.w; H.n += r.w; team.set(r.hid, H);
      const A = team.get(r.aid) ?? { forr: 0, ag: 0, n: 0 };
      A.forr += (r.a / ma) * r.w; A.ag += (r.h / mh) * r.w; A.n += r.w; team.set(r.aid, A);
    }
    return { lgH, lgA, gH, gA, team };
  };
  const corners = build((r) => (r.corners_home != null && r.corners_away != null ? [Number(r.corners_home), Number(r.corners_away)] : null));
  const cards = build((r) => {
    const y = r.stats?.["Yellow Cards"];
    if (!Array.isArray(y)) return null;
    const rd = Array.isArray(r.stats?.["Red Cards"]) ? r.stats["Red Cards"] : [0, 0];
    return [Number(y[0] ?? 0) + Number(rd[0] ?? 0), Number(y[1] ?? 0) + Number(rd[1] ?? 0)];
  });
  return { corners, cards };
}
type StatLam = { lh: number; la: number; ok: boolean };
function statLams(m: StatModel, f: Fixture): StatLam | null {
  if (!m) return null;
  const lgH = m.lgH.get(f.league_id) ?? m.gH, lgA = m.lgA.get(f.league_id) ?? m.gA;
  const H = f.home_team_id != null ? m.team.get(f.home_team_id) : undefined;
  const A = f.away_team_id != null ? m.team.get(f.away_team_id) : undefined;
  const sh = (raw: number, n: number) => (raw * n + STAT_SHRINK) / (n + STAT_SHRINK); // shrink toward 1
  const att = (r?: StatRates) => sh(r && r.n > 0 ? r.forr / r.n : 1, r?.n ?? 0);
  const def = (r?: StatRates) => sh(r && r.n > 0 ? r.ag / r.n : 1, r?.n ?? 0);
  const clampL = (x: number) => Math.max(0.3, Math.min(20, x));
  const ok = (H?.n ?? 0) >= STAT_MIN_N && (A?.n ?? 0) >= STAT_MIN_N;
  return { lh: clampL(lgH * att(H) * def(A)), la: clampL(lgA * att(A) * def(H)), ok };
}
const CORNER_MKS = new Set(["corners_ou", "home_corners_ou", "away_corners_ou", "corners_1x2", "corner_range", "home_corner_range", "away_corner_range"]);
const CARD_MKS = new Set(["cards_ou", "home_cards_ou", "away_cards_ou"]);
function statProb(mk: string, side: string | null, line: number | null, val: string | null, lh: number, la: number): number | null {
  const ou = (lam: number) => (line == null ? null : (side === "under" ? 1 - poisOver(lam, line) : poisOver(lam, line)));
  switch (mk) {
    case "corners_ou": case "cards_ou": return ou(lh + la);
    case "home_corners_ou": case "home_cards_ou": return ou(lh);
    case "away_corners_ou": case "away_cards_ou": return ou(la);
    case "corners_1x2": {
      let h = 0, d = 0, a = 0;
      for (let x = 0; x <= 25; x++) for (let y = 0; y <= 25; y++) { const p = pois(x, lh) * pois(y, la); if (x > y) h += p; else if (x === y) d += p; else a += p; }
      const tot = h + d + a;
      if (tot <= 0) return null;
      return side === "home" ? h / tot : side === "away" ? a / tot : d / tot;
    }
    case "corner_range": { let s = 0; const r = parseRange(val); if (!r) return null; for (let k = 0; k <= 30; k++) if (k >= r[0] && k <= r[1]) s += pois(k, lh + la); return s; }
    case "home_corner_range": { let s = 0; const r = parseRange(val); if (!r) return null; for (let k = 0; k <= 30; k++) if (k >= r[0] && k <= r[1]) s += pois(k, lh); return s; }
    case "away_corner_range": { let s = 0; const r = parseRange(val); if (!r) return null; for (let k = 0; k <= 30; k++) if (k >= r[0] && k <= r[1]) s += pois(k, la); return s; }
    default: return null;
  }
}
// Canonical form for the market-catalog keys the builder can emit — users pick ANY outcome in ANY
// order, so specific keys (over_2_5, over_8_5_corners, double_chance…) fold into the generic
// pricers' vocabulary. Unknown keys pass through and simply price as null (= honest fallback).
function canon(mk: string, side: string | null, line: number | null): { mk: string; side: string | null; line: number | null } {
  let m = mk.match(/^(over|under)_(\d)_5$/);
  if (m) return { mk: "total_goals_ou", side: m[1], line: Number(m[2]) + 0.5 };
  m = mk.match(/^(over|under)_(\d+)_5_corners$/);
  if (m) return { mk: "corners_ou", side: m[1], line: Number(m[2]) + 0.5 };
  if (mk === "double_chance") {
    const s = (side ?? "1x").toLowerCase();
    return { mk: s === "x2" ? "double_chance_x2" : s === "12" ? "double_chance_12" : "double_chance_1x", side: s, line: null };
  }
  if (mk === "teams_to_score") return { mk: "btts", side: side ?? "yes", line: null };
  if (mk === "home_no_bet") return { mk: "dnb", side: "away", line: null };
  if (mk === "away_no_bet") return { mk: "dnb", side: "home", line: null };
  // per settlement, draw 2UP/Never-Down are exactly a draw bet — price them as one
  if (mk === "draw_2up" || mk === "draw_never_down") return { mk: "draw", side: "draw", line: null };
  return { mk, side, line };
}
// halves as independently thinned Poissons: goals skew slightly to the 2nd half, corners a bit more
const H1_GOALS = 0.45;
const H1_CORNERS = 0.44;

// P(HT result = side OR FT result = side) — "1st half result or match result" (owner market,
// 2026-08-30). Needs the JOINT of the two checkpoints, not the marginals: exact sum over the two
// independently-thinned half matrices (FT score = 1H + 2H). Works off any FT lambda pair, so the
// model prices it from cell lambdas and the market side derives it from the bookies' fitted
// lambdas (marketLams) — same dual use as every other goals-derived market.
function probHtOrFtLam(lamH: number, lamA: number, side: string | null): number | null {
  if (side !== "home" && side !== "draw" && side !== "away") return null;
  const N = 8; // ≥99.9% of half-goal mass at these lambdas
  const pm = (lam: number) => { const a = [Math.exp(-lam)]; for (let k = 1; k <= N; k++) a[k] = a[k - 1] * lam / k; return a; };
  const ph1 = pm(lamH * H1_GOALS), pa1 = pm(lamA * H1_GOALS);
  const ph2 = pm(lamH * (1 - H1_GOALS)), pa2 = pm(lamA * (1 - H1_GOALS));
  const out = (h: number, a: number) => (h > a ? "home" : a > h ? "away" : "draw");
  let p = 0;
  for (let i = 0; i <= N; i++) for (let j = 0; j <= N; j++) {
    const pht = ph1[i] * pa1[j];
    if (pht < 1e-10) continue;
    if (out(i, j) === side) { p += pht; continue; } // HT leg hit — the whole branch wins
    for (let k = 0; k <= N; k++) for (let l = 0; l <= N; l++) {
      if (out(i + k, j + l) === side) p += pht * ph2[k] * pa2[l];
    }
  }
  return Math.min(0.999, p);
}
// Calibration blend (2026-08-29, validated on 627 settled picks: log-loss 0.5696 model-only /
// 0.5680 market-only / 0.5620 blended; the blend's claimed avg ≈72.4% vs 72.25% actual — the model
// alone claimed 76.9%). The DELIVERED model % is the log-odds midpoint (w=0.5, the flat centre of
// the fitted 0.45-0.60 bowl) of the model prob and the de-vigged market prob. SELECTION IS
// UNTOUCHED — floor/edge/tier/min_edge/ranking still run on the raw model prob, so pick counts
// don't move; only the claim users see (and the band-learning cells) is calibrated. No odds = raw.
const blend50 = (mp: number | null, kp: number | null): number | null => {
  if (mp == null) return null;
  if (kp == null || kp <= 0 || kp >= 1) return mp;
  const c = (x: number) => Math.min(0.99, Math.max(0.01, x));
  const a = Math.sqrt(c(mp) * c(kp)), b = Math.sqrt((1 - c(mp)) * (1 - c(kp)));
  return a / (a + b);
};

// rank on the CAPPED edge so an implausible number can't outrank a genuine one
const rankEdge = (e: number | null) => (e == null ? -1 : Math.min(e, MAX_PLAUSIBLE_EDGE));
function tierOf(edge: number): string {
  if (edge > MAX_PLAUSIBLE_EDGE) return "wide"; // model vs reality, not model vs market — amber
  return edge >= 0.05 ? "elite" : edge >= 0.04 ? "strong" : "wide";
}

const FAMILIES: Record<string, { mk: string; side: string | null; line: number | null; label?: string }[]> = {
  result_best: [
    { mk: "home_win", side: "home", line: null }, { mk: "draw", side: "draw", line: null }, { mk: "away_win", side: "away", line: null },
    { mk: "double_chance_1x", side: "1x", line: null }, { mk: "double_chance_x2", side: "x2", line: null }, { mk: "double_chance_12", side: "12", line: null },
  ],
  dc_best: [
    { mk: "double_chance_1x", side: "1x", line: null }, { mk: "double_chance_x2", side: "x2", line: null }, { mk: "double_chance_12", side: "12", line: null },
  ],
  // "1st half result or match result" typed without a pick — the agent prices all three sides
  // (labels carry the side because all three share one mk, unlike the other families)
  result_1h_or_ft_best: [
    { mk: "result_1h_or_ft", side: "home", line: null, label: "1st half or match result — Home" },
    { mk: "result_1h_or_ft", side: "draw", line: null, label: "1st half or match result — Draw" },
    { mk: "result_1h_or_ft", side: "away", line: null, label: "1st half or match result — Away" },
  ],
  ou_best: [
    { mk: "over_1_5", side: "over", line: 1.5 }, { mk: "over_2_5", side: "over", line: 2.5 }, { mk: "over_3_5", side: "over", line: 3.5 },
    { mk: "under_2_5", side: "under", line: 2.5 }, { mk: "under_3_5", side: "under", line: 3.5 },
  ],
  handicap_best: [
    { mk: "handicap", side: "home", line: -1.5 }, { mk: "handicap", side: "home", line: -0.5 }, { mk: "handicap", side: "home", line: 0.5 },
    { mk: "handicap", side: "away", line: -1.5 }, { mk: "handicap", side: "away", line: -0.5 }, { mk: "handicap", side: "away", line: 0.5 },
  ],
};
const isFamily = (mk: string) => Object.prototype.hasOwnProperty.call(FAMILIES, mk);
function handicapLabel(side: string | null, line: number | null): string {
  return `Handicap ${side ?? ""} ${line != null && line > 0 ? "+" : ""}${line ?? ""}`.trim();
}

// Quick-spec "quiet" run (the acca generator): explicit strategy_id + quiet:true in the body.
// One isolate serves one request, so a module flag is safe. Effects: no push/telegram noise,
// a wide per-run room (the pool must feed up to 24-leg slips), and the free plan's
// monthly-delivery-days wall yields — the quickrun quota governs quiet spend instead.
let QUIET_RUN = false;
// Paper mode (owner-directed 2026-09-02): the demo-owned "📄 Paper ·" draft strategies bet the
// common markets daily so the proven-rules library grows its samples without waiting for users.
// This user is exempt from the quickrun quota; the picks are invisible everywhere but the
// learning surfaces (drafts are excluded from feed/record/celebrations by design).
const PAPER_USER = "85a7776e-7c86-4c82-8f53-f8aa81f0bd0b"; // demo@onside.com.ng

const RULE_FIELDS = ["home_odds","draw_odds","away_odds","fav_odds","dog_odds","over_1_5_odds","over_2_5_odds","under_2_5_odds","btts_yes_odds","market_odds","model_prob","market_prob","edge","home_wins_last5","away_wins_last5","home_form_ppg","away_form_ppg","home_win_prob","away_win_prob","home_score_prob","away_score_prob","btts_prob","home_goals_blend","away_goals_blend","goals_blend","min_goals_blend","home_goals_avg","away_goals_avg","h2h_n","h2h_over25","h2h_over35","h2h_avg_goals","h2h_btts","h2h_home_wins","h2h_away_wins","h2h_home_scored","h2h_away_scored","home_corners_avg","away_corners_avg","corners_avg"];
const RULE_MARKETS = ["home_win","away_win","draw","double_chance_1x","double_chance_x2","double_chance_12","over_1_5","over_2_5","over_3_5","under_2_5","under_3_5","btts","home_to_score","away_to_score"];
const MK_LABEL: Record<string, string> = {
  home_win: "Home win", away_win: "Away win", draw: "Draw",
  double_chance_1x: "Double chance (1X)", double_chance_x2: "Double chance (X2)", double_chance_12: "Double chance (12)",
  over_1_5: "Over 1.5 goals", over_2_5: "Over 2.5 goals", over_3_5: "Over 3.5 goals",
  under_2_5: "Under 2.5 goals", under_3_5: "Under 3.5 goals", btts: "Both teams to score",
  home_to_score: "Home team to score", away_to_score: "Away team to score",
  result_1h_or_ft: "1st half or match result",
};
function defSide(mk: string): string | null {
  if (mk === "home_win" || mk === "home_to_score") return "home";
  if (mk === "away_win" || mk === "away_to_score") return "away";
  if (mk === "draw") return "draw";
  if (mk === "double_chance_1x") return "1x";
  if (mk === "double_chance_x2") return "x2";
  if (mk === "double_chance_12") return "12";
  if (mk.startsWith("over")) return "over";
  if (mk.startsWith("under")) return "under";
  if (mk === "btts") return "yes";
  return null;
}
function defLine(mk: string): number | null { const m = mk.match(/(?:over|under)_(\d)_5/); return m ? Number(`${m[1]}.5`) : null; }

type Cond = { field: string; op: string; value: number; value2: number };
// a branch carries a when-LIST (all conditions must hold; empty list = the DEFAULT branch).
// The legacy single when_field/when_op shape from parses stored before the list existed is
// still honoured by applySelect.
type Branch = { when?: Cond[]; when_field?: string; when_op?: string; when_value?: number; when_value2?: number; market_key: string; side: string; line: number };
type RuleParsed = { filters: Cond[]; select: Branch[] };

const COND_SCHEMA = { type: "object", additionalProperties: false, properties: { field: { type: "string", enum: RULE_FIELDS }, op: { type: "string", enum: ["lt", "lte", "gt", "gte", "eq", "between"] }, value: { type: "number" }, value2: { type: "number" } }, required: ["field", "op", "value", "value2"] };
const BRANCH_SCHEMA = { type: "object", additionalProperties: false, properties: { when: { type: "array", items: COND_SCHEMA }, market_key: { type: "string", enum: RULE_MARKETS }, side: { type: "string" }, line: { type: "number" } }, required: ["when", "market_key", "side", "line"] };
const RULE_SCHEMA = { type: "object", additionalProperties: false, properties: { filters: { type: "array", items: COND_SCHEMA }, select: { type: "array", items: BRANCH_SCHEMA } }, required: ["filters", "select"] };
const RULE_PROMPT = `You translate a bettor's plain-English rule for a football strategy into structured logic Onside runs on every game.\nThe strategy's BASE market is given. Odds are decimal (e.g. home_odds 1.55). Fields you may test:\n${RULE_FIELDS.join(", ")}. (fav_odds/dog_odds = the shorter/longer of home & away; market_odds = fair odds of the base market; model_prob/market_prob/edge are the base market's; every *_prob field is a 0-1 FRACTION, so a bettor's "X% chance" means X/100 — "the model gives my bet at least a 67% chance" means model_prob gte 0.67; edge is a fraction e.g. 0.04. home_wins_last5/away_wins_last5 = that team's wins in its last 5 matches, 0-5; home_form_ppg/away_form_ppg = points per game over the last 5, 0-3; home_win_prob/away_win_prob = the model's win probability for each side, which already reflects opponent strength — use these to judge how strong the opponent is. home_score_prob/away_score_prob = the model's probability that the home/away team scores at least one goal, 0-1 — compare the two to pick the team more likely to score. btts_prob = the model's probability that BOTH teams score, i.e. its chance for the "Both teams to score"/BTTS/GG market — "only games where the model gives Both teams to score a 67%+ chance" means btts_prob gte 0.67 (when BTTS IS the base market, model_prob works too). home_goals_blend/away_goals_blend = that team's total goals per game (scored + conceded) over its last 5 — the app's pick text calls this the team's "blend"; goals_blend = the average of the two teams' blends, i.e. the "≈X goals" blend the app shows for the fixture — a bettor saying "blend of 3.0" or "blend is 3.0" means goals_blend gte 3.0 unless they clearly mean less-than; min_goals_blend = the LOWER of the two teams' blends — use it for "both teams' blends are at least X". Blend fields are GOALS-per-game numbers, never probabilities: "both teams to score" is the BTTS market (btts_prob), NOT a blend. home_goals_avg/away_goals_avg = goals that team SCORED per game over its last 5 (conceded not counted) — "the team averages 2 goals" means home_goals_avg gte 2.0. h2h_* = the last up-to-10 FINISHED head-to-head meetings between the two clubs from Onside's own results history: h2h_n = meetings on record (0-10); h2h_over35/h2h_over25 = how many of those went over 3.5/2.5 total goals (counts, 0-10); h2h_avg_goals = average total goals across them; h2h_btts = meetings where both sides scored. "the last 10 h2h have fewer than 4 over 3.5" means h2h_over35 lt 4. h2h_home_wins/h2h_away_wins = how many of those meetings TODAY'S home/away team won (any venue); h2h_home_scored/h2h_away_scored = meetings where today's home/away team scored — "the home team has beaten them at least 5 times" means h2h_home_wins gte 5; "home always scores against them" means h2h_home_scored high (e.g. gte 8). h2h fields (except h2h_n) need at least 5 recorded meetings — with fewer the game is skipped, so do NOT add an h2h_n condition unless the bettor asks for one. home_corners_avg/away_corners_avg = that team's OWN corners won per game over its recent games with corner stats; corners_avg = the two added together ≈ the expected match corner total — "teams average 10 corners between them" means corners_avg gte 10.)\nMarkets you may switch to: ${RULE_MARKETS.join(", ")}.\nOutput two lists:\n- filters: conditions that must ALL hold for the game to be considered (else skip). Empty if the rule doesn't filter.\n- select: ordered branches choosing WHICH market to bet. Each branch has when: a LIST of conditions that must ALL hold (AND), plus the market to use if they do. A branch with an EMPTY when list is the DEFAULT (always fires). First matching branch wins. Empty select = use base market. If no branch matches and there is no default, skip the game.\nIMPORTANT: select is ONLY for rules that EXPLICITLY name a different market to bet (\"if X, bet under 2.5 instead\"). If the rule is guidance about what to consider (defence, form, strength...), express it as filters and return EMPTY select — never replace the user's chosen market with a lookalike, and never emit a default branch unless the rule explicitly asks to always bet that market.\nRules: use only listed fields/markets and ops (lt,lte,gt,gte,eq,between). Never approximate with a lookalike field: if the bettor tests a quantity that has no listed field, DROP that condition (an empty parse is honest — the builder reads it back; a wrong condition silently picks wrong games). Fill unused numbers with 0 and unused strings with \"\". If the rule only filters, return filters + empty select. If it only overrides the market, return empty filters + select. If you cannot understand it, return empty filters and empty select. Return ONLY JSON.`;

async function parseRule(text: string, key: string, base: { mk: string; side: string | null; label: string }): Promise<RuleParsed | null> {
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-sonnet-5", max_tokens: 1500,
        thinking: { type: "disabled" },
        output_config: { format: { type: "json_schema", schema: RULE_SCHEMA } },
        // The ~3.5K-token field glossary (RULE_PROMPT) is identical on every parse and dominates
        // the call's cost — cache it. Builder sessions re-parse within minutes (cache TTL 5min),
        // so repeat parses pay ~10% on the prefix instead of 100%. The dynamic tail (base market
        // + rule text) stays outside the breakpoint.
        messages: [{ role: "user", content: [
          { type: "text", text: RULE_PROMPT, cache_control: { type: "ephemeral" } },
          { type: "text", text: `\nBASE market: ${base.label} (key ${base.mk}, side ${base.side ?? ""}).\nRULE: ${text.trim().slice(0, 800)}` },
        ] }],
      }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    await logLLM("agent_rules", "claude-sonnet-5", data?.usage);
    const block = (data.content ?? []).find((b: any) => b.type === "text");
    const p = JSON.parse(block?.text ?? "{}");
    return { filters: Array.isArray(p.filters) ? p.filters : [], select: Array.isArray(p.select) ? p.select : [] };
  } catch { return null; }
}
// Bettors write rules in every style — math shorthand ("1.2 < odds <= 1.37"), broken grammar,
// slang. One cheap Haiku pass canonicalises the text into explicit betting English BEFORE the
// structured parse, so a single pipeline fits every writing style. Numbers must survive exactly;
// any failure falls back to parsing the raw text alone.
async function rephraseRule(text: string, key: string): Promise<string | null> {
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001", max_tokens: 300,
        messages: [{ role: "user", content: `Rewrite this football bettor's rule as one or two short, explicit English sentences describing betting conditions. Expand shorthand and math notation into words (e.g. "1.2 < odds <= 1.37" means "the odds are greater than 1.2 and at most 1.37"). Keep every number EXACTLY as written. Do not add, drop or invent conditions. Do not answer or explain anything — output ONLY the rewritten rule.\n\nRULE: ${text.trim().slice(0, 500)}` }],
      }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    await logLLM("agent_rules", "claude-haiku-4-5", data?.usage);
    const t = ((data.content ?? []).find((b: any) => b.type === "text")?.text ?? "").trim();
    return t || null;
  } catch { return null; }
}
// A parse is deterministic per (base market, rule text), yet the builder re-parses on every
// typing pause and users retype the same sentence for days (2026-09-01: two users burned their
// full 40/day quota on repeats and ~10 agents share one identical rule — 117 LLM parses, ~94%
// avoidable). Cache results in api_cache keyed by a hash of (RULE_PROMPT, base, text): hashing
// the prompt in means any glossary change silently invalidates every cached parse, and each
// reuse refreshes fetched_at so live rules never age out of the 3-day pruning. Empty/null
// parses are never cached — they keep their retry semantics (see emptyParse).
async function ruleParseKey(text: string, base: { mk: string; side: string | null }): Promise<string> {
  const bytes = new TextEncoder().encode(`${RULE_PROMPT}|${base.mk}|${base.side ?? ""}|${text.trim().slice(0, 800)}`);
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return "ruleparse_res:" + Array.from(d.slice(0, 12), (b) => b.toString(16).padStart(2, "0")).join("");
}
const usableParse = (rp: RuleParsed | null | undefined): boolean => !!rp && (rp.filters.length > 0 || rp.select.length > 0);
// The full pipeline: cache first, else canonicalise, then parse original + clarified together
// (the parser sees both, so a bad rephrase can't hide the user's actual words). heard = what the
// engine understood in plain English, surfaced by the builder's read-back.
async function parseRuleFull(text: string, key: string, base: { mk: string; side: string | null; label: string }): Promise<{ parsed: RuleParsed | null; heard: string | null }> {
  const ck = await ruleParseKey(text, base);
  const hit = await sharedCacheGet<{ parsed: RuleParsed | null; heard: string | null }>(ck);
  if (hit && usableParse(hit.parsed)) { await sharedCachePut(ck, hit); return hit; } // re-put refreshes fetched_at
  const heard = await rephraseRule(text, key);
  const parsed = await parseRule(heard ? `${text}\n(Clarified: ${heard})` : text, key, base);
  if (usableParse(parsed)) await sharedCachePut(ck, { parsed, heard });
  return { parsed, heard };
}
function medianOdd(bms: any[], betId: number, value: string): number | null {
  const xs: number[] = [];
  for (const bm of bms) { const bet = (bm.bets ?? []).find((b: any) => Number(b.id) === betId); if (!bet) continue; const o = oddOf(bet, value); if (o && o > 1) xs.push(o); }
  if (!xs.length) return null;
  xs.sort((a, b) => a - b); const m = Math.floor(xs.length / 2);
  return xs.length % 2 ? xs[m] : (xs[m - 1] + xs[m]) / 2;
}
type Form = { wins5: number; draws5: number; losses5: number; pts5: number; ppg5: number; gf5: number; ga5: number; n: number };
const round2 = (x: number) => Math.round(x * 100) / 100;
function signalsFor(bms: any[], modelP: number | null, marketP: number | null, edge: number | null, homeForm?: Form, awayForm?: Form, homeWinP?: number | null, awayWinP?: number | null, homeScoreP?: number | null, awayScoreP?: number | null, extra?: Record<string, number | null>): Record<string, number | null> {
  const home = medianOdd(bms, 1, "Home"), away = medianOdd(bms, 1, "Away");
  // "blend" = a team's total goals per game (gf+ga) over its last 5 — the same number the
  // pick explanations show ("Blend the two … ≈X goals"), so rules can speak that language
  const hBlend = homeForm && homeForm.n ? round2((homeForm.gf5 + homeForm.ga5) / homeForm.n) : null;
  const aBlend = awayForm && awayForm.n ? round2((awayForm.gf5 + awayForm.ga5) / awayForm.n) : null;
  return {
    home_odds: home, draw_odds: medianOdd(bms, 1, "Draw"), away_odds: away,
    fav_odds: home != null && away != null ? Math.min(home, away) : null,
    dog_odds: home != null && away != null ? Math.max(home, away) : null,
    over_1_5_odds: medianOdd(bms, 5, "Over 1.5"), over_2_5_odds: medianOdd(bms, 5, "Over 2.5"),
    under_2_5_odds: medianOdd(bms, 5, "Under 2.5"), btts_yes_odds: medianOdd(bms, 8, "Yes"),
    market_odds: marketP && marketP > 0 ? 1 / marketP : null, model_prob: modelP, market_prob: marketP, edge,
    home_wins_last5: homeForm ? homeForm.wins5 : null, away_wins_last5: awayForm ? awayForm.wins5 : null,
    home_form_ppg: homeForm ? homeForm.ppg5 : null, away_form_ppg: awayForm ? awayForm.ppg5 : null,
    home_win_prob: homeWinP ?? null, away_win_prob: awayWinP ?? null,
    home_score_prob: homeScoreP ?? null, away_score_prob: awayScoreP ?? null,
    home_goals_blend: hBlend, away_goals_blend: aBlend,
    goals_blend: hBlend != null && aBlend != null ? round2((hBlend + aBlend) / 2) : null,
    min_goals_blend: hBlend != null && aBlend != null ? Math.min(hBlend, aBlend) : null,
    home_goals_avg: homeForm && homeForm.n ? round2(homeForm.gf5 / homeForm.n) : null,
    away_goals_avg: awayForm && awayForm.n ? round2(awayForm.gf5 / awayForm.n) : null,
    // per-fixture history signals (h2h_* / corners_*) — supplied only when a rule tests them
    ...(extra ?? {}),
  };
}
function evalCond(c: { field: string; op: string; value: number; value2: number }, sig: Record<string, number | null>): boolean {
  const x = sig[c.field]; if (x == null) return false;
  switch (c.op) {
    case "lt": return x < c.value; case "lte": return x <= c.value;
    case "gt": return x > c.value; case "gte": return x >= c.value;
    case "eq": return Math.abs(x - c.value) < 1e-9;
    case "between": return x >= c.value && x <= c.value2;
    default: return false;
  }
}
type Eff = { mk: string; side: string | null; line: number | null };
// Fields a FAMILY strategy ("best of" markets) can only test AFTER the family has chosen its
// concrete market — before that there is no base market, so these signals are null and a rule
// like "odds not lower than 1.20" would silently block every game.
const FAMILY_DEFERRED = new Set(["market_odds", "model_prob", "market_prob", "edge"]);
// Pick a market from the rule's ordered branches; first matching (or default) wins, else null.
// A branch matches when ALL of its when-conditions hold (an empty list is the default branch);
// legacy single-condition branches from older stored parses evaluate identically.
function applySelect(select: Branch[], sig: Record<string, number | null>): Eff | null {
  for (const b of select) {
    const conds: Cond[] = Array.isArray(b.when)
      ? b.when
      : !b.when_field || b.when_field === "always" || b.when_op === "always"
        ? []
        : [{ field: b.when_field, op: b.when_op ?? "", value: b.when_value ?? 0, value2: b.when_value2 ?? 0 }];
    const pick = (): Eff => ({ mk: b.market_key, side: b.side || defSide(b.market_key), line: b.line || defLine(b.market_key) });
    if (conds.length === 0) return pick();
    if (conds.every((c) => evalCond(c, sig))) return pick();
  }
  return null;
}
// Recent-form signals: each team's last-5 finished results (from whichever side it played).
// Scoped to just the teams in this run's candidate fixtures — one query, newest-first, cap 5/team.
async function buildFormMap(teamIds: number[]): Promise<Map<number, Form>> {
  const map = new Map<number, Form>();
  if (!teamIds.length) return map;
  const list = teamIds.join(",");
  const { data } = await sb.from("fixtures")
    .select("home_team_id,away_team_id,ft_home,ft_away,home_goals,away_goals,kickoff_utc")
    .in("status", FINISHED)
    .or(`home_team_id.in.(${list}),away_team_id.in.(${list})`)
    .order("kickoff_utc", { ascending: false }).limit(6000);
  const want = new Set(teamIds);
  const taken = new Map<number, number>();
  for (const f of data ?? []) {
    const hg = f.ft_home ?? f.home_goals, ag = f.ft_away ?? f.away_goals;
    if (hg == null || ag == null) continue;
    for (const home of [true, false]) {
      const tid = home ? f.home_team_id : f.away_team_id;
      if (tid == null || !want.has(tid) || (taken.get(tid) ?? 0) >= 5) continue;
      const gf = home ? hg : ag, ga = home ? ag : hg;
      const cur = map.get(tid) ?? { wins5: 0, draws5: 0, losses5: 0, pts5: 0, ppg5: 0, gf5: 0, ga5: 0, n: 0 };
      if (gf > ga) { cur.wins5++; cur.pts5 += 3; } else if (gf === ga) { cur.draws5++; cur.pts5 += 1; } else cur.losses5++;
      cur.gf5 += gf; cur.ga5 += ga;
      cur.n++; map.set(tid, cur); taken.set(tid, (taken.get(tid) ?? 0) + 1);
    }
  }
  for (const v of map.values()) v.ppg5 = v.n ? v.pts5 / v.n : 0;
  return map;
}

// ---------- rule-time H2H + corner history (built ONLY when a rule tests these fields) ----------
type H2H = { n: number; over25: number; over35: number; avg: number; btts: number; team: Record<number, { w: number; s: number }> };
const pairKey = (a: number, b: number) => (a < b ? `${a}-${b}` : `${b}-${a}`);
// Last ≤10 finished meetings per candidate pair from OUR fixtures history, one paged batch query
// (both team ids must be in the candidate set — exact pairs are matched client-side). h2h fields
// go null below 5 meetings and evalCond treats null as "condition fails" → the game is skipped:
// thin H2H is not evidence, matching the weekend scans the owner approved (which required 6+).
async function buildH2HMap(fx: Fixture[]): Promise<Map<string, H2H>> {
  const map = new Map<string, H2H>();
  const ids = Array.from(new Set(fx.flatMap((f) => [f.home_team_id, f.away_team_id]).filter((x): x is number => x != null)));
  if (!ids.length) return map;
  const want = new Set(fx.filter((f) => f.home_team_id != null && f.away_team_id != null).map((f) => pairKey(f.home_team_id!, f.away_team_id!)));
  const rows: any[] = [];
  for (let off = 0; off < 5000; off += 1000) { // PostgREST caps every response at 1000 — page it
    const { data } = await sb.from("fixtures")
      .select("home_team_id,away_team_id,ft_home,ft_away,home_goals,away_goals,kickoff_utc")
      .in("status", FINISHED)
      .in("home_team_id", ids).in("away_team_id", ids)
      .order("kickoff_utc", { ascending: false })
      .range(off, off + 999);
    rows.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }
  const taken = new Map<string, number>();
  for (const f of rows) {
    if (f.home_team_id == null || f.away_team_id == null) continue;
    const k = pairKey(f.home_team_id, f.away_team_id);
    if (!want.has(k) || (taken.get(k) ?? 0) >= 10) continue;
    const hg = f.ft_home ?? f.home_goals, ag = f.ft_away ?? f.away_goals;
    if (hg == null || ag == null) continue;
    const cur = map.get(k) ?? { n: 0, over25: 0, over35: 0, avg: 0, btts: 0, team: {} };
    const tot = hg + ag;
    cur.n++; cur.avg += tot;
    if (tot >= 3) cur.over25++;
    if (tot >= 4) cur.over35++;
    if (hg > 0 && ag > 0) cur.btts++;
    // per-team results across the meetings, keyed by team id so the CURRENT fixture's home/away
    // resolve correctly whatever venue each historical meeting was played at
    const th = (cur.team[f.home_team_id] ??= { w: 0, s: 0 });
    const ta = (cur.team[f.away_team_id] ??= { w: 0, s: 0 });
    if (hg > ag) th.w++; else if (ag > hg) ta.w++;
    if (hg > 0) th.s++;
    if (ag > 0) ta.s++;
    map.set(k, cur); taken.set(k, (taken.get(k) ?? 0) + 1);
  }
  for (const v of map.values()) v.avg = v.n ? round2(v.avg / v.n) : 0;
  return map;
}
type CornForm = { sum: number; n: number };
// A team's OWN corners per game over its last ≤5 games WITH collected stats. fixture_stats is
// sparse (collect-stats covers corner-bet games + a rolling backfill), so fields need ≥3 samples
// (STAT_MIN_N precedent) — below that they're null and a corners condition skips the game.
async function buildCornerFormMap(teamIds: number[]): Promise<Map<number, CornForm>> {
  const map = new Map<number, CornForm>();
  if (!teamIds.length) return map;
  const list = teamIds.join(",");
  const rows: any[] = [];
  for (let off = 0; off < 3000; off += 1000) {
    const { data } = await sb.from("fixtures")
      .select("home_team_id,away_team_id,kickoff_utc,fixture_stats!inner(corners_home,corners_away)")
      .in("status", FINISHED)
      .or(`home_team_id.in.(${list}),away_team_id.in.(${list})`)
      .order("kickoff_utc", { ascending: false })
      .range(off, off + 999);
    rows.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }
  const want = new Set(teamIds);
  const taken = new Map<number, number>();
  for (const f of rows) {
    const st = Array.isArray(f.fixture_stats) ? f.fixture_stats[0] : f.fixture_stats;
    if (!st || st.corners_home == null || st.corners_away == null) continue;
    for (const home of [true, false]) {
      const tid = home ? f.home_team_id : f.away_team_id;
      if (tid == null || !want.has(tid) || (taken.get(tid) ?? 0) >= 5) continue;
      const cur = map.get(tid) ?? { sum: 0, n: 0 };
      cur.sum += home ? st.corners_home : st.corners_away;
      cur.n++;
      map.set(tid, cur); taken.set(tid, (taken.get(tid) ?? 0) + 1);
    }
  }
  return map;
}
// 🧭 H2H sense check — implicit, always on, EVERY outcome (owner-ruled 2026-08-16, restated
// 2026-08-17: the model→h2hVeto→formVeto→Guide pipeline is the DEFAULT for any bet outcome):
// a pick that this matchup's OWN history clearly contradicts is dropped even with no rule.
// Conservative on purpose: needs ≥5 recorded meetings (6+ for win/DC markets) and a STRONG
// contradiction — mild disagreement is left to the model + the market bar. Markets where H2H
// has nothing to say (corners, cards, draws, exotics) pass through untouched — the pick still
// flows through the veto, the veto just has no basis to fire. Thin history never vetoes.
function h2hVeto(mk: string | null, side: string | null, line: number | null, period: string | null | undefined, f: Fixture, h2h?: H2H): boolean {
  if (!h2h || h2h.n < 5) return false;
  const per = period ?? "ft";
  let key = mk ?? "";
  if (key === "total_goals_ou" && line != null && side) key = `${side}_${String(line).replace(".", "_")}`;
  const rate = (x: number) => x / h2h.n;
  const hs = f.home_team_id != null ? (h2h.team[f.home_team_id] ?? { w: 0, s: 0 }) : { w: 0, s: 0 };
  const as_ = f.away_team_id != null ? (h2h.team[f.away_team_id] ?? { w: 0, s: 0 }) : { w: 0, s: 0 };

  // goal totals — ANY line, any period (period share mirrors the pricing model's half split).
  // The classic FT lines keep their original owner-ruled thresholds; everything else uses the
  // pairing's own scoring average vs the line, with wider margins than formVeto (5-10 meetings
  // is a thinner sample than last-5 form).
  const gm = key.match(/^(over|under)_(\d+)(?:_(\d))?$/);
  if (gm) {
    if (per === "ft") {
      switch (key) {
        case "over_1_5": return h2h.avg < 1.2;
        case "over_2_5": return rate(h2h.over25) < 0.3;
        case "over_3_5": return rate(h2h.over35) < 0.2;
        case "under_2_5": return rate(h2h.over25) > 0.7;
        case "under_3_5": return rate(h2h.over35) > 0.6;
      }
    }
    const gl = Number(gm[2]) + (gm[3] ? Number(`0.${gm[3]}`) : 0);
    const share = per === "1h" ? H1_GOALS : per === "2h" ? 1 - H1_GOALS : 1;
    const exp = h2h.avg * share;
    if (gm[1] === "over") return exp < gl - (per === "ft" ? 1.0 : 0.5);
    return exp > gl + (per === "ft" ? 1.5 : 0.75);
  }

  if (per !== "ft") return false;
  // win picks incl. 1UP/never-down variants: never beaten this opponent on record
  if (/^home_win/.test(key)) return h2h.n >= 6 && hs.w === 0;
  if (/^away_win/.test(key)) return h2h.n >= 6 && as_.w === 0;
  switch (key) {
    case "home_to_score": return rate(hs.s) < 0.5;      // picked to score, but usually doesn't vs THIS opponent
    case "away_to_score": return rate(as_.s) < 0.5;
    case "btts": return side === "no" ? rate(h2h.btts) > 0.7 : rate(h2h.btts) < 0.3;
    // double chance / draw-no-bet fail only when the third outcome lands — veto when the OTHER
    // side won every meeting (6+), or >80% of an 8+ meeting record (backtested owner-approved
    // 2026-08-17: 1X lands just 33% when the away side won >80% of 8+ meetings, vs 70% baseline)
    case "double_chance_1x": return (h2h.n >= 6 && as_.w === h2h.n) || (h2h.n >= 8 && as_.w / h2h.n > 0.8);
    case "double_chance_x2": return (h2h.n >= 6 && hs.w === h2h.n) || (h2h.n >= 8 && hs.w / h2h.n > 0.8);
    case "dnb": return side === "away"
      ? (h2h.n >= 6 && hs.w === h2h.n) || (h2h.n >= 8 && hs.w / h2h.n > 0.8)
      : (h2h.n >= 6 && as_.w === h2h.n) || (h2h.n >= 8 && as_.w / h2h.n > 0.8);
    case "home_no_bet": return (h2h.n >= 6 && as_.w === h2h.n) || (h2h.n >= 8 && as_.w / h2h.n > 0.8);
    case "away_no_bet": return (h2h.n >= 6 && hs.w === h2h.n) || (h2h.n >= 8 && hs.w / h2h.n > 0.8);
    // clean sheets / win-to-nil: the side being kept out scores in nearly every meeting
    case "home_clean_sheet": case "home_win_to_nil": return rate(as_.s) > 0.7;
    case "away_clean_sheet": case "away_win_to_nil": return rate(hs.s) > 0.7;
    default: return false;
  }
}

// 🧭 Recent-form sense check — implicit, always on, EVERY outcome (owner-approved 2026-08-16,
// restated 2026-08-17: model→h2hVeto→formVeto→Guide is the DEFAULT pipeline for any bet outcome):
// even with no rule, a pick that both teams' own displayed last-5 form EXTREMELY contradicts is
// dropped — same philosophy as h2hVeto and the Onside Guide (the card SHOWS the form; a pick that
// visibly contradicts its own evidence never ships). Conservative on purpose: a team must have a
// FULL 5 recent games on record (thin data never vetoes) and only extreme contradictions fire.
// Covers every goal-total line at any period (share-scaled), to-score/btts/team totals, win
// variants, double chance / draw-no-bet, clean sheets. Corners/cards (goal form says nothing),
// draw and odd-even/exotics (form can't contradict them) pass through with no basis to fire.
// Replays before each shipping: v1 vetoed ZERO settled picks; the totals extension vetoed
// 4 (2W/2L, a 50% set vs 70% kept) — drops below-average picks at no net cost.
function formVeto(mk: string | null, side: string | null, line: number | null, period: string | null | undefined, hf?: Form, af?: Form): boolean {
  const per = period ?? "ft";
  // period share mirrors the pricing model's half split, so a 1st-half line is judged against
  // 1st-half-sized goal expectations, not full-game ones
  const share = per === "1h" ? H1_GOALS : per === "2h" ? 1 - H1_GOALS : 1;
  const key = mk ?? "";
  const full = (x?: Form): x is Form => !!x && x.n === 5;
  // both sides' last-5 games, averaged: how many total goals does a game involving these teams see
  const comb = full(hf) && full(af) ? ((hf.gf5 + hf.ga5) / 5 + (af.gf5 + af.ga5) / 5) / 2 : null;
  // canonicalise every goal-total to {side, line}: fixed over_x_5/under_x_5 keys + any-line total_goals_ou
  let gl: number | null = null, gs: string | null = null;
  const fixed = key.match(/^(over|under)_(\d)_5$/);
  if (fixed) { gs = fixed[1]; gl = Number(fixed[2]) + 0.5; }
  else if (key === "total_goals_ou" && line != null && side) { gs = side; gl = line; }

  // dry-team: backed to score (or team-total over / btts-yes) with ≤1 goal in its last 5
  if (key === "home_to_score" && full(hf) && hf.gf5 <= 1) return true;
  if (key === "away_to_score" && full(af) && af.gf5 <= 1) return true;
  if (key === "btts" && side !== "no" && ((full(hf) && hf.gf5 <= 1) || (full(af) && af.gf5 <= 1))) return true;
  if (key === "home_goals_ou" && side === "over" && full(hf) && hf.gf5 <= 1) return true;
  if (key === "away_goals_ou" && side === "over" && full(af) && af.gf5 <= 1) return true;
  // team-total under vs a team scoring a full goal past the line
  if (key === "home_goals_ou" && side === "under" && full(hf) && line != null && (hf.gf5 / 5) * share > line + (per === "ft" ? 1.0 : 0.5)) return true;
  if (key === "away_goals_ou" && side === "under" && full(af) && line != null && (af.gf5 / 5) * share > line + (per === "ft" ? 1.0 : 0.5)) return true;
  // win / double-chance / draw-no-bet picks on a team that lost 4+ of its last five.
  // Backtested (1,456 games, owner-confirmed 2026-08-17): 4 losses is the same cliff as 5 —
  // 1X lands 57% (vs 64-76% for 0-3 losses), a straight win just 30% (vs 40-51%).
  if (/^home_win/.test(key) && full(hf) && hf.losses5 >= 4) return true;
  if (/^away_win/.test(key) && full(af) && af.losses5 >= 4) return true;
  // ...and the mirror (backtested, owner-approved 2026-08-17): a DC/DNB pick against an
  // OPPONENT that won 4+ of its last five — 1X lands 54%/50% vs 62-82% for cooler opponents
  if ((key === "double_chance_1x" || key === "home_no_bet" || (key === "dnb" && side !== "away"))
    && ((full(hf) && hf.losses5 >= 4) || (full(af) && af.wins5 >= 4))) return true;
  if ((key === "double_chance_x2" || key === "away_no_bet" || (key === "dnb" && side === "away"))
    && ((full(af) && af.losses5 >= 4) || (full(hf) && hf.wins5 >= 4))) return true;
  // clean sheet / win-to-nil against a side scoring 12+ in its last 5 (2.4 a game)
  if ((key === "home_clean_sheet" || key === "home_win_to_nil") && full(af) && af.gf5 >= 12) return true;
  if ((key === "away_clean_sheet" || key === "away_win_to_nil") && full(hf) && hf.gf5 >= 12) return true;
  // goal totals, ANY line and period: expected pair goals (share-scaled) vs the line. Over needs
  // the expectation a clear margin BELOW the line to veto; under a full goal ABOVE it (halves get
  // proportionally tighter margins because the raw numbers are smaller).
  if (gl != null && comb != null) {
    const exp = comb * share;
    if (gs === "over" && exp < gl - (per === "ft" ? 0.5 : 0.25)) return true;
    if (gs === "under" && exp > gl + (per === "ft" ? 1.0 : 0.5)) return true;
  }
  // draw / double chance / DNB / odd-even / exact & range / qualify / corners / cards: last-5 goal
  // form cannot strongly contradict these — the model + market bar governs them
  return false;
}

// does the parsed rule test any field matching pred? (filters + branch whens + legacy when_field)
function ruleTests(rule: RuleParsed | null, pred: (f: string) => boolean): boolean {
  if (!rule) return false;
  for (const c of rule.filters ?? []) if (c?.field && pred(c.field)) return true;
  for (const b of rule.select ?? []) {
    for (const c of b.when ?? []) if (c?.field && pred(c.field)) return true;
    if (b.when_field && pred(b.when_field)) return true;
  }
  return false;
}
// ---------- API-enriched reasons: real recent form + head-to-head from API-Football ----------
// Our fixtures table only holds ~a season of synced leagues, so DB-derived form/H2H can be thin
// (2 meetings, missing cup games). For the FEW ranked picks per run we fetch the true last-5 form
// (all competitions) and last-10 H2H from the API, DB fallback when the cap bites or a call fails.
// Caches are day-keyed so a warm isolate never serves yesterday's form.
const REASON_FETCH_CAP = 40;
let reasonCalls = 0;
const apiFormCache = new Map<string, Form | null>();
const apiH2HCache = new Map<string, H2H | null>();
const dayKey = () => new Date().toISOString().slice(0, 10);
// Cross-isolate day cache (api_cache table): the in-memory maps above die with the isolate and
// are per-SHARD, so parallel shards / cold starts used to re-buy the same team's form on the same
// day. One fetch lands in the table and every isolate reuses it; pruned daily in maybeRecalibrate.
// undefined = not cached; null = cached "no data" (worth remembering too — saves a refetch).
async function sharedCacheGet<T>(ck: string): Promise<T | null | undefined> {
  try {
    const { data } = await sb.from("api_cache").select("payload").eq("cache_key", ck).maybeSingle();
    return data ? (((data.payload as { v: T | null }).v ?? null) as T | null) : undefined;
  } catch { return undefined; }
}
async function sharedCachePut(ck: string, v: unknown): Promise<void> {
  try { await sb.from("api_cache").upsert({ cache_key: ck, payload: { v }, fetched_at: new Date().toISOString() }, { onConflict: "cache_key" }); } catch { /* non-fatal */ }
}
async function apiTeamForm(teamId: number, key: string): Promise<Form | null> {
  const ck = `${teamId}:${dayKey()}`;
  if (apiFormCache.has(ck)) return apiFormCache.get(ck)!;
  const shared = await sharedCacheGet<Form>(`form:${ck}`);
  if (shared !== undefined) { apiFormCache.set(ck, shared); return shared; }
  if (reasonCalls >= REASON_FETCH_CAP) return null;
  reasonCalls++;
  try {
    const res = await fetch(`https://v3.football.api-sports.io/fixtures?team=${teamId}&last=5&status=FT-AET-PEN`, { headers: { "x-apisports-key": key } });
    await sb.rpc("bump_api_usage");
    const body = await res.json();
    const f: Form = { wins5: 0, draws5: 0, losses5: 0, pts5: 0, ppg5: 0, gf5: 0, ga5: 0, n: 0 };
    for (const it of body?.response ?? []) {
      const gh = it?.goals?.home, ga = it?.goals?.away;
      if (gh == null || ga == null) continue;
      const isHome = it?.teams?.home?.id === teamId;
      const gf = isHome ? gh : ga, against = isHome ? ga : gh;
      if (gf > against) { f.wins5++; f.pts5 += 3; } else if (gf === against) { f.draws5++; f.pts5 += 1; } else f.losses5++;
      f.gf5 += gf; f.ga5 += against; f.n++;
    }
    f.ppg5 = f.n ? f.pts5 / f.n : 0;
    const out = f.n ? f : null;
    apiFormCache.set(ck, out);
    await sharedCachePut(`form:${ck}`, out);
    return out;
  } catch { return null; }
}
// Head-to-head record between two teams, normalised to the CURRENT home team's perspective, so
// the feed can say "X of the last Y went the home team's way".
type H2H = { n: number; homeWins: number; draws: number; awayWins: number };
async function apiH2H(homeId: number, awayId: number, key: string): Promise<H2H | null> {
  const ck = `${homeId}-${awayId}:${dayKey()}`;
  if (apiH2HCache.has(ck)) return apiH2HCache.get(ck)!;
  const shared = await sharedCacheGet<H2H>(`h2h:${ck}`);
  if (shared !== undefined) { apiH2HCache.set(ck, shared); return shared; }
  if (reasonCalls >= REASON_FETCH_CAP) return null;
  reasonCalls++;
  try {
    const res = await fetch(`https://v3.football.api-sports.io/fixtures/headtohead?h2h=${homeId}-${awayId}&last=10&status=FT-AET-PEN`, { headers: { "x-apisports-key": key } });
    await sb.rpc("bump_api_usage");
    const body = await res.json();
    let homeWins = 0, draws = 0, awayWins = 0, n = 0;
    for (const it of body?.response ?? []) {
      const gh = it?.goals?.home, ga = it?.goals?.away;
      if (gh == null || ga == null) continue;
      const curHome = it?.teams?.home?.id === homeId ? gh : ga;
      const curAway = it?.teams?.home?.id === homeId ? ga : gh;
      if (curHome > curAway) homeWins++; else if (curHome === curAway) draws++; else awayWins++;
      n++;
    }
    const out = n ? { n, homeWins, draws, awayWins } : null;
    apiH2HCache.set(ck, out);
    await sharedCachePut(`h2h:${ck}`, out);
    return out;
  } catch { return null; }
}
// DB fallback (last up-to-6 finished meetings we have synced).
async function buildH2H(homeId: number, awayId: number): Promise<H2H> {
  const { data } = await sb.from("fixtures")
    .select("home_team_id,away_team_id,ft_home,ft_away,home_goals,away_goals,kickoff_utc")
    .in("status", FINISHED)
    .or(`and(home_team_id.eq.${homeId},away_team_id.eq.${awayId}),and(home_team_id.eq.${awayId},away_team_id.eq.${homeId})`)
    .order("kickoff_utc", { ascending: false }).limit(6);
  let homeWins = 0, draws = 0, awayWins = 0, n = 0;
  for (const f of data ?? []) {
    const hg = f.ft_home ?? f.home_goals, ag = f.ft_away ?? f.away_goals;
    if (hg == null || ag == null) continue;
    const curHome = f.home_team_id === homeId ? hg : ag;
    const curAway = f.home_team_id === homeId ? ag : hg;
    if (curHome > curAway) homeWins++; else if (curHome === curAway) draws++; else awayWins++;
    n++;
  }
  return { n, homeWins, draws, awayWins };
}

const oddsCache = new Map<number, any[]>();
const ODDS_TTL_MS = 12 * 60 * 1000; // reuse a fixture's odds across agents/shards/runs for 12 min
let oddsCalls = 0;
async function bookmakersFor(fixtureId: number, key: string): Promise<any[]> {
  if (oddsCache.has(fixtureId)) return oddsCache.get(fixtureId)!;
  // shared cross-run cache: another agent/shard/run may have fetched this fixture recently
  try {
    const { data: cached } = await sb.from("odds_cache").select("bookmakers, fetched_at").eq("fixture_id", fixtureId).maybeSingle();
    if (cached?.fetched_at && Date.now() - Date.parse(cached.fetched_at) < ODDS_TTL_MS) {
      const bms = (cached.bookmakers ?? []) as any[];
      oddsCache.set(fixtureId, bms);
      return bms;
    }
  } catch { /* cache unavailable -> fall through to a live fetch */ }
  if (oddsCalls >= ODDS_FETCH_CAP) return [];
  oddsCalls++;
  try {
    const res = await fetch(`https://v3.football.api-sports.io/odds?fixture=${fixtureId}`, { headers: { "x-apisports-key": key } });
    await sb.rpc("bump_api_usage");
    const body = await res.json();
    const bms = body?.response?.[0]?.bookmakers ?? [];
    oddsCache.set(fixtureId, bms);
    // persist so other agents/shards/runs reuse it (upsert on fixture_id; non-fatal)
    try { await sb.from("odds_cache").upsert({ fixture_id: fixtureId, bookmakers: bms, fetched_at: new Date().toISOString() }, { onConflict: "fixture_id" }); } catch { /* non-fatal */ }
    return bms;
  } catch { oddsCache.set(fixtureId, []); return []; }
}
// ---------- self-calibration: does reality agree with the model's confident calls? ----------
// Loads the stored temperature every run; once a day, measures realized calibration of the last 30
// days' PRICED settled picks in the confident band (model_prob >= 0.6) and nudges TEMP in small
// bounded steps: predicted running hot vs actual → flatten (+0.05, cap 1.3); running cold → sharpen
// back toward the fitted anchor (−0.05, floor 1). Evidence-gated at n >= 200 so it never reacts to
// noise; the snapshot is stored on model_params.calibration for the admin to inspect.
async function maybeRecalibrate(): Promise<void> {
  const { data: mp } = await sb.from("model_params").select("temp,last_calib_at").eq("id", 1).maybeSingle();
  if (mp?.temp != null && Number.isFinite(Number(mp.temp))) TEMP = Number(mp.temp) || 1;
  if (mp?.last_calib_at && Date.now() - Date.parse(mp.last_calib_at) < 24 * 3600 * 1000) return;
  // housekeeping riding the daily gate: day-keyed shared API cache rows and old odds snapshots
  // are dead weight after a few days — prune so the tables stay index-sized. Lifecycle send
  // claims (nudge:/recap:) also live in api_cache and are once-EVER guards — never prune them.
  const stale = new Date(Date.now() - 3 * 86400000).toISOString();
  try {
    await sb.from("api_cache").delete().lt("fetched_at", stale)
      .not("cache_key", "like", "nudge:%")
      .not("cache_key", "like", "recap:%");
  } catch { /* non-fatal */ }
  try { await sb.from("odds_cache").delete().lt("fetched_at", stale); } catch { /* non-fatal */ }
  const since = new Date(Date.now() - 30 * 86400000).toISOString();
  const { data: rows } = await sb.from("deliveries").select("model_prob,result")
    .in("result", ["won", "lost"]).not("model_prob", "is", null).gte("delivered_at", since).limit(2000);
  const hi = (rows ?? []).filter((r: any) => Number(r.model_prob) >= 0.6);
  const n = hi.length;
  let snapshot: Record<string, unknown> = { n, checked_at: new Date().toISOString() };
  let temp = TEMP;
  if (n >= 200) {
    const pred = hi.reduce((s: number, r: any) => s + Number(r.model_prob), 0) / n;
    const act = hi.filter((r: any) => r.result === "won").length / n;
    snapshot = { ...snapshot, pred_hi: Number(pred.toFixed(4)), actual_hi: Number(act.toFixed(4)), temp_before: temp };
    if (pred - act > 0.03) temp = Math.min(1.3, temp + 0.05);
    else if (act - pred > 0.03) temp = Math.max(1, temp - 0.05);
  }
  TEMP = temp;
  try {
    await sb.from("model_params").upsert({ id: 1, temp, last_calib_at: new Date().toISOString(), calibration: snapshot, updated_at: new Date().toISOString() });
  } catch { /* knob store unavailable → keep running on the loaded/default temp */ }
}

// ---------- cross-agent memory: league AND market-family reputations ----------
// Global across all strategies (this measures the model + data quality, not user taste). One pass
// over the last 60 days of EVERY agent's priced deliveries builds two maps:
//   league:  league_id                  -> how picks have fared there (the old league memory)
//   market:  "lg|group" and "*|group"   -> how picks of this KIND fared there / everywhere
// A game that fits several agents teaches all of them: one agent's settled over-2.5s nudge every
// goals agent's ranking in that league, and (via learnAdjust) seed a brand-new agent's bar before
// it has any history of its own. CLV-first, realized fair-odds ROI as fallback, shrunk toward 0
// so a bucket only earns a reputation with sample size.
type LeagueMem = { clvN: number; clvSum: number; roiN: number; roiSum: number };
// which memory bucket a concrete market key studies under
function marketGroupOf(mkRaw: string): string {
  const k = canon(mkRaw, null, null).mk;
  if (CORNER_MKS.has(k)) return "corners";
  if (CARD_MKS.has(k)) return "cards";
  if (["home_win", "away_win", "draw", "result_1x2", "double_chance_1x", "double_chance_x2", "double_chance_12", "dnb", "handicap"].includes(k)) return "result";
  if (["home_to_score", "away_to_score", "btts", "home_clean_sheet", "away_clean_sheet", "home_win_to_nil", "away_win_to_nil"].includes(k)) return "score";
  if (k.includes("1up") || k.includes("2up") || k.includes("never_down")) return "early";
  return "goals"; // totals, ranges, team goals, odd/even — the goals-derived bucket
}
// --- model-band calibration (owner-ruled 2026-08-20) ---
// Every delivered % is a CLAIM, and every settled pick tests it. Settled picks pool globally
// into cells keyed by the EXACT BET at the EXACT integer % — market_key + side + line +
// period + % (owner-ruled, fourth pass: no generalizing across markets; "over 1.5 @ 76%" and
// "home to score @ 76%" keep separate ledgers, because one can fail while the other works).
// bandVeto() kicks out kinds of picks the model has PROVEN to over-claim, before they're ever
// delivered. Global, not per-agent: the % is the model's, so its track record is model-wide
// (per-agent slices would never reach evidence-grade n).
type BandCell = { n: number; won: number; probSum: number };
let CALIB = new Map<string, BandCell>(); // set by buildMemories() each run; empty = fail-open
const bandKey = (mk: string | null, side: string | null, line: number | string | null, period: string | null, mp: number) =>
  `${mk ?? ""}|${side ?? ""}|${line == null || line === "" ? "" : Number(line)}|${period ?? "ft"}|${Math.round(mp * 100)}`;
const BAND_MIN_N = 25;    // settled picks a cell needs before it may block (unproven ≠ bad)
const BAND_SLACK = 0.15;  // actual rate this far under the cell's average claim = over-claiming
const BAND_FLOOR = 0.45;  // …or landing under 45% outright (Shield's floor), whatever the claim
function bandVeto(mk: string | null, side: string | null, line: number | string | null, period: string | null, mp: number | null): boolean {
  if (mp == null || !(mp > 0 && mp < 1)) return false;
  const c = CALIB.get(bandKey(mk, side, line, period, mp));
  if (!c || c.n < BAND_MIN_N) return false;
  const actual = c.won / c.n, claimed = c.probSum / c.n;
  return actual < claimed - BAND_SLACK || actual < BAND_FLOOR;
}
async function buildMemories(): Promise<{ league: Map<number, LeagueMem>; market: Map<string, LeagueMem> }> {
  const league = new Map<number, LeagueMem>();
  const market = new Map<string, LeagueMem>();
  // band calibration reads ALL settled history (the table is small and calibration is scarce);
  // replay 2026-08-20 (10-pt bands): 0 of 238 settled picks would have been dropped. Exact-bet
  // exact-% cells are thinner still, so no cell is near the n≥25 evidence floor yet — the
  // screen ships inert and arms per-bet-per-percent as volume accrues.
  const calib = new Map<string, BandCell>();
  const { data: settledAll } = await sb.from("deliveries")
    .select("model_prob,result,market_key,side,line,period")
    .in("result", ["won", "lost"]).not("model_prob", "is", null).limit(5000);
  for (const d of (settledAll ?? []) as any[]) {
    const p = Number(d.model_prob);
    if (!(p > 0 && p < 1)) continue;
    const k = bandKey(d.market_key, d.side ?? null, d.line ?? null, d.period ?? null, p);
    const c = calib.get(k) ?? { n: 0, won: 0, probSum: 0 };
    c.n++; if (d.result === "won") c.won++; c.probSum += p;
    calib.set(k, c);
  }
  CALIB = calib;
  const since = new Date(Date.now() - 60 * 86400000).toISOString();
  const { data } = await sb.from("deliveries")
    .select("clv,result,market_prob,market_key,fixtures(league_id)")
    .gte("delivered_at", since).not("market_prob", "is", null).limit(3000);
  const add = (m: Map<any, LeagueMem>, key: any, d: any) => {
    const x = m.get(key) ?? { clvN: 0, clvSum: 0, roiN: 0, roiSum: 0 };
    if (d.clv != null && Number.isFinite(Number(d.clv))) { x.clvN++; x.clvSum += Number(d.clv); }
    const kp = Number(d.market_prob);
    if ((d.result === "won" || d.result === "lost") && kp > 0 && kp < 1) {
      x.roiN++; x.roiSum += d.result === "won" ? 1 / kp - 1 : -1;
    }
    m.set(key, x);
  };
  for (const d of (data ?? []) as any[]) {
    const lg = d.fixtures?.league_id;
    if (lg == null) continue;
    add(league, lg, d);
    const g = marketGroupOf(String(d.market_key ?? ""));
    add(market, `${lg}|${g}`, d);
    add(market, `*|${g}`, d);
  }
  return { league, market };
}
const MEM_SHRINK = 5;    // pseudo-samples pulling a bucket's score toward neutral
const MEM_CLAMP = 0.03;  // a league's reputation can sway ranking by at most ±3% edge-equivalent
const MKT_CLAMP = 0.02;  // market-family sway cap (smaller — it stacks on top of the league's)
function memScore(m: LeagueMem | undefined, clamp: number): number {
  if (!m) return 0;
  let s = 0;
  if (m.clvN >= 5) s = m.clvSum / (m.clvN + MEM_SHRINK);
  else if (m.roiN >= 5) s = (m.roiSum / (m.roiN + MEM_SHRINK)) * 0.2; // ROI (±1/pick) scaled into CLV units
  return Math.max(-clamp, Math.min(clamp, s));
}
function leagueScore(mem: Map<number, LeagueMem>, leagueId: number): number { return memScore(mem.get(leagueId), MEM_CLAMP); }
// this league's record for this KIND of pick; the everywhere-bucket when the league is thin
function marketScore(memM: Map<string, LeagueMem>, leagueId: number, mk: string): number {
  const g = marketGroupOf(mk);
  const local = memM.get(`${leagueId}|${g}`);
  if (local && Math.max(local.clvN, local.roiN) >= 5) return memScore(local, MKT_CLAMP);
  return memScore(memM.get(`*|${g}`), MKT_CLAMP);
}
const memSamples = (mem: Map<number, LeagueMem>, lg: number): number => {
  const m = mem.get(lg);
  return m ? Math.max(m.clvN, m.roiN) : 0;
};

// stable shard bucket for a strategy id (parallel cron fan-out)
function hashShard(id: string, shards: number): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  return Math.abs(h) % shards;
}

type Cell = { lamH: number; lamA: number; agg: Agg; agg1h?: Agg; agg2h?: Agg; confident: boolean; corn: StatLam | null; card: StatLam | null };
type Scored = { f: Fixture; mk: string; side: string | null; line: number | null; edge: number | null; tier: string | null; model_prob: number | null; market_prob: number | null; label?: string | null; period?: string | null; bet_value?: string | null; model_ver?: string | null; model_raw?: number | null };
// one candidate outcome in a set — a built-in family entry OR a user's mixed-outcome entry
type Cand = { mk: string; side: string | null; line: number | null; period?: string | null; bet_value?: string | null; label?: string | null };
// the score matrix for the requested period, thinned lazily and cached on the cell
function aggFor(cell: Cell, period: Period): Agg {
  if (period === "1h") { if (!cell.agg1h) cell.agg1h = aggregate(cell.lamH * H1_GOALS, cell.lamA * H1_GOALS); return cell.agg1h; }
  if (period === "2h") { if (!cell.agg2h) cell.agg2h = aggregate(cell.lamH * (1 - H1_GOALS), cell.lamA * (1 - H1_GOALS)); return cell.agg2h; }
  return cell.agg;
}
const periodOf = (c: Cand): Period => (c.period === "1h" || c.period === "2h" ? c.period : "ft");
// Model probability for ANY candidate outcome: corners/cards route to the stat models, everything
// else reads off the (period-appropriate) score matrix. null = the model can't price it (honest).
function modelFor(cell: Cell, c: Cand): number | null {
  const k = canon(c.mk, c.side, c.line);
  const period = periodOf(c);
  // HT-or-FT result: joint of the two checkpoints — priced off the raw FT lambdas, not an Agg
  if (k.mk === "result_1h_or_ft") return cell.confident ? probHtOrFtLam(cell.lamH, cell.lamA, k.side) : null;
  if (CORNER_MKS.has(k.mk)) {
    if (!cell.corn?.ok) return null;
    const share = period === "1h" ? H1_CORNERS : period === "2h" ? 1 - H1_CORNERS : 1;
    return statProb(k.mk, k.side, k.line, c.bet_value ?? null, cell.corn.lh * share, cell.corn.la * share);
  }
  if (CARD_MKS.has(k.mk)) {
    if (!cell.card?.ok || period !== "ft") return null; // cards skew heavily late — FT only
    return statProb(k.mk, k.side, k.line, c.bet_value ?? null, cell.card.lh, cell.card.la);
  }
  if (!cell.confident) return null;
  return modelProb(k.mk, k.side, k.line, aggFor(cell, period), c.bet_value ?? null);
}
function marketFor(c: Cand, bms: any[]): number | null {
  const k = canon(c.mk, c.side, c.line);
  const period = periodOf(c);
  // 1) the bookies' DIRECTLY quoted odds for this exact market, when they exist
  const direct = marketProb(k.mk, k.side, k.line, bms, period);
  if (direct != null) return direct;
  // 2) derived fallback: any goals-derived market prices off the bookies' implied score matrix
  //    (corners/cards can't be derived from 1X2 — they keep needing their own quotes)
  if (CORNER_MKS.has(k.mk) || CARD_MKS.has(k.mk)) return null;
  const lam = marketLams(bms);
  if (!lam) return null;
  if (k.mk === "result_1h_or_ft") return probHtOrFtLam(lam.lh, lam.la, k.side); // joint, not an Agg
  const share = period === "1h" ? H1_GOALS : period === "2h" ? 1 - H1_GOALS : 1;
  return modelProb(k.mk, k.side, k.line, marketAggFor(lam, share), c.bet_value ?? null);
}
// Weigh a SET of outcomes for one game and return the best: priced candidates compete on (capped)
// edge, model-only ones on probability, and a model-less outcome (corners, cards, non-FT periods)
// is the unpriced fallback — so a mix like "home win + corners + 1st-half over 0.5" still delivers
// something honest when the model can't price anything.
// Within a set, an edge past the plausibility cap ranks LOWER the further past it goes (mirrored
// around the cap, floored at 0): past MAX_PLAUSIBLE_EDGE the model is almost certainly wrong about
// reality, so a sane candidate must be able to beat it. Merely capping (rankEdge) put implausible
// numbers at the TOP of the set — a 1X2 "28% edge" in a data-thin league outranked every honest
// team-goals edge, and a mix delivered home win on every game.
const setRank = (e: number) => (e <= MAX_PLAUSIBLE_EDGE ? e : Math.max(0, 2 * MAX_PLAUSIBLE_EDGE - e));
// Early-payout variants (1UP/2UP/Never Down) can't be priced from a final-score matrix, but their
// BASE result market can — so when several land in the fallback bucket ("1x2 1up" = Home 1UP +
// Away 1UP), the stronger side by win model gets sent instead of whichever was listed first.
const FALLBACK_PROXY: Record<string, { mk: string; side: string }> = {
  home_win_1up: { mk: "home_win", side: "home" }, away_win_1up: { mk: "away_win", side: "away" },
  home_win_2up: { mk: "home_win", side: "home" }, away_win_2up: { mk: "away_win", side: "away" },
  home_win_never_down: { mk: "home_win", side: "home" }, away_win_never_down: { mk: "away_win", side: "away" },
  double_chance_1x_1up: { mk: "double_chance_1x", side: "1x" }, double_chance_x2_1up: { mk: "double_chance_x2", side: "x2" },
};
async function pickBest(cands: Cand[], cell: Cell, f: Fixture, key: string, minEdge: number): Promise<Scored | null> {
  const bms = await bookmakersFor(f.id, key);
  let priced: { c: Cand; mp: number; kp: number; edge: number } | null = null;
  let model: { c: Cand; mp: number } | null = null;
  const fallbacks: Cand[] = [];
  for (const c of cands) {
    const mp = modelFor(cell, c);
    if (mp == null) { fallbacks.push(c); continue; }
    const kp = marketFor(c, bms);
    if (kp != null && kp > 0 && kp < 1) {
      const edge = mp - kp;
      if (!priced || setRank(edge) > setRank(priced.edge)) priced = { c, mp, kp, edge };
    }
    if (mp >= 0.5 && (!model || mp > model.mp)) model = { c, mp };
  }
  const out = (c: Cand, rest: Partial<Scored>): Scored => ({
    f, mk: c.mk, side: c.side, line: c.line, edge: null, tier: null, model_prob: null, market_prob: null,
    label: c.label ?? null, period: c.period ?? null, bet_value: c.bet_value ?? null, model_ver: "xg_v1", ...rest,
  });
  if (priced && priced.edge >= minEdge) return out(priced.c, { edge: priced.edge, tier: tierOf(priced.edge), model_prob: priced.mp, market_prob: priced.kp });
  if (model) return out(model.c, { model_prob: model.mp });
  if (fallbacks.length) {
    let best = fallbacks[0];
    if (cell.confident && fallbacks.length > 1) {
      let bestP = -1;
      for (const c of fallbacks) {
        const pr = FALLBACK_PROXY[c.mk];
        const p = pr ? modelProb(pr.mk, pr.side, null, aggFor(cell, periodOf(c))) : null;
        if (p != null && p > bestP) { bestP = p; best = c; }
      }
    }
    return out(best, {});
  }
  return null;
}
async function scoreAndRank(strategy: any, fixtures: Fixture[], model: Model, statM: { corners: StatModel; cards: StatModel }, aggCache: Map<number, Cell>, key: string, rule: RuleParsed | null, formMap: Map<number, Form>, mem: Map<number, LeagueMem>, memM: Map<string, LeagueMem>, h2hMap: Map<string, H2H> = new Map(), cornMap: Map<number, CornForm> = new Map(), pilotTierDc = false): Promise<Scored[]> {
  // ADMIN PILOT cells: same rates, tier-seeded Elo trajectory (see TIER_SPLIT note). Local cache —
  // never written into the shared aggCache, so no other strategy can ever read a pilot matrix.
  const tierCells = new Map<number, Cell>();
  const tierCellFor = (f: Fixture, base: Cell): Cell => {
    let c = tierCells.get(f.id);
    if (!c) {
      const ls = lambdas(model, f, true);
      c = { lamH: ls.lamH, lamA: ls.lamA, agg: aggregate(ls.lamH, ls.lamA), confident: ls.confident, corn: base.corn, card: base.card };
      tierCells.set(f.id, c);
    }
    return c;
  };
  const baseMk = strategy.market_key, baseSide = strategy.side, baseLine = strategy.line != null ? Number(strategy.line) : null;
  // ODDS BAND (opt-in): deliver only picks whose DISPLAYED price (the same priceOf shown on the
  // feed) is within [min_odds, max_odds]. null/null = no band = unchanged behaviour. A pick that
  // can't be priced at all is dropped when a band is set (we can't confirm it's in range). Applied
  // BEFORE the cap so an out-of-band pick yields its slot to the next in-band one. Selection only.
  const minOdds = strategy.min_odds != null ? Number(strategy.min_odds) : null;
  const maxOdds = strategy.max_odds != null ? Number(strategy.max_odds) : null;
  const hasBand = (minOdds != null || maxOdds != null) && !(minOdds != null && Number.isNaN(minOdds)) && !(maxOdds != null && Number.isNaN(maxOdds));
  const bandOk = (mk: string, side: string | null, line: number | null, period: Period, bms: any[], mp: number | null, kp: number | null): boolean => {
    if (!hasBand) return true;
    const price = priceOf(mk, side, line, bms, period, mp, kp);
    if (!price) return false;
    if (minOdds != null && price.odd < minOdds) return false;
    if (maxOdds != null && price.odd > maxOdds) return false;
    return true;
  };
  // a mixed-outcome strategy carries its own candidate set — treated exactly like a family
  const mixCands: Cand[] | null = Array.isArray(strategy.markets) && strategy.markets.length
    ? strategy.markets.map((m: any) => ({
        mk: m.market_key, side: m.side ?? null, line: m.line != null ? Number(m.line) : null,
        period: m.period ?? "ft", bet_value: m.bet_value ?? null, label: m.label ?? null,
      }))
    : null;
  const baseSet = isFamily(baseMk) || !!mixCands; // "best of a set": built-in family or user mix
  const priced: Scored[] = [], unpriced: Scored[] = [];
  for (const f of fixtures) {
    let cell = aggCache.get(f.id);
    if (!cell) {
      const ls = lambdas(model, f);
      cell = { lamH: ls.lamH, lamA: ls.lamA, agg: aggregate(ls.lamH, ls.lamA), confident: ls.confident, corn: statLams(statM.corners, f), card: statLams(statM.cards, f) };
      aggCache.set(f.id, cell);
    }

    let eff: Eff = { mk: baseMk, side: baseSide, line: baseLine };
    let useSet = baseSet;
    const deferred: Cond[] = []; // base-market filters a set can only test after choosing
    // this matchup's own history — powers explicit h2h_* rule fields AND the implicit sense check
    const h2hPair = f.home_team_id != null && f.away_team_id != null ? h2hMap.get(pairKey(f.home_team_id, f.away_team_id)) : undefined;
    // each team's last-5 form — powers the implicit recent-form sense check (formVeto)
    const hForm = f.home_team_id != null ? formMap.get(f.home_team_id) : undefined;
    const aForm = f.away_team_id != null ? formMap.get(f.away_team_id) : undefined;

    // Rules apply to EVERY strategy, including sets (families/mixes): filters gate the game,
    // select branches choose the market. Form + opponent-strength signals are available here.
    if (rule && (rule.filters.length || rule.select.length)) {
      const bms = await bookmakersFor(f.id, key);
      const homeForm = f.home_team_id != null ? formMap.get(f.home_team_id) : undefined;
      const awayForm = f.away_team_id != null ? formMap.get(f.away_team_id) : undefined;
      const bmp = (!baseSet && cell.confident) ? modelProb(baseMk, baseSide, baseLine, cell.agg) : null;
      const bkp = !baseSet ? marketProb(baseMk, baseSide, baseLine, bms) : null;
      // fixture-history signals: last ≤10 H2H meetings + each team's recent corner counts
      // (maps are empty unless the rule actually tests these fields — zero cost otherwise)
      const h2h = h2hPair;
      const hCorn = f.home_team_id != null ? cornMap.get(f.home_team_id) : undefined;
      const aCorn = f.away_team_id != null ? cornMap.get(f.away_team_id) : undefined;
      const hCornAvg = hCorn && hCorn.n >= 3 ? round2(hCorn.sum / hCorn.n) : null;
      const aCornAvg = aCorn && aCorn.n >= 3 ? round2(aCorn.sum / aCorn.n) : null;
      const extra = {
        h2h_n: h2h?.n ?? 0,
        h2h_over25: h2h && h2h.n >= 5 ? h2h.over25 : null,
        h2h_over35: h2h && h2h.n >= 5 ? h2h.over35 : null,
        h2h_avg_goals: h2h && h2h.n >= 5 ? h2h.avg : null,
        h2h_btts: h2h && h2h.n >= 5 ? h2h.btts : null,
        h2h_home_wins: h2h && h2h.n >= 5 && f.home_team_id != null ? (h2h.team[f.home_team_id]?.w ?? 0) : null,
        h2h_away_wins: h2h && h2h.n >= 5 && f.away_team_id != null ? (h2h.team[f.away_team_id]?.w ?? 0) : null,
        h2h_home_scored: h2h && h2h.n >= 5 && f.home_team_id != null ? (h2h.team[f.home_team_id]?.s ?? 0) : null,
        h2h_away_scored: h2h && h2h.n >= 5 && f.away_team_id != null ? (h2h.team[f.away_team_id]?.s ?? 0) : null,
        home_corners_avg: hCornAvg,
        away_corners_avg: aCornAvg,
        corners_avg: hCornAvg != null && aCornAvg != null ? round2(hCornAvg + aCornAvg) : null,
        // model BTTS chance — fixture-level like the score probs (no base market needed), so it
        // filters up front for every strategy shape, families included
        btts_prob: cell.confident ? round2(cell.agg.btts) : null,
      };
      // rules see the same model % the card will show (the blend) — edge stays raw like the tiers
      const sig = signalsFor(bms, blend50(bmp, bkp), bkp, (bmp != null && bkp != null) ? bmp - bkp : null,
        homeForm, awayForm, cell.confident ? cell.agg.hw : null, cell.confident ? cell.agg.aw : null,
        cell.confident ? cell.agg.homeScore : null, cell.confident ? cell.agg.awayScore : null, extra);
      let blocked = false;
      for (const c of rule.filters) {
        // set bases have no base market yet — its odds/edge fields are tested post-pick
        if (baseSet && FAMILY_DEFERRED.has(c.field)) { deferred.push(c); continue; }
        if (!evalCond(c, sig)) { blocked = true; break; }
      }
      if (blocked) continue;
      // Select branches may only fire when the base market is one the rule engine can express —
      // otherwise the parser has substituted a lookalike (a 1UP/corners/exotic base has no
      // RULE_MARKETS entry) and the user's chosen market would be silently replaced.
      const selectAllowed = baseSet || RULE_MARKETS.includes(baseMk);
      if (rule.select.length && selectAllowed) {
        const picked = applySelect(rule.select, sig);
        if (!picked) continue; // no branch matched and no default → skip this game
        eff = picked; useSet = false;
      }
    }

    // deferred filters run against the CONCRETE pick's numbers (family choice or select override);
    // a pick with no odds can't prove it satisfies an odds rule, so it fails closed
    const passesDeferred = (mp2: number | null, kp2: number | null, e2: number | null): boolean => {
      if (!deferred.length) return true;
      const dsig: Record<string, number | null> = {
        model_prob: mp2, market_prob: kp2, edge: e2,
        market_odds: kp2 != null && kp2 > 0 ? 1 / kp2 : null,
      };
      return deferred.every((c) => evalCond(c, dsig));
    };

    if (useSet) {
      const chosen = await pickBest(mixCands ?? FAMILIES[baseMk] ?? [], cell, f, key, strategy.min_edge ?? 0);
      if (!chosen) continue;
      // delivery floor (owner-ruled 2026-08-17): a pick must be MORE LIKELY TO LAND THAN NOT.
      // Edge alone shipped a 46% 1X "value" pick — right for volume betting, wrong for a pick
      // service. No settled delivery had ever been under 50% before that, so this costs nothing.
      if (chosen.model_prob != null && chosen.model_prob < 0.5) continue;
      // too-good-to-be-true cap (owner-ruled 2026-08-17): odds >20% away from the model usually
      // mean the bookies know something it can't see (line-ups, B-team, context). The confidence
      // dot already graded these 🟠; now they don't ship at all. No settled pick ever exceeded 20%.
      if (chosen.edge != null && chosen.edge > 0.20) continue;
      // owner-ruled 2026-08-18: EVERY delivered pick must carry a model rating — a card that
      // can't print its probabilities never ships
      if (chosen.model_prob == null) continue;
      // calibration blend: the DELIVERED claim is the model-market midpoint (see blend50). The
      // owner's ≥50% floor applies to the shown number too — never print "more likely to miss".
      // Selection stayed raw above (floor, edge cap); everything from here gates on the shown %.
      const shown = blend50(chosen.model_prob, chosen.market_prob);
      if (shown == null || shown < 0.5) continue;
      if (shown !== chosen.model_prob) { chosen.model_raw = chosen.model_prob; chosen.model_prob = shown; }
      if (!passesDeferred(chosen.model_prob, chosen.market_prob, chosen.edge)) continue;
      // implicit H2H + recent-form sense checks on the market the set actually chose
      if (h2hVeto(chosen.mk, chosen.side, chosen.line ?? null, chosen.period, f, h2hPair)) continue;
      if (formVeto(chosen.mk, chosen.side, chosen.line ?? null, chosen.period, hForm, aForm)) continue;
      // model-band screen: this exact bet at this % has proven to land far under its claim
      // (gates on the SAME number the row will record, so the learning cells stay in step)
      if (bandVeto(chosen.mk, chosen.side ?? null, chosen.line ?? null, chosen.period ?? "ft", chosen.model_prob)) continue;
      // odds-band gate: only if the agent set one (fetch is cached; skipped entirely when no band)
      if (hasBand) {
        const bms = await bookmakersFor(f.id, key);
        if (!bandOk(chosen.mk, chosen.side ?? null, chosen.line ?? null, (chosen.period ?? "ft") as Period, bms, chosen.model_prob, chosen.market_prob)) continue;
      }
      if (chosen.edge != null) priced.push(chosen); else unpriced.push(chosen);
      continue;
    }

    // implicit H2H + recent-form sense checks — the pick's market vs this matchup's own history
    // (h2hVeto) and vs each team's own last-5 form (formVeto)
    if (h2hVeto(eff.mk, eff.side, eff.line, strategy.period ?? "ft", f, h2hPair)) continue;
    if (formVeto(eff.mk, eff.side, eff.line, strategy.period ?? "ft", hForm, aForm)) continue;

    // single-market path prices through the same router as sets, so periods (1st/2nd half),
    // corners, cards and every canonicalised catalog key work here too
    const baseCand: Cand = { mk: eff.mk, side: eff.side, line: eff.line, period: strategy.period ?? "ft", bet_value: strategy.bet_value ?? null };
    // ADMIN PILOT: dc_1x/x2 picks price off the tier-seeded matrix; everything else is untouched
    const usePilot = pilotTierDc && (eff.mk === "double_chance_1x" || eff.mk === "double_chance_x2");
    const mp = modelFor(usePilot ? tierCellFor(f, cell) : cell, baseCand);
    // owner-ruled 2026-08-18: EVERY delivered pick must carry a model rating — the old
    // model-less unpriced path is gone (cup/U23 games now get rated via the widened model
    // scope instead of shipping blind)
    if (mp == null) continue;
    // delivery floor (owner-ruled 2026-08-17): never ship a pick the model itself calls
    // more-likely-to-miss — edge over the odds is not enough (see set path note)
    if (mp < 0.5) continue;
    // model-band screen: this exact bet at this % has proven to land far under its claim
    if (bandVeto(eff.mk, eff.side, eff.line, strategy.period ?? "ft", mp)) continue;
    const bms2 = await bookmakersFor(f.id, key);
    const kp = marketFor(baseCand, bms2);
    if (kp == null) {
      // no odds anywhere for this game — deliver the model's own confident call (>= 50%) as a
      // model-only pick, exactly like pickBest does for sets, instead of silently skipping it
      if (mp >= 0.5 && passesDeferred(mp, null, null)
        && bandOk(eff.mk, eff.side, eff.line, (strategy.period ?? "ft") as Period, bms2, mp, null)) {
        unpriced.push({ f, mk: eff.mk, side: eff.side, line: eff.line, edge: null, tier: null, model_prob: mp, market_prob: null, model_ver: usePilot ? "tier_v1" : "xg_v1" });
      }
      continue;
    }
    const edge = mp - kp;
    // too-good-to-be-true cap — see the set-path note above
    if (edge > 0.20) continue;
    // calibration blend (see set-path note): shown claim = model-market midpoint, floor applies
    // to it, and the band screen re-checks the blended cell (raw check above stays as a cheap
    // pre-odds early exit during the transition)
    const shownP = blend50(mp, kp);
    if (shownP == null || shownP < 0.5) continue;
    if (bandVeto(eff.mk, eff.side, eff.line, strategy.period ?? "ft", shownP)) continue;
    if (!passesDeferred(shownP, kp, edge)) continue;
    // odds-band gate: prices off the same waterfall shown on the feed (no-op when no band set)
    if (!bandOk(eff.mk, eff.side, eff.line, (strategy.period ?? "ft") as Period, bms2, shownP, kp)) continue;
    priced.push({ f, mk: eff.mk, side: eff.side, line: eff.line, edge, tier: tierOf(edge), model_prob: shownP, market_prob: kp, model_ver: usePilot ? "tier_v1" : "xg_v1", model_raw: shownP !== mp ? mp : null });
  }
  // memory nudges ORDER only — the min_edge bar itself stays a pure market-vs-model test.
  // league + market-family reputations stack (each clamped), so a pick of a kind EVERY agent
  // has done well on in this league outranks an equal-edge pick of a struggling kind.
  const memOf = (p: Scored) => leagueScore(mem, p.f.league_id) + marketScore(memM, p.f.league_id, p.mk);
  const overBar = priced
    .filter((p) => (p.edge ?? -1) >= (strategy.min_edge ?? 0))
    .sort((a, b) => (rankEdge(b.edge) + memOf(b)) - (rankEdge(a.edge) + memOf(a)));
  // unpriced picks get their first learning signal here: buckets with a good priced track record
  // rise, struggling ones sink; ties keep the old soonest-kickoff order
  unpriced.sort((a, b) =>
    (memOf(b) - memOf(a)) ||
    (new Date(a.f.kickoff_utc).getTime() - new Date(b.f.kickoff_utc).getTime()));
  return [...overBar, ...unpriced];
}

// Self-tune the strategy's edge bar. Prefer CLV (closing-line value) — a lower-variance skill signal
// present on every priced pick with a close snapshot, not just settled ones — and fall back to
// realized ROI until enough CLV has accrued. Positive signal → loosen the bar (we're finding value);
// negative → tighten (we're taking bad prices).
async function learnAdjust(strategy: any, memM: Map<string, LeagueMem>): Promise<{ next: number; basis: string; metric: number; sample: number } | null> {
  if (!strategy.learning) return null;
  const cur = strategy.min_edge ?? 0;
  // ADAPTIVE step: proportional to how strong the signal is (a barely-negative CLV crawls, a
  // clearly-negative one moves decisively), bounded so one adjustment can never whipsaw the bar
  const stepFor = (mag: number) => Math.min(0.01, Math.max(0.0025, mag * 0.5));

  const { data: clvRows } = await sb.from("deliveries").select("clv")
    .eq("strategy_id", strategy.id).not("clv", "is", null)
    .order("delivered_at", { ascending: false }).limit(300);
  const clvs = (clvRows ?? []).map((r: any) => Number(r.clv)).filter((x: number) => Number.isFinite(x));
  if (clvs.length >= 20) {
    const avgClv = clvs.reduce((a, b) => a + b, 0) / clvs.length;
    let next = cur;
    if (avgClv < -0.003) next = Math.min(0.08, cur + stepFor(Math.abs(avgClv)));  // taking worse-than-close prices → tighten
    else if (avgClv > 0.008) next = Math.max(0, cur - stepFor(avgClv));           // consistently beating the close → widen
    return { next: Number(next.toFixed(4)), basis: "clv", metric: Number(avgClv.toFixed(4)), sample: clvs.length };
  }

  const { data: settled } = await sb.from("deliveries").select("result, market_prob")
    .eq("strategy_id", strategy.id).in("result", ["won", "lost"]).limit(500);
  let roi = 0, cnt = 0;
  for (const d of settled ?? []) {
    const mp = d.market_prob;
    if (mp == null || mp <= 0 || mp >= 1) continue;
    roi += d.result === "won" ? (1 / mp - 1) : -1;
    cnt++;
  }
  if (cnt >= 20) {
    const avgRoi = roi / cnt;
    let next = cur;
    if (avgRoi < -0.05) next = Math.min(0.08, cur + stepFor(Math.abs(avgRoi) * 0.1)); // ROI (±1/pick) scaled into CLV units
    else if (avgRoi > 0.05) next = Math.max(0, cur - stepFor(avgRoi * 0.1));
    return { next: Number(next.toFixed(4)), basis: "roi", metric: Number(avgRoi.toFixed(4)), sample: cnt };
  }

  // CROSS-AGENT cold start: this agent has no learnable history of its own yet, but OTHER agents
  // have settled picks of the same market family — borrow that community record at reduced
  // strength (fixed small step, higher evidence bar) so a new agent doesn't start blind.
  // Mixes/families skip it: they have no single family to study under.
  if (isFamily(strategy.market_key) || strategy.market_key === "mix") return null;
  const gm = memM.get(`*|${marketGroupOf(strategy.market_key)}`);
  if (!gm) return null;
  const n = Math.max(gm.clvN, gm.roiN);
  if (n < 30) return null;
  let sig = 0;
  if (gm.clvN >= 30) sig = gm.clvSum / (gm.clvN + MEM_SHRINK);
  else if (gm.roiN >= 30) sig = (gm.roiSum / (gm.roiN + MEM_SHRINK)) * 0.2;
  if (Math.abs(sig) < 0.005) return null; // community record too neutral to act on
  const next = sig < 0 ? Math.min(0.08, cur + 0.0025) : Math.max(0, cur - 0.0025);
  if (next === cur) return null;
  return { next: Number(next.toFixed(4)), basis: "cross_agent", metric: Number(sig.toFixed(4)), sample: n };
}

// --- Surprise-me leagues: resolve the league set for THIS run -----------------
// Server port of surpriseLeagues() in StrategyBuilder.tsx. league_mode drives it:
//   fixed    -> hunt league_ids (today's behaviour)
//   all      -> no league filter, scan every competition (Pro Max)
//   surprise -> re-roll a fresh random subset of in-window leagues EVERY run
// Returns "all" for no filter, or the concrete league_id list to hunt.
async function planMaxLeagues(userId: string): Promise<number> {
  try {
    const { data: prof } = await sb.from("profiles").select("plan").eq("id", userId).maybeSingle();
    const { data: lim } = await sb.from("plan_limits").select("max_leagues").eq("plan", prof?.plan ?? "free").maybeSingle();
    return lim?.max_leagues ?? 5;
  } catch { return 5; }
}
// distinct league_ids with at least one un-started fixture in the target window —
// the same pool the builder samples from (activeLeagueIds), so surprise never rolls a dead league.
async function windowLeagueIds(fromIso: string, toIso: string): Promise<number[]> {
  const { data } = await sb.from("fixtures").select("league_id")
    .gte("kickoff_utc", fromIso).lte("kickoff_utc", toIso)
    .not("status", "in", `(${NOT_PICKABLE.join(",")})`).limit(3000);
  return Array.from(new Set((data ?? []).map((r: any) => r.league_id).filter((x: any) => x != null)));
}
async function resolveLeagueIds(strategy: any, fromIso: string, toIso: string, mem: Map<number, LeagueMem>): Promise<number[] | "all"> {
  // legacy rows without league_mode: empty league_ids historically meant "all", else "fixed"
  const mode = strategy.league_mode ?? (Array.isArray(strategy.league_ids) && strategy.league_ids.length ? "fixed" : "all");
  if (mode === "all") return "all";
  if (mode === "fixed") return Array.isArray(strategy.league_ids) ? strategy.league_ids : [];
  // surprise: sample from day-eligible leagues. Fresh RNG each run (never seed from
  // strategy.id) so two runs of the same agent can roll different leagues.
  const active = await windowLeagueIds(fromIso, toIso);
  if (!active.length) return [];
  // Friendlies are excluded from surprise rolls: their provider coverage is unreliable for
  // settlement (venue/team swaps, mis-attributed goals, no scorer names) — a random agent
  // shouldn't gamble on data quality. A user can still target them with fixed leagues.
  const { data: fr } = await sb.from("leagues").select("id").ilike("name", "%friendl%");
  const friendlies = new Set((fr ?? []).map((r: any) => r.id));
  // ...and league memory keeps rolls out of leagues we've MEASURABLY struggled in (clearly
  // negative score with enough samples). Cold today can warm back up as the memory window rolls.
  const cold = (id: number) => leagueScore(mem, id) <= -0.015 && memSamples(mem, id) >= 8;
  const trusted = active.filter((id) => !friendlies.has(id) && !cold(id));
  const maxLeagues = await planMaxLeagues(strategy.user_id);
  const count = maxLeagues; // widest net the plan allows; the shuffle below keeps WHICH leagues fresh each run
  const pool = (trusted.length ? trusted : active).slice();
  for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]]; }
  return pool.slice(0, count);
}

async function runStrategy(strategy: any, model: Model, statM: { corners: StatModel; cards: StatModel }, aggCache: Map<number, Cell>, key: string, mem: Map<number, LeagueMem>, memM: Map<string, LeagueMem>): Promise<number> {
  const nowIso = new Date().toISOString();
  const tz = strategy.timezone || "Africa/Lagos";

  // ATOMIC RUN CLAIM — the creation invoke and the every-minute cron can both find the same
  // agent runnable in the same window (last_run_at was only stamped at the END of a run, so a
  // cron tick that fired mid-run started a SECOND run and the per-run cap was breached across
  // the pair: 50 + 7 = 57 delivered against a cap of 50). Claim the run FIRST with a
  // compare-and-set on last_run_at: exactly one runner flips it, the loser sees 0 rows and
  // walks away. The end-of-run stamp remains as the "finished at" refresh.
  {
    let claimQ = sb.from("strategies").update({ last_run_at: nowIso }).eq("id", strategy.id);
    claimQ = strategy.last_run_at == null ? claimQ.is("last_run_at", null) : claimQ.eq("last_run_at", strategy.last_run_at);
    const { data: claimed } = await claimQ.select("id");
    if (!claimed?.length) return 0; // another runner already claimed this run
  }

  const learned = await learnAdjust(strategy, memM);
  if (learned && learned.next !== strategy.min_edge) {
    const prev = strategy.min_edge ?? 0;
    strategy.min_edge = learned.next;
    await sb.from("strategies").update({ min_edge: learned.next }).eq("id", strategy.id);
    // Don't re-log a tune we've already recorded. If the most recent learning event already moved
    // the bar to this exact value, the bar was just reset (an agent edit/save writes the base bar
    // back over the learned one) and we're only RE-APPLYING the learned value — keep min_edge
    // correct above, but skip a duplicate timeline entry so Performance never shows the same tune
    // twice. A genuinely new adjustment (last event ended somewhere else) still logs.
    const { data: lastEv } = await sb.from("strategy_learning_events")
      .select("new_min_edge").eq("strategy_id", strategy.id)
      .order("created_at", { ascending: false }).limit(1).maybeSingle();
    const alreadyLogged = lastEv != null && Number(lastEv.new_min_edge) === Number(learned.next);
    if (!alreadyLogged) {
      // log the adjustment so Performance can show what/why the agent self-tuned
      await sb.from("strategy_learning_events").insert({
        strategy_id: strategy.id, user_id: strategy.user_id,
        prev_min_edge: prev, new_min_edge: learned.next,
        avg_roi: learned.basis === "roi" ? learned.metric : null,
        // cross_agent metric is in CLV units too (the community's clamped market-family score)
        avg_clv: learned.basis === "clv" || learned.basis === "cross_agent" ? learned.metric : null,
        basis: learned.basis, sample_size: learned.sample,
      });
    }
  }
  const today = tzDay(nowIso, tz);
  const { data: existing } = await sb.from("deliveries").select("fixture_id, delivered_at").eq("strategy_id", strategy.id);
  const takenToday = new Set((existing ?? []).filter((d: any) => d.delivered_at && tzDay(d.delivered_at, tz) === today).map((d: any) => d.fixture_id));
  const takenAll = new Set((existing ?? []).map((d: any) => d.fixture_id));
  const strategyRoom = QUIET_RUN ? 30 : (strategy.max_per_prediction ?? 3) - takenToday.size;
  if (strategyRoom <= 0) return 0;

  let room = strategyRoom;
  // tier-seeded model pilot: ADMIN accounts only, and only when the agent's base market is
  // double-chance 1X or X2 (see TIER_SPLIT note at the Model type)
  let pilotTierDc = false;
  try {
    const { data: prof } = await sb.from("profiles").select("plan, created_at, is_admin").eq("id", strategy.user_id).maybeSingle();
    pilotTierDc = prof?.is_admin === true && (strategy.market_key === "double_chance_1x" || strategy.market_key === "double_chance_x2");
    const { data: lim } = await sb.from("plan_limits").select("max_agents, max_games_per_prediction, monthly_agent_runs").eq("plan", prof?.plan ?? "free").maybeSingle();
    // plans with a monthly run allowance (free) get that many delivery DAYS per calendar month;
    // paid plans carry null = unlimited. New accounts get a 7-DAY TRIAL of DAILY delivery first, so
    // a free user actually feels the daily loop before the wall — then it throttles to the monthly
    // allowance. This is also the backstop for a lapsed subscription: the downgrade cron pauses the
    // strategies, and even a resumed one only runs on the free allowance.
    const inTrial = prof?.created_at != null && Date.now() - Date.parse(prof.created_at) < 7 * 86400000;
    if (lim?.monthly_agent_runs != null && !inTrial) {
      const ms = new Date(); ms.setUTCDate(1); ms.setUTCHours(0, 0, 0, 0);
      const { data: mdel } = await sb.from("deliveries").select("delivered_at").eq("user_id", strategy.user_id).gte("delivered_at", ms.toISOString()).limit(1000);
      const runDays = new Set((mdel ?? []).map((d: any) => String(d.delivered_at).slice(0, 10)));
      const todayUtc = new Date().toISOString().slice(0, 10);
      if (!QUIET_RUN && !runDays.has(todayUtc) && runDays.size >= Number(lim.monthly_agent_runs)) return 0;
    }
    const dailyCap = (lim?.max_agents ?? 1) * (lim?.max_games_per_prediction ?? 8);
    const [dayStart] = tzDayBoundsISO(tz, 0);
    const { count: userToday } = await sb.from("deliveries").select("id", { count: "exact", head: true })
      .eq("user_id", strategy.user_id).gte("delivered_at", dayStart);
    room = QUIET_RUN ? strategyRoom : Math.min(strategyRoom, Math.max(0, dailyCap - (userToday ?? 0)));
  } catch { /* fall back to per-strategy cap */ }
  if (room <= 0) return 0;

  const target = strategy.target_day ?? "same_day";
  let fromIso = nowIso, toIso = tzEndOfTodayISO(tz);
  if (target === "tomorrow") { const [s, e] = tzDayBoundsISO(tz, 1); fromIso = s; toIso = e; }
  else if (target === "saturday" || target === "sunday") {
    const td = target === "saturday" ? 6 : 0;
    const delta = (td - tzDow(tz) + 7) % 7;
    if (delta === 0) { fromIso = nowIso; toIso = tzEndOfTodayISO(tz); }
    else { const [s, e] = tzDayBoundsISO(tz, delta); fromIso = s; toIso = e; }
  }
  // "weekend" only runs on Sat/Sun now (isDue), so each day delivers THAT day's games — the default
  // today window (fromIso=now, toIso=end of today) is exactly right, no special case needed.
  else if (target === "future") { const [, e] = tzDayBoundsISO(tz, 3); fromIso = nowIso; toIso = e; }

  // Resolve leagues for THIS run (surprise re-rolls fresh from the window above).
  const leagues = await resolveLeagueIds(strategy, fromIso, toIso, mem);
  const rolledLeagueIds = strategy.league_mode === "surprise" && leagues !== "all" ? leagues : null;
  if (leagues !== "all" && leagues.length === 0) return 0; // no in-window leagues to hunt this run

  let q = sb.from("fixtures").select("id, league_id, kickoff_utc, home_team_id, away_team_id")
    .gte("kickoff_utc", fromIso).lte("kickoff_utc", toIso)
    .not("status", "in", `(${NOT_PICKABLE.join(",")})`)
    .order("kickoff_utc", { ascending: true }).limit(200);
  if (leagues !== "all") q = q.in("league_id", leagues);
  const { data: fixtures } = await q;
  // optional kickoff pin: only fixtures whose LOCAL kickoff (strategy tz) fits survive.
  // kickoff_at alone = exact HH:MM match (the original pin); with kickoff_until it's an
  // inclusive window, wrapping past midnight when until < at ("22:00 to 01:00" = late games).
  // Empty kickoff_at = any time, the old behaviour (kickoff_until is ignored without it).
  const kickAt = strategy.kickoff_at ? String(strategy.kickoff_at).slice(0, 5) : null;
  const kickUntil = strategy.kickoff_until ? String(strategy.kickoff_until).slice(0, 5) : null;
  const koOk = (f: Fixture) => {
    if (!kickAt) return true;
    const hm = new Date(f.kickoff_utc).toLocaleTimeString("en-GB", { timeZone: tz, hour12: false }).slice(0, 5);
    if (!kickUntil) return hm === kickAt;
    return kickAt <= kickUntil ? hm >= kickAt && hm <= kickUntil : hm >= kickAt || hm <= kickUntil;
  };
  let candidates = (fixtures ?? []).filter((f: Fixture) => !takenAll.has(f.id) && koOk(f));

  // 🛡️ Onside Shield (opt-in per agent, strategies.shield): drop fixtures in leagues where THIS
  // agent is measurably failing — ≥5 settled picks in the league and under 45% won. Recomputed
  // fresh each run so a league can earn its way back; the Performance page badge shows the same
  // rule. Unknown/missing league never blocks (unverifiable ≠ failing).
  if (strategy.shield === true && candidates.length) {
    const { data: hist } = await sb
      .from("deliveries")
      .select("result, fixtures(league_id)")
      .eq("strategy_id", strategy.id)
      .in("result", ["won", "lost"])
      .limit(1000);
    const byLg = new Map<number, { n: number; w: number }>();
    for (const r of (hist ?? []) as any[]) {
      const lg = (Array.isArray(r.fixtures) ? r.fixtures[0]?.league_id : r.fixtures?.league_id) as number | null;
      if (lg == null) continue;
      const b = byLg.get(lg) ?? { n: 0, w: 0 };
      b.n++; if (r.result === "won") b.w++;
      byLg.set(lg, b);
    }
    const blocked = new Set(Array.from(byLg.entries()).filter(([, b]) => b.n >= 5 && b.w / b.n < 0.45).map(([lg]) => lg));
    if (blocked.size) candidates = candidates.filter((f: Fixture) => f.league_id == null || !blocked.has(f.league_id));
  }

  const rule: RuleParsed | null = strategy.rule_parsed ?? null;
  // Recent form is built EVERY run (like H2H below) — it powers explicit rule fields AND the
  // always-on implicit sense check (formVeto), so no-rule agents get the same screen.
  const teamIds = Array.from(new Set(candidates.flatMap((f: Fixture) => [f.home_team_id, f.away_team_id]).filter((x): x is number => x != null)));
  const formMap = teamIds.length ? await buildFormMap(teamIds) : new Map<number, Form>();
  // H2H is built EVERY run — it powers explicit h2h_* rule fields AND the always-on implicit
  // sense check (h2hVeto). Corner history stays gated to rules that actually test corner fields
  // (owner-ruled: corner logic must never run on non-corner rules).
  const h2hMap = candidates.length ? await buildH2HMap(candidates) : new Map<string, H2H>();
  const cornMap = ruleTests(rule, (fld) => fld.endsWith("corners_avg"))
    ? await buildCornerFormMap(Array.from(new Set(candidates.flatMap((f: Fixture) => [f.home_team_id, f.away_team_id]).filter((x): x is number => x != null))))
    : new Map<number, CornForm>();
  let ranked = (await scoreAndRank(strategy, candidates, model, statM, aggCache, key, rule, formMap, mem, memM, h2hMap, cornMap, pilotTierDc)).slice(0, room);

  // Per-pick reasoning ("why did the agent pick this"): each team's TRUE last-5 form and last-10
  // head-to-head pulled live from API-Football (all competitions, not just what we've synced),
  // falling back to our own fixtures table when the per-run cap bites. Stored on the delivery so
  // the feed narrates real signals, not a generic blurb.
  const reasonsByFx = new Map<number, unknown>();
  if (ranked.length) {
    const rTeamIds = Array.from(new Set(ranked.flatMap((r) => [r.f.home_team_id, r.f.away_team_id]).filter((x): x is number => x != null)));
    const rForm = rTeamIds.length ? await buildFormMap(rTeamIds) : new Map<number, Form>();
    for (const r of ranked) {
      const hId = r.f.home_team_id, aId = r.f.away_team_id;
      const hf = hId != null ? (await apiTeamForm(hId, key)) ?? rForm.get(hId) : undefined;
      const af = aId != null ? (await apiTeamForm(aId, key)) ?? rForm.get(aId) : undefined;
      const h2h = (hId != null && aId != null) ? (await apiH2H(hId, aId, key)) ?? await buildH2H(hId, aId) : null;
      const cellR = aggCache.get(r.f.id);
      const agg = cellR?.agg;
      const conf = cellR?.confident ?? false;
      reasonsByFx.set(r.f.id, {
        home_form: hf ? { w: hf.wins5, d: hf.draws5, l: hf.losses5, gf: hf.gf5, ga: hf.ga5, n: hf.n } : null,
        away_form: af ? { w: af.wins5, d: af.draws5, l: af.losses5, gf: af.gf5, ga: af.ga5, n: af.n } : null,
        h2h: h2h && h2h.n ? h2h : null,
        // home_score/away_score: the to-score probabilities — stored so *_score_prob rules are
        // Guide-verifiable on the card (same closure as home_win_prob, 2026-08-18)
        model: (agg && conf) ? { home: round2(agg.hw), draw: round2(agg.dr), away: round2(agg.aw), over25: round2(overP(agg, 2.5)), btts: round2(agg.btts), home_score: round2(agg.homeScore), away_score: round2(agg.awayScore) } : null,
        // stat-model expectations so corner/card picks can explain themselves with real numbers
        ...(cellR?.corn?.ok ? { corners_exp: Math.round((cellR.corn.lh + cellR.corn.la) * 10) / 10 } : {}),
        ...(cellR?.card?.ok ? { cards_exp: Math.round((cellR.card.lh + cellR.card.la) * 10) / 10 } : {}),
      });
    }
  }

  // 🛡️ Onside Guide at the SOURCE (owner-ruled 2026-08-16): before anything is stored or sent,
  // re-verify the rule's form-checkable conditions against the SAME last-5 numbers the pick will
  // DISPLAY (the reasons block, API-enriched) and drop failures — so the feed, the strategy page's
  // delivered count, Telegram, the live icon and the daily budget all agree on what was delivered.
  // Selection-time evaluation uses DB-window form which can disagree with the displayed last-5;
  // this closes that gap at the only place every consumer shares. Unverifiable fields never drop
  // a pick; odds/model/h2h fields were already evaluated at selection. The read-time page Guide
  // remains as a safety net for older rows.
  if (rule && Array.isArray(rule.filters) && rule.filters.length && ranked.length) {
    const per = (ff: any) => (ff && ff.n ? (ff.gf + ff.ga) / ff.n : null);
    const gfAvg = (ff: any) => (ff && ff.n ? ff.gf / ff.n : null);
    const ppgOf = (ff: any) => (ff && ff.n ? (3 * ff.w + ff.d) / ff.n : null);
    const displayVal = (field: string, hf: any, af: any, rs?: any, mp?: number | null): number | null => {
      switch (field) {
        case "home_goals_avg": return gfAvg(hf);
        case "away_goals_avg": return gfAvg(af);
        case "home_goals_blend": return per(hf);
        case "away_goals_blend": return per(af);
        case "goals_blend": { const h = per(hf), a = per(af); return h != null && a != null ? (h + a) / 2 : null; }
        case "min_goals_blend": { const h = per(hf), a = per(af); return h != null && a != null ? Math.min(h, a) : null; }
        case "home_wins_last5": return hf?.w ?? null;
        case "away_wins_last5": return af?.w ?? null;
        case "home_form_ppg": return ppgOf(hf);
        case "away_form_ppg": return ppgOf(af);
        // model-field rules re-verified against the card's OWN displayed ratings (reasons.model)
        // — a pick must never show numbers that contradict its agent's rule
        case "home_win_prob": return rs?.model?.home ?? null;
        case "away_win_prob": return rs?.model?.away ?? null;
        case "home_score_prob": return rs?.model?.home_score ?? null;
        case "away_score_prob": return rs?.model?.away_score ?? null;
        case "btts_prob": return rs?.model?.btts ?? null;
        case "model_prob": return mp ?? null;
        default: return null;
      }
    };
    ranked = ranked.filter((r) => {
      const rs: any = reasonsByFx.get(r.f.id);
      const hf = rs?.home_form ?? null, af = rs?.away_form ?? null;
      for (const c of rule.filters) {
        const x = displayVal(c.field, hf, af, rs, r.model_prob ?? null);
        if (x == null) continue;
        const ok = c.op === "gte" ? x >= c.value : c.op === "lte" ? x <= c.value : c.op === "gt" ? x > c.value
          : c.op === "lt" ? x < c.value : c.op === "eq" ? Math.abs(x - c.value) < 1e-9
          : c.op === "between" ? x >= c.value && x <= (c.value2 ?? c.value) : true;
        if (!ok) return false;
      }
      return true;
    });
  }

  const rows = ranked.map((r) => {
    const reasons = reasonsByFx.get(r.f.id) ?? null;
    const lmem = leagueScore(mem, r.f.league_id);
    const mmem = marketScore(memM, r.f.league_id, r.mk);
    // displayed price for the pick — read ONLY from the in-memory odds already fetched during
    // scoring (never triggers a new odds call). quoted = real book price; derived/model = fair
    // estimate the UI marks with a "~". Purely for display; selection/edge/grading are untouched.
    const price = priceOf(r.mk, r.side, r.line, oddsCache.get(r.f.id) ?? [], (r.period ?? strategy.period ?? "ft") as Period, r.model_prob, r.market_prob);
    const criteria = {
      // the selectivity bar in force when this pick was made — the raw material for per-bar
      // performance analysis (a real bandit over min_edge) once enough history accrues
      bar: Number(strategy.min_edge ?? 0),
      ...(lmem ? { league_memory: Number(lmem.toFixed(4)) } : {}),
      ...(mmem ? { market_memory: Number(mmem.toFixed(4)) } : {}),
      ...(rolledLeagueIds ? { rolled_league_ids: rolledLeagueIds } : {}),
      ...(reasons ? { reasons } : {}),
      // which model priced this pick — absent = deployed v2. Keeps the pilot's record separable
      // (band learning, calibration, any old-vs-new comparison) from day one.
      ...(r.model_ver ? { model_ver: r.model_ver } : {}),
      // calibration audit: when the shown % is the model-market blend, the raw model prob is kept
      // here so old-vs-new comparisons (and any rollback re-grade) stay possible forever
      ...(r.model_raw != null ? { model_raw: Number(r.model_raw.toFixed(4)), calib: "blend50" } : {}),
      // displayed odds: { odd, src } where src is quoted (real median book price) | derived
      // (de-vigged from related quotes) | model (fair odd from the model when nothing is quoted)
      ...(price ? { odds: price.odd, odds_src: price.src } : {}),
    };
    return {
      strategy_id: strategy.id, user_id: strategy.user_id, fixture_id: r.f.id,
      market_key: r.mk ?? "custom",
      // a mix entry carries its own label/period/value; families and singles keep the old derivation
      market_label: r.label ?? (r.mk === "handicap" ? handicapLabel(r.side, r.line) : (r.mk === strategy.market_key ? strategy.market_label : (MK_LABEL[r.mk] ?? strategy.market_label))),
      side: r.side, line: r.line, period: r.period ?? strategy.period ?? "ft", bet_value: r.bet_value ?? strategy.bet_value,
      model_prob: r.model_prob, market_prob: r.market_prob, edge: r.edge, tier: r.tier, result: "pending", delivered_at: nowIso,
      ...(Object.keys(criteria).length ? { criteria } : {}),
    };
  });
  // Idempotent on (strategy_id, fixture_id): overlapping cron runs can both clear the app-side
  // `takenAll` check and try to insert the same pick. The unique index makes the loser's rows a
  // silent no-op instead of a duplicate delivery (one game per strategy, ever). `.select()` returns
  // only the rows this run actually inserted, so a race-loser notifies for nothing it didn't deliver.
  let delivered = rows;
  if (rows.length) {
    const { data: ins } = await sb.from("deliveries")
      .upsert(rows, { onConflict: "strategy_id,fixture_id", ignoreDuplicates: true })
      .select("fixture_id");
    if (ins) { const got = new Set(ins.map((r: any) => r.fixture_id)); delivered = rows.filter((r) => got.has(r.fixture_id)); }
  }

  // per-run push summary to the user's devices — one notification per run, tagged so the next run
  // replaces it rather than stacking. Independent of the agent's app/telegram channels (push is a
  // separate per-device opt-in set in Profile).
  if (delivered.length && !QUIET_RUN) {
    await sendPush(
      strategy.user_id,
      `🤖 ${strategy.name}`,
      `${delivered.length} new pick${delivered.length === 1 ? "" : "s"} cleared your bar — tap to view.`,
      "/agent",
      `agent-${strategy.id}`,
    );
  }

  // NOTE: agent picks are NOT auto-posted to the community feed (removed by request — the
  // "Publish my agents here" toggle now only feeds the aggregate leaderboard, never game lists).

  if (delivered.length && !QUIET_RUN && Array.isArray(strategy.channels) && strategy.channels.includes("telegram")) {
    const { data: prof } = await sb.from("profiles").select("telegram_chat_id").eq("id", strategy.user_id).maybeSingle();
    const chatId = prof?.telegram_chat_id;
    if (chatId) {
      const { data: fx } = await sb.from("fixtures").select("id, home_team, away_team, kickoff_utc, leagues(name, country, tier)").in("id", delivered.map((r) => r.fixture_id));
      const fxMap = new Map((fx ?? []).map((g: any) => [g.id, g]));
      const rankByFx = new Map(ranked.map((r) => [r.f.id, r]));
      const blocks = delivered.map((r) => {
        const g: any = fxMap.get(r.fixture_id);
        const rk: any = rankByFx.get(r.fixture_id);
        const match = g ? `${g.home_team} v ${g.away_team}` : `Fixture ${r.fixture_id}`;
        const lg = g?.leagues;
        const league = [flagFor(lg?.country ?? null, lg?.tier ?? null), lg?.name].filter(Boolean).join(" ");
        const ko = g?.kickoff_utc ? new Date(g.kickoff_utc).toLocaleString("en-GB", { timeZone: tz, weekday: "short", hour: "2-digit", minute: "2-digit" }) : "";
        const dot = confDot(r.tier ?? null, rk?.model_prob ?? null);
        const edgeStr = r.edge != null ? ` (+${(r.edge * 100).toFixed(1)}% edge)` : "";
        return `${dot} ${league}${ko ? ` · ${ko}` : ""}\n${match}\n→ ${r.market_label}${edgeStr}`;
      });
      // surprise runs: show which leagues were rolled this run (redundant for fixed/all)
      let rolledNote = "";
      if (rolledLeagueIds && rolledLeagueIds.length) {
        const { data: lgs } = await sb.from("leagues").select("id, name, country, tier").in("id", rolledLeagueIds);
        const names = (lgs ?? []).map((l: any) => `${flagFor(l.country ?? null, l.tier ?? null)} ${l.name}`.trim()).filter(Boolean);
        if (names.length) rolledNote = `\n🎲 rolled: ${names.join(", ")}`;
      }
      const header = `🤖 ${strategy.name} — ${delivered.length} pick${delivered.length === 1 ? "" : "s"}`;
      const legend = `\n🟢 high · 🟡 solid · 🟠 lower confidence`;
      await sendTelegram(chatId, `${header}${rolledNote}\n\n${blocks.join("\n\n")}\n${legend}`);
    }
  }

  // Friendly "no games" note so users know the agent ran and just found nothing (not broken).
  if (!rows.length && !QUIET_RUN && Array.isArray(strategy.channels) && strategy.channels.includes("telegram")) {
    const { data: prof } = await sb.from("profiles").select("telegram_chat_id").eq("id", strategy.user_id).maybeSingle();
    if (prof?.telegram_chat_id) {
      await sendTelegram(prof.telegram_chat_id,
        `🤖 ${strategy.name}\n\nRan just now — no games cleared your criteria this time. I'd rather send nothing than a weak pick; I'll look again on the next run.`);
    }
  }

  await sb.from("strategies").update({ last_run_at: nowIso }).eq("id", strategy.id);
  return delivered.length;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    let strategyId: string | null = null;
    let shard = -1, shards = 0;
    let parseOnly: { text?: unknown; market_key?: unknown; side?: unknown; market_label?: unknown } | null = null;
    let paperTick = false;
    try { const b = await req.json(); strategyId = b?.strategy_id ?? null; shard = Number(b?.shard ?? -1); shards = Number(b?.shards ?? 0); parseOnly = b?.parse_rule ?? null; QUIET_RUN = b?.quiet === true && !!strategyId; paperTick = b?.paper === true; } catch { QUIET_RUN = false; /* cron */ }

    // Paper tick: {paper:true} runs the least-recently-run "📄 Paper ·" strategy quietly — ONE
    // per cron tick. (Day-one lesson: a 10-post pg_net burst DNS-starved itself, and one edge
    // invocation can't fit ten cold all-league runs inside the idle limit. Ten spaced ticks
    // each doing one run is boring and works.) last_run_at is stamped at selection so a failed
    // run doesn't wedge the rotation — it just waits for tomorrow.
    if (paperTick) {
      const { data: ps } = await sb.from("strategies").select("id")
        .eq("user_id", PAPER_USER).eq("status", "draft").like("name", "📄 Paper ·%")
        .order("last_run_at", { ascending: true, nullsFirst: true }).limit(1);
      if (!ps?.length) return json({ paper: "no paper strategies" });
      strategyId = ps[0].id as string;
      QUIET_RUN = true;
      await sb.from("strategies").update({ last_run_at: new Date().toISOString() }).eq("id", strategyId);
    }

    // Quick-spec quota (quiet runs only): every quiet run is a real odds-API spend the user
    // triggers on demand from the generator, so it gets its own per-user daily allowance
    // (free 3 / pro 10 / pro_max 20 — rides api_cache like the rule-parse cap). The normal
    // cron path is untouched.
    if (QUIET_RUN && strategyId) {
      const { data: qs } = await sb.from("strategies").select("user_id").eq("id", strategyId).maybeSingle();
      if (!qs) return json({ error: "not_found" }, 404);
      if (qs.user_id !== PAPER_USER) {
        const { data: qp } = await sb.from("profiles").select("plan").eq("id", qs.user_id).maybeSingle();
        const qlimit = qp?.plan === "pro_max" ? 20 : qp?.plan === "pro" ? 10 : 3;
        const qck = `quickrun:${qs.user_id}:${dayKey()}`;
        const qused = (await sharedCacheGet<number>(qck)) ?? 0;
        if (qused >= qlimit) return json({ error: "quick_run_limit", used: qused, limit: qlimit }, 429);
        await sharedCachePut(qck, qused + 1);
      }
    }

    // Parse-only mode: the builder reads a rule back to the user BEFORE saving, so a rule that
    // mistranslates (or translates to nothing) is caught at creation time, not after wrong picks.
    // No DB writes, no strategy runs — just the same parser the engine itself uses.
    if (parseOnly && typeof parseOnly.text === "string" && parseOnly.text.trim()) {
      // per-user daily cap (rides the api_cache table and its daily pruning) — each parse is a
      // real LLM call, so a builder session can't burn unbounded tokens
      let uid = "anon";
      try {
        const tok = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
        const payload = JSON.parse(atob(tok.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
        if (typeof payload?.sub === "string") uid = payload.sub;
      } catch { /* shared anon bucket */ }
      const mk = typeof parseOnly.market_key === "string" ? parseOnly.market_key : "custom";
      const base = {
        mk,
        side: typeof parseOnly.side === "string" ? parseOnly.side : null,
        label: typeof parseOnly.market_label === "string" ? parseOnly.market_label : mk,
      };
      // a repeat of an already-parsed (text, base) serves from cache: no LLM call, no quota burn —
      // so the cap only ever bites genuinely novel text
      const cached = await sharedCacheGet<{ parsed: RuleParsed | null; heard: string | null }>(await ruleParseKey(parseOnly.text, base));
      if (cached && usableParse(cached.parsed)) return json(cached);
      const ck = `ruleparse:${uid}:${dayKey()}`;
      const used = (await sharedCacheGet<number>(ck)) ?? 0;
      if (used >= 40) return json({ error: "rule_parse_limit" }, 429);
      await sharedCachePut(ck, used + 1);
      const akey = await anthropicKey();
      if (!akey) return json({ error: "parser_unavailable" }, 503);
      const { parsed, heard } = await parseRuleFull(parseOnly.text, akey, base);
      return json({ parsed, heard });
    }

    let strategies: any[] = [];
    if (strategyId) { const { data } = await sb.from("strategies").select("*").eq("id", strategyId).limit(1); strategies = data ?? []; }
    else {
      const { data } = await sb.from("strategies").select("*").eq("status", "running");
      const now = new Date();
      strategies = (data ?? []).filter((s: any) => isDue(s, now));
      // sharded fan-out: this invocation only handles its stable slice of due strategies
      if (shards > 1 && shard >= 0) strategies = strategies.filter((s: any) => hashShard(String(s.id), shards) === shard);
    }
    if (!strategies.length) return json({ strategies: 0, inserted: 0, shard, shards });

    // An EMPTY parse ({filters:[],select:[]}) is a FAILED parse, not a rule with no conditions
    // (definition hoisted above the mastered-market block, which needs it too).
    const emptyParse = (rp: any) => !!rp && Array.isArray(rp.filters) && Array.isArray(rp.select) && !rp.filters.length && !rp.select.length;

    // Mastered-market default (owner-ruled 2026-09-02): an agent deployed with NO rule at all,
    // on a market the proven-rules library has mastered, gets the proven rule applied at its
    // next run — STAMPED onto the row (rule_text + rule_parsed) so the builder, feed and Guide
    // all show it and the user can edit or clear it like any rule they wrote. Never silent
    // filtering. Exact-market matches only; quick-spec drafts excluded (their empty rule may be
    // a deliberate user choice); costs zero LLM — the filters are stored pre-parsed.
    {
      const ruleless = strategies.filter((s) =>
        s.status !== "draft" && (!s.rule_text || !String(s.rule_text).trim()) && (!s.rule_parsed || emptyParse(s.rule_parsed)));
      if (ruleless.length) {
        const { data: pr } = await sb.from("proven_rules").select("market_key, rule_text, filters");
        const prMap = new Map((pr ?? []).map((r: any) => [String(r.market_key), r]));
        for (const s of ruleless) {
          const row = prMap.get(String(s.market_key));
          if (!row || !Array.isArray(row.filters) || !row.filters.length) continue;
          const rp = { filters: row.filters, select: [] };
          s.rule_parsed = rp; s.rule_text = row.rule_text;
          await sb.from("strategies").update({ rule_parsed: rp, rule_text: row.rule_text }).eq("id", s.id);
        }
      }
    }

    // Empty parses re-qualify for parsing (the "1st Half Over0.5" agent's ">= 86%" rule gated
    // nothing for 10 days when an empty parse was cached forever); retry cost is bounded because
    // only DUE strategies reach this block (≈one delivery run per agent per day).
    const needParse = strategies.some((s) => s.rule_text && (!s.rule_parsed || emptyParse(s.rule_parsed)));
    if (needParse) {
      const akey = await anthropicKey();
      if (akey) for (const s of strategies) {
        if (s.rule_text && (!s.rule_parsed || emptyParse(s.rule_parsed))) {
          const { parsed: rp } = await parseRuleFull(s.rule_text, akey, { mk: s.market_key, side: s.side, label: s.market_label ?? s.market_key });
          if (rp) { s.rule_parsed = rp; await sb.from("strategies").update({ rule_parsed: rp }).eq("id", s.id); }
        }
      }
    }

    // Build the shared scoring model over every league any strategy might hunt this run.
    // fixed -> its league_ids; all/surprise (empty league_ids OR mode says so) -> all upcoming
    // leagues, which covers whatever a surprise run later rolls from the same window.
    const leagueSet = new Set<number>();
    let allLeagues = false;
    for (const s of strategies) {
      const broad = s.league_mode === "all" || s.league_mode === "surprise" || !(Array.isArray(s.league_ids) && s.league_ids.length);
      if (broad) allLeagues = true;
      else for (const l of s.league_ids) leagueSet.add(l);
    }
    if (allLeagues) {
      const { data: up } = await sb.from("fixtures").select("league_id")
        .gte("kickoff_utc", new Date().toISOString()).lte("kickoff_utc", new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString())
        .not("status", "in", `(${NOT_PICKABLE.join(",")})`).limit(3000);
      for (const r of up ?? []) leagueSet.add(r.league_id);
    }
    // Teams playing cups / U23 / continental games keep their REAL history in their domestic
    // league — widen the model's scope to every league the window's teams appeared in over the
    // last year (friendlies excluded server-side), so those fixtures get rated from history we
    // already hold instead of shipping model-less. (Owner-ruled 2026-08-18: every delivered
    // pick must carry a model rating — this is what makes that bar reachable for cup games.)
    try {
      const { data: upFx } = await sb.from("fixtures").select("home_team_id, away_team_id")
        .gte("kickoff_utc", new Date().toISOString()).lte("kickoff_utc", new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString())
        .in("league_id", leagueSet.size ? Array.from(leagueSet) : [-1]).limit(3000);
      const tids = Array.from(new Set((upFx ?? []).flatMap((r: any) => [r.home_team_id, r.away_team_id]).filter((x: any): x is number => x != null)));
      if (tids.length) {
        const { data: extra } = await sb.rpc("team_league_ids", {
          p_team_ids: tids,
          p_since: new Date(Date.now() - 365 * 24 * 3600 * 1000).toISOString(),
        });
        for (const l of (extra as number[] | null) ?? []) leagueSet.add(l);
      }
    } catch { /* scope expansion is best-effort — the base league set still builds the model */ }
    // learning layer: load the calibrated temperature (daily self-check) + the cross-agent
    // memories BEFORE any scoring, so every probability and every ranking this run reflects
    // what the engine has learned from its own delivered picks.
    await maybeRecalibrate();
    const { league: mem, market: memM } = await buildMemories();

    const model = await buildModel(Array.from(leagueSet));
    const statM = await buildStatModels(); // corners/cards rates from the collect-stats pipeline
    const aggCache = new Map<number, Cell>();
    const key = await getSecret("api_football_key");

    let inserted = 0;
    for (const s of strategies) inserted += await runStrategy(s, model, statM, aggCache, key, mem, memM);
    return json({ strategies: strategies.length, inserted, oddsCalls, temp: TEMP });
  } catch (e) {
    console.error("run-strategies failed:", e);
    return json({ error: String(e instanceof Error ? e.message : e) }, 500);
  }
});
