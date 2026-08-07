// Onside strategy runner + edge engine + rule engine + per-user delivery scheduler.
// Cron every minute; only DUE strategies run. Target window (same_day/tomorrow/saturday/sunday/
// weekend/future); saturday/sunday fire only on that weekday. Pricing: model_prob (Poisson) vs
// de-vigged market_prob = edge; families price every option and deliver the best. No fixture twice
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

function json(b: unknown, s = 200) { return new Response(JSON.stringify(b), { status: s, headers: { "Content-Type": "application/json" } }); }
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
      body: JSON.stringify({ user_id: userId, title, body, url, tag, category: "agent_picks" }),
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
type Agg = { hw: number; dr: number; aw: number; totalP: number[]; homeScore: number; awayScore: number; btts: number; marg: number[]; hDist: number[]; aDist: number[]; hwNil: number; awNil: number };
// Full score matrix (DC-corrected, temperature-calibrated, renormalised) → every market read off it,
// so BTTS/team-to-score are proper matrix sums (not the old independent-Poisson product) and all
// probabilities share the same calibration.
function aggregate(lamH: number, lamA: number, N = 10): Agg {
  const ph: number[] = [], pa: number[] = [];
  for (let i = 0; i <= N; i++) { ph.push(pois(i, lamH)); pa.push(pois(i, lamA)); }
  const invT = 1 / (TEMP || 1);
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
  }
  return { hw, dr, aw, totalP, homeScore, awayScore, btts, marg, hDist, aDist, hwNil, awNil };
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

type Rate = { gf: number; ga: number; n: number }; // time-decay-weighted LEAGUE-RELATIVE ratio sums
type TeamRates = { home: Rate; away: Rate; all: Rate }; // venue split + overall (blended by VENUE_WEIGHT)
type Model = { lHome: Map<number, number>; lAway: Map<number, number>; gHome: number; gAway: number; team: Map<number, TeamRates>; elo: Map<number, number> };
// Build ratings from finished fixtures (two passes). Pass 1: time-decayed goal means per league +
// global, so pass 2 can normalise every match by the league it was PLAYED in — the cross-league fix
// (an Estonian side's domestic goals no longer read against the UEFA-competition mean). Pass 2:
// margin/home-adjusted Elo (chronological) + league-relative attack/defence ratios, venue-split AND
// overall. Elo doubles as the shrinkage prior for thin-data teams. Most recent ~40k in-scope results.
async function buildModel(leagueIds: number[]): Promise<Model> {
  const team = new Map<number, TeamRates>();
  const elo = new Map<number, number>();
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
        .select("league_id,home_team_id,away_team_id,ft_home,ft_away,home_goals,away_goals,kickoff_utc")
        .in("league_id", leagueIds).in("status", FINISHED).gte("kickoff_utc", sinceIso)
        .order("kickoff_utc", { ascending: false }).order("id", { ascending: false })
        .range(off, off + PAGE - 1);
      if (error || !data || !data.length) break;
      acc.push(...data);
      if (data.length < PAGE) break;
    }
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
    // PASS 2 — Elo + league-relative ratios (venue + overall)
    const getElo = (id: number) => elo.get(id) ?? ELO_BASE;
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
      // goals relative to the league THIS match was played in
      const w = Math.exp(-decay * (now - Date.parse(f.kickoff_utc)));
      const mh = meanOf(lHomeSum, f.league_id, ghMean), ma = meanOf(lAwaySum, f.league_id, gaMean);
      const nh = hg / mh, na = ag2 / ma;
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
    return { lHome, lAway, gHome: ghMean, gAway: gaMean, team, elo };
  }
  return { lHome: new Map(), lAway: new Map(), gHome: DEF_HOME, gAway: DEF_AWAY, team, elo };
}
function lambdas(m: Model, f: Fixture): { lamH: number; lamA: number; confident: boolean } {
  // the current fixture's league scoring environment (already shrunk toward global; floored vs NaN)
  const leagueHome = Math.max(0.1, m.lHome.get(f.league_id) ?? m.gHome);
  const leagueAway = Math.max(0.1, m.lAway.get(f.league_id) ?? m.gAway);
  // Elo → attack/defence prior (relative to an average team); the shrinkage TARGET so a team with
  // few recent games leans on Elo instead of a neutral 1.0.
  const eloOf = (id: number | null) => (id != null ? m.elo.get(id) : undefined) ?? ELO_BASE;
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
  return { mk, side, line };
}
// halves as independently thinned Poissons: goals skew slightly to the 2nd half, corners a bit more
const H1_GOALS = 0.45;
const H1_CORNERS = 0.44;
// rank on the CAPPED edge so an implausible number can't outrank a genuine one
const rankEdge = (e: number | null) => (e == null ? -1 : Math.min(e, MAX_PLAUSIBLE_EDGE));
function tierOf(edge: number): string {
  if (edge > MAX_PLAUSIBLE_EDGE) return "wide"; // model vs reality, not model vs market — amber
  return edge >= 0.05 ? "elite" : edge >= 0.04 ? "strong" : "wide";
}

const FAMILIES: Record<string, { mk: string; side: string | null; line: number | null }[]> = {
  result_best: [
    { mk: "home_win", side: "home", line: null }, { mk: "draw", side: "draw", line: null }, { mk: "away_win", side: "away", line: null },
    { mk: "double_chance_1x", side: "1x", line: null }, { mk: "double_chance_x2", side: "x2", line: null }, { mk: "double_chance_12", side: "12", line: null },
  ],
  dc_best: [
    { mk: "double_chance_1x", side: "1x", line: null }, { mk: "double_chance_x2", side: "x2", line: null }, { mk: "double_chance_12", side: "12", line: null },
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

const RULE_FIELDS = ["home_odds","draw_odds","away_odds","fav_odds","dog_odds","over_1_5_odds","over_2_5_odds","under_2_5_odds","btts_yes_odds","market_odds","model_prob","market_prob","edge","home_wins_last5","away_wins_last5","home_form_ppg","away_form_ppg","home_win_prob","away_win_prob","home_score_prob","away_score_prob"];
const RULE_MARKETS = ["home_win","away_win","draw","double_chance_1x","double_chance_x2","double_chance_12","over_1_5","over_2_5","over_3_5","under_2_5","under_3_5","btts","home_to_score","away_to_score"];
const MK_LABEL: Record<string, string> = {
  home_win: "Home win", away_win: "Away win", draw: "Draw",
  double_chance_1x: "Double chance (1X)", double_chance_x2: "Double chance (X2)", double_chance_12: "Double chance (12)",
  over_1_5: "Over 1.5 goals", over_2_5: "Over 2.5 goals", over_3_5: "Over 3.5 goals",
  under_2_5: "Under 2.5 goals", under_3_5: "Under 3.5 goals", btts: "Both teams to score",
  home_to_score: "Home team to score", away_to_score: "Away team to score",
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
type Branch = { when_field: string; when_op: string; when_value: number; when_value2: number; market_key: string; side: string; line: number };
type RuleParsed = { filters: Cond[]; select: Branch[] };

const COND_SCHEMA = { type: "object", additionalProperties: false, properties: { field: { type: "string", enum: RULE_FIELDS }, op: { type: "string", enum: ["lt", "lte", "gt", "gte", "eq", "between"] }, value: { type: "number" }, value2: { type: "number" } }, required: ["field", "op", "value", "value2"] };
const BRANCH_SCHEMA = { type: "object", additionalProperties: false, properties: { when_field: { type: "string" }, when_op: { type: "string" }, when_value: { type: "number" }, when_value2: { type: "number" }, market_key: { type: "string", enum: RULE_MARKETS }, side: { type: "string" }, line: { type: "number" } }, required: ["when_field", "when_op", "when_value", "when_value2", "market_key", "side", "line"] };
const RULE_SCHEMA = { type: "object", additionalProperties: false, properties: { filters: { type: "array", items: COND_SCHEMA }, select: { type: "array", items: BRANCH_SCHEMA } }, required: ["filters", "select"] };
const RULE_PROMPT = `You translate a bettor's plain-English rule for a football strategy into structured logic Onside runs on every game.\nThe strategy's BASE market is given. Odds are decimal (e.g. home_odds 1.55). Fields you may test:\n${RULE_FIELDS.join(", ")}. (fav_odds/dog_odds = the shorter/longer of home & away; market_odds = fair odds of the base market; model_prob/market_prob/edge are the base market's, edge is a fraction e.g. 0.04. home_wins_last5/away_wins_last5 = that team's wins in its last 5 matches, 0-5; home_form_ppg/away_form_ppg = points per game over the last 5, 0-3; home_win_prob/away_win_prob = the model's win probability for each side, which already reflects opponent strength — use these to judge how strong the opponent is. home_score_prob/away_score_prob = the model's probability that the home/away team scores at least one goal, 0-1 — compare the two to pick the team more likely to score.)\nMarkets you may switch to: ${RULE_MARKETS.join(", ")}.\nOutput two lists:\n- filters: conditions that must ALL hold for the game to be considered (else skip). Empty if the rule doesn't filter.\n- select: ordered branches choosing WHICH market to bet. Each branch has when_field/when_op/when_value(/when_value2 for 'between') and the market to use if it holds. A branch whose when_field is \"\" is the DEFAULT (always). First matching branch wins. Empty select = use base market. If no branch matches and there is no default, skip the game.\nRules: use only listed fields/markets and ops (lt,lte,gt,gte,eq,between). Fill unused numbers with 0 and unused strings with \"\". If the rule only filters, return filters + empty select. If it only overrides the market, return empty filters + select. If you cannot understand it, return empty filters and empty select. Return ONLY JSON.`;

async function parseRule(text: string, key: string, base: { mk: string; side: string | null; label: string }): Promise<RuleParsed | null> {
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-sonnet-5", max_tokens: 1500,
        thinking: { type: "disabled" },
        output_config: { format: { type: "json_schema", schema: RULE_SCHEMA } },
        messages: [{ role: "user", content: `${RULE_PROMPT}\n\nBASE market: ${base.label} (key ${base.mk}, side ${base.side ?? ""}).\nRULE: ${text.trim().slice(0, 500)}` }],
      }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const block = (data.content ?? []).find((b: any) => b.type === "text");
    const p = JSON.parse(block?.text ?? "{}");
    return { filters: Array.isArray(p.filters) ? p.filters : [], select: Array.isArray(p.select) ? p.select : [] };
  } catch { return null; }
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
function signalsFor(bms: any[], modelP: number | null, marketP: number | null, edge: number | null, homeForm?: Form, awayForm?: Form, homeWinP?: number | null, awayWinP?: number | null, homeScoreP?: number | null, awayScoreP?: number | null): Record<string, number | null> {
  const home = medianOdd(bms, 1, "Home"), away = medianOdd(bms, 1, "Away");
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
function applySelect(select: Branch[], sig: Record<string, number | null>): Eff | null {
  for (const b of select) {
    const isDefault = !b.when_field || b.when_field === "always" || b.when_op === "always";
    const pick = (): Eff => ({ mk: b.market_key, side: b.side || defSide(b.market_key), line: b.line || defLine(b.market_key) });
    if (isDefault) return pick();
    if (evalCond({ field: b.when_field, op: b.when_op, value: b.when_value, value2: b.when_value2 }, sig)) return pick();
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
// Head-to-head record between two teams (last up-to-6 finished meetings), normalised to the
// CURRENT home team's perspective, so the feed can say "X of the last Y went the home team's way".
type H2H = { n: number; homeWins: number; draws: number; awayWins: number };
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

// ---------- league memory: WHERE has the model actually been good? ----------
// Global across all strategies (this measures the model + data quality per league, not user taste).
// CLV-first like learnAdjust, realized fair-odds ROI as fallback, shrunk toward 0 so a league only
// earns a reputation with sample size. Used to (a) nudge pick RANKING, (b) keep 🎲 surprise rolls
// out of leagues we've measurably struggled in, (c) order unpriced picks — their first learning
// signal (their leagues' priced track record generalises to them).
type LeagueMem = { clvN: number; clvSum: number; roiN: number; roiSum: number };
async function buildLeagueMemory(): Promise<Map<number, LeagueMem>> {
  const mem = new Map<number, LeagueMem>();
  const since = new Date(Date.now() - 60 * 86400000).toISOString();
  const { data } = await sb.from("deliveries")
    .select("clv,result,market_prob,fixtures(league_id)")
    .gte("delivered_at", since).not("market_prob", "is", null).limit(3000);
  for (const d of (data ?? []) as any[]) {
    const lg = d.fixtures?.league_id;
    if (lg == null) continue;
    const m = mem.get(lg) ?? { clvN: 0, clvSum: 0, roiN: 0, roiSum: 0 };
    if (d.clv != null && Number.isFinite(Number(d.clv))) { m.clvN++; m.clvSum += Number(d.clv); }
    const kp = Number(d.market_prob);
    if ((d.result === "won" || d.result === "lost") && kp > 0 && kp < 1) {
      m.roiN++; m.roiSum += d.result === "won" ? 1 / kp - 1 : -1;
    }
    mem.set(lg, m);
  }
  return mem;
}
const MEM_SHRINK = 5;    // pseudo-samples pulling a league's score toward neutral
const MEM_CLAMP = 0.03;  // a league's reputation can sway ranking by at most ±3% edge-equivalent
function leagueScore(mem: Map<number, LeagueMem>, leagueId: number): number {
  const m = mem.get(leagueId);
  if (!m) return 0;
  let s = 0;
  if (m.clvN >= 5) s = m.clvSum / (m.clvN + MEM_SHRINK);
  else if (m.roiN >= 5) s = (m.roiSum / (m.roiN + MEM_SHRINK)) * 0.2; // ROI (±1/pick) scaled into CLV units
  return Math.max(-MEM_CLAMP, Math.min(MEM_CLAMP, s));
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
type Scored = { f: Fixture; mk: string; side: string | null; line: number | null; edge: number | null; tier: string | null; model_prob: number | null; market_prob: number | null; label?: string | null; period?: string | null; bet_value?: string | null };
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
  return marketProb(k.mk, k.side, k.line, bms, periodOf(c));
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
async function pickBest(cands: Cand[], cell: Cell, f: Fixture, key: string, minEdge: number): Promise<Scored | null> {
  const bms = await bookmakersFor(f.id, key);
  let priced: { c: Cand; mp: number; kp: number; edge: number } | null = null;
  let model: { c: Cand; mp: number } | null = null;
  let fallback: Cand | null = null;
  for (const c of cands) {
    const mp = modelFor(cell, c);
    if (mp == null) { fallback = fallback ?? c; continue; }
    const kp = marketFor(c, bms);
    if (kp != null && kp > 0 && kp < 1) {
      const edge = mp - kp;
      if (!priced || setRank(edge) > setRank(priced.edge)) priced = { c, mp, kp, edge };
    }
    if (mp >= 0.5 && (!model || mp > model.mp)) model = { c, mp };
  }
  const out = (c: Cand, rest: Partial<Scored>): Scored => ({
    f, mk: c.mk, side: c.side, line: c.line, edge: null, tier: null, model_prob: null, market_prob: null,
    label: c.label ?? null, period: c.period ?? null, bet_value: c.bet_value ?? null, ...rest,
  });
  if (priced && priced.edge >= minEdge) return out(priced.c, { edge: priced.edge, tier: tierOf(priced.edge), model_prob: priced.mp, market_prob: priced.kp });
  if (model) return out(model.c, { model_prob: model.mp });
  if (fallback) return out(fallback, {});
  return null;
}
async function scoreAndRank(strategy: any, fixtures: Fixture[], model: Model, statM: { corners: StatModel; cards: StatModel }, aggCache: Map<number, Cell>, key: string, rule: RuleParsed | null, formMap: Map<number, Form>, mem: Map<number, LeagueMem>): Promise<Scored[]> {
  const baseMk = strategy.market_key, baseSide = strategy.side, baseLine = strategy.line != null ? Number(strategy.line) : null;
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

    // Rules apply to EVERY strategy, including sets (families/mixes): filters gate the game,
    // select branches choose the market. Form + opponent-strength signals are available here.
    if (rule && (rule.filters.length || rule.select.length)) {
      const bms = await bookmakersFor(f.id, key);
      const homeForm = f.home_team_id != null ? formMap.get(f.home_team_id) : undefined;
      const awayForm = f.away_team_id != null ? formMap.get(f.away_team_id) : undefined;
      const bmp = (!baseSet && cell.confident) ? modelProb(baseMk, baseSide, baseLine, cell.agg) : null;
      const bkp = !baseSet ? marketProb(baseMk, baseSide, baseLine, bms) : null;
      const sig = signalsFor(bms, bmp, bkp, (bmp != null && bkp != null) ? bmp - bkp : null,
        homeForm, awayForm, cell.confident ? cell.agg.hw : null, cell.confident ? cell.agg.aw : null,
        cell.confident ? cell.agg.homeScore : null, cell.confident ? cell.agg.awayScore : null);
      let blocked = false;
      for (const c of rule.filters) {
        // set bases have no base market yet — its odds/edge fields are tested post-pick
        if (baseSet && FAMILY_DEFERRED.has(c.field)) { deferred.push(c); continue; }
        if (!evalCond(c, sig)) { blocked = true; break; }
      }
      if (blocked) continue;
      if (rule.select.length) {
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
      if (!passesDeferred(chosen.model_prob, chosen.market_prob, chosen.edge)) continue;
      if (chosen.edge != null) priced.push(chosen); else unpriced.push(chosen);
      continue;
    }

    // single-market path prices through the same router as sets, so periods (1st/2nd half),
    // corners, cards and every canonicalised catalog key work here too
    const baseCand: Cand = { mk: eff.mk, side: eff.side, line: eff.line, period: strategy.period ?? "ft", bet_value: strategy.bet_value ?? null };
    const mp = modelFor(cell, baseCand);
    if (mp == null) {
      if (!passesDeferred(null, null, null)) continue;
      unpriced.push({ f, mk: eff.mk, side: eff.side, line: eff.line, edge: null, tier: null, model_prob: null, market_prob: null });
      continue;
    }
    const bms2 = await bookmakersFor(f.id, key);
    const kp = marketFor(baseCand, bms2);
    if (kp == null) continue;
    const edge = mp - kp;
    if (!passesDeferred(mp, kp, edge)) continue;
    priced.push({ f, mk: eff.mk, side: eff.side, line: eff.line, edge, tier: tierOf(edge), model_prob: mp, market_prob: kp });
  }
  // league memory nudges ORDER only — the min_edge bar itself stays a pure market-vs-model test
  const overBar = priced
    .filter((p) => (p.edge ?? -1) >= (strategy.min_edge ?? 0))
    .sort((a, b) => (rankEdge(b.edge) + leagueScore(mem, b.f.league_id)) - (rankEdge(a.edge) + leagueScore(mem, a.f.league_id)));
  // unpriced picks get their first learning signal here: leagues with a good priced track record
  // rise, struggling ones sink; ties keep the old soonest-kickoff order
  unpriced.sort((a, b) =>
    (leagueScore(mem, b.f.league_id) - leagueScore(mem, a.f.league_id)) ||
    (new Date(a.f.kickoff_utc).getTime() - new Date(b.f.kickoff_utc).getTime()));
  return [...overBar, ...unpriced];
}

// Self-tune the strategy's edge bar. Prefer CLV (closing-line value) — a lower-variance skill signal
// present on every priced pick with a close snapshot, not just settled ones — and fall back to
// realized ROI until enough CLV has accrued. Positive signal → loosen the bar (we're finding value);
// negative → tighten (we're taking bad prices).
async function learnAdjust(strategy: any): Promise<{ next: number; basis: string; metric: number; sample: number } | null> {
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
  if (cnt < 20) return null;
  const avgRoi = roi / cnt;
  let next = cur;
  if (avgRoi < -0.05) next = Math.min(0.08, cur + stepFor(Math.abs(avgRoi) * 0.1)); // ROI (±1/pick) scaled into CLV units
  else if (avgRoi > 0.05) next = Math.max(0, cur - stepFor(avgRoi * 0.1));
  return { next: Number(next.toFixed(4)), basis: "roi", metric: Number(avgRoi.toFixed(4)), sample: cnt };
}

// --- Surprise-me leagues: resolve the league set for THIS run -----------------
// Server port of surpriseLeagues() in StrategyBuilder.tsx. league_mode drives it:
//   fixed    -> hunt exactly strategy.league_ids (today's behaviour)
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
    .not("status", "in", `(${FINISHED_LIVE.join(",")})`).limit(3000);
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

async function runStrategy(strategy: any, model: Model, statM: { corners: StatModel; cards: StatModel }, aggCache: Map<number, Cell>, key: string, mem: Map<number, LeagueMem>): Promise<number> {
  const nowIso = new Date().toISOString();
  const tz = strategy.timezone || "Africa/Lagos";
  const learned = await learnAdjust(strategy);
  if (learned && learned.next !== strategy.min_edge) {
    const prev = strategy.min_edge ?? 0;
    strategy.min_edge = learned.next;
    await sb.from("strategies").update({ min_edge: learned.next }).eq("id", strategy.id);
    // log the adjustment so Performance can show what/why the agent self-tuned
    await sb.from("strategy_learning_events").insert({
      strategy_id: strategy.id, user_id: strategy.user_id,
      prev_min_edge: prev, new_min_edge: learned.next,
      avg_roi: learned.basis === "roi" ? learned.metric : null,
      avg_clv: learned.basis === "clv" ? learned.metric : null,
      basis: learned.basis, sample_size: learned.sample,
    });
  }
  const today = tzDay(nowIso, tz);
  const { data: existing } = await sb.from("deliveries").select("fixture_id, delivered_at").eq("strategy_id", strategy.id);
  const takenToday = new Set((existing ?? []).filter((d: any) => d.delivered_at && tzDay(d.delivered_at, tz) === today).map((d: any) => d.fixture_id));
  const takenAll = new Set((existing ?? []).map((d: any) => d.fixture_id));
  const strategyRoom = (strategy.max_per_prediction ?? 3) - takenToday.size;
  if (strategyRoom <= 0) return 0;

  let room = strategyRoom;
  try {
    const { data: prof } = await sb.from("profiles").select("plan").eq("id", strategy.user_id).maybeSingle();
    const { data: lim } = await sb.from("plan_limits").select("max_agents, max_games_per_prediction, monthly_agent_runs").eq("plan", prof?.plan ?? "free").maybeSingle();
    // plans with a monthly run allowance (free: 1) get that many delivery DAYS per calendar month;
    // paid plans carry null = unlimited. This is also the backstop for a lapsed subscription: the
    // downgrade cron pauses the strategies, and even a resumed one only runs on the free allowance.
    if (lim?.monthly_agent_runs != null) {
      const ms = new Date(); ms.setUTCDate(1); ms.setUTCHours(0, 0, 0, 0);
      const { data: mdel } = await sb.from("deliveries").select("delivered_at").eq("user_id", strategy.user_id).gte("delivered_at", ms.toISOString()).limit(1000);
      const runDays = new Set((mdel ?? []).map((d: any) => String(d.delivered_at).slice(0, 10)));
      const todayUtc = new Date().toISOString().slice(0, 10);
      if (!runDays.has(todayUtc) && runDays.size >= Number(lim.monthly_agent_runs)) return 0;
    }
    const dailyCap = (lim?.max_agents ?? 1) * (lim?.max_games_per_prediction ?? 8);
    const [dayStart] = tzDayBoundsISO(tz, 0);
    const { count: userToday } = await sb.from("deliveries").select("id", { count: "exact", head: true })
      .eq("user_id", strategy.user_id).gte("delivered_at", dayStart);
    room = Math.min(strategyRoom, Math.max(0, dailyCap - (userToday ?? 0)));
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
  else if (target === "weekend") {
    const wd = tzDow(tz);
    const daysToSat = wd === 0 ? -1 : 6 - wd;
    const [satStart] = tzDayBoundsISO(tz, daysToSat);
    const [, sunEnd] = tzDayBoundsISO(tz, daysToSat + 1);
    fromIso = satStart > nowIso ? satStart : nowIso; toIso = sunEnd;
  }
  else if (target === "future") { const [, e] = tzDayBoundsISO(tz, 3); fromIso = nowIso; toIso = e; }

  // Resolve leagues for THIS run (surprise re-rolls fresh from the window above).
  const leagues = await resolveLeagueIds(strategy, fromIso, toIso, mem);
  const rolledLeagueIds = strategy.league_mode === "surprise" && leagues !== "all" ? leagues : null;
  if (leagues !== "all" && leagues.length === 0) return 0; // no in-window leagues to hunt this run

  let q = sb.from("fixtures").select("id, league_id, kickoff_utc, home_team_id, away_team_id")
    .gte("kickoff_utc", fromIso).lte("kickoff_utc", toIso)
    .not("status", "in", `(${FINISHED_LIVE.join(",")})`)
    .order("kickoff_utc", { ascending: true }).limit(200);
  if (leagues !== "all") q = q.in("league_id", leagues);
  const { data: fixtures } = await q;
  const candidates = (fixtures ?? []).filter((f: Fixture) => !takenAll.has(f.id));

  const rule: RuleParsed | null = strategy.rule_parsed ?? null;
  // Only compute recent-form signals when a rule is actually in play (keeps the common path fast).
  const teamIds = rule
    ? Array.from(new Set(candidates.flatMap((f: Fixture) => [f.home_team_id, f.away_team_id]).filter((x): x is number => x != null)))
    : [];
  const formMap = teamIds.length ? await buildFormMap(teamIds) : new Map<number, Form>();
  const ranked = (await scoreAndRank(strategy, candidates, model, statM, aggCache, key, rule, formMap, mem)).slice(0, room);

  // Per-pick reasoning ("why did the agent pick this") from the SAME data that drove the call:
  // each team's last-5 form + goals, the head-to-head record, and the model's win/over probs.
  // Stored on the delivery so the feed can narrate the real signals, not a generic blurb.
  const reasonsByFx = new Map<number, unknown>();
  if (ranked.length) {
    const rTeamIds = Array.from(new Set(ranked.flatMap((r) => [r.f.home_team_id, r.f.away_team_id]).filter((x): x is number => x != null)));
    const rForm = rTeamIds.length ? await buildFormMap(rTeamIds) : new Map<number, Form>();
    for (const r of ranked) {
      const hId = r.f.home_team_id, aId = r.f.away_team_id;
      const hf = hId != null ? rForm.get(hId) : undefined;
      const af = aId != null ? rForm.get(aId) : undefined;
      const h2h = (hId != null && aId != null) ? await buildH2H(hId, aId) : null;
      const agg = aggCache.get(r.f.id)?.agg;
      const conf = aggCache.get(r.f.id)?.confident ?? false;
      reasonsByFx.set(r.f.id, {
        home_form: hf ? { w: hf.wins5, d: hf.draws5, l: hf.losses5, gf: hf.gf5, ga: hf.ga5, n: hf.n } : null,
        away_form: af ? { w: af.wins5, d: af.draws5, l: af.losses5, gf: af.gf5, ga: af.ga5, n: af.n } : null,
        h2h: h2h && h2h.n ? h2h : null,
        model: (agg && conf) ? { home: round2(agg.hw), draw: round2(agg.dr), away: round2(agg.aw), over25: round2(overP(agg, 2.5)), btts: round2(agg.btts) } : null,
      });
    }
  }

  const rows = ranked.map((r) => {
    const reasons = reasonsByFx.get(r.f.id) ?? null;
    const lmem = leagueScore(mem, r.f.league_id);
    const criteria = {
      // the selectivity bar in force when this pick was made — the raw material for per-bar
      // performance analysis (a real bandit over min_edge) once enough history accrues
      bar: Number(strategy.min_edge ?? 0),
      ...(lmem ? { league_memory: Number(lmem.toFixed(4)) } : {}),
      ...(rolledLeagueIds ? { rolled_league_ids: rolledLeagueIds } : {}),
      ...(reasons ? { reasons } : {}),
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
  if (rows.length) await sb.from("deliveries").insert(rows);

  // per-run push summary to the user's devices — one notification per run, tagged so the next run
  // replaces it rather than stacking. Independent of the agent's app/telegram channels (push is a
  // separate per-device opt-in set in Profile).
  if (rows.length) {
    await sendPush(
      strategy.user_id,
      `🤖 ${strategy.name}`,
      `${rows.length} new pick${rows.length === 1 ? "" : "s"} cleared your bar — tap to view.`,
      "/agent",
      `agent-${strategy.id}`,
    );
  }

  // Community publish: the "Publish my agents here" toggle shares each run's TOP picks to the
  // community feed under the user's handle — short and precise (max 5 games, market + edge, no
  // prose). One post per agent per day; the whole block is non-fatal.
  if (rows.length) {
    try {
      const { data: prof } = await sb.from("profiles").select("handle, avatar_color, community_opt_in, leaderboard_opt_in").eq("id", strategy.user_id).maybeSingle();
      if (prof?.leaderboard_opt_in && prof?.community_opt_in && prof?.handle) {
        const [dayStartIso] = tzDayBoundsISO(tz, 0);
        const { data: already } = await sb.from("community_posts").select("id")
          .eq("user_id", strategy.user_id).eq("kind", "picks").gte("created_at", dayStartIso)
          .contains("attachment", { agent: strategy.name }).limit(1);
        if (!already?.length) {
          const top = rows.slice(0, 5); // ranked best-first by scoreAndRank
          const { data: fx2 } = await sb.from("fixtures").select("id, home_team, away_team, kickoff_utc").in("id", top.map((r) => r.fixture_id));
          const fmap = new Map((fx2 ?? []).map((g: any) => [g.id, g]));
          const picks = top.map((r) => {
            const g: any = fmap.get(r.fixture_id);
            return {
              match: g ? `${g.home_team} v ${g.away_team}` : `Fixture ${r.fixture_id}`,
              market: r.market_label ?? r.market_key,
              edge: r.edge != null ? Number((r.edge * 100).toFixed(1)) : null,
              ko: g?.kickoff_utc ? new Date(g.kickoff_utc).toLocaleTimeString("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit" }) : null,
            };
          });
          await sb.from("community_posts").insert({
            user_id: strategy.user_id,
            author_handle: prof.handle,
            author_color: prof.avatar_color ?? null,
            kind: "picks",
            body: `${strategy.name} — today's picks`,
            attachment: { agent: strategy.name, picks },
          });
        }
      }
    } catch { /* non-fatal */ }
  }

  if (rows.length && Array.isArray(strategy.channels) && strategy.channels.includes("telegram")) {
    const { data: prof } = await sb.from("profiles").select("telegram_chat_id").eq("id", strategy.user_id).maybeSingle();
    const chatId = prof?.telegram_chat_id;
    if (chatId) {
      const { data: fx } = await sb.from("fixtures").select("id, home_team, away_team, kickoff_utc, leagues(name, country, tier)").in("id", rows.map((r) => r.fixture_id));
      const fxMap = new Map((fx ?? []).map((g: any) => [g.id, g]));
      const rankByFx = new Map(ranked.map((r) => [r.f.id, r]));
      const blocks = rows.map((r) => {
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
      const header = `🤖 ${strategy.name} — ${rows.length} pick${rows.length === 1 ? "" : "s"}`;
      const legend = `\n🟢 high · 🟡 solid · 🟠 lower confidence`;
      await sendTelegram(chatId, `${header}${rolledNote}\n\n${blocks.join("\n\n")}\n${legend}`);
    }
  }

  // Friendly "no games" note so users know the agent ran and just found nothing (not broken).
  if (!rows.length && Array.isArray(strategy.channels) && strategy.channels.includes("telegram")) {
    const { data: prof } = await sb.from("profiles").select("telegram_chat_id").eq("id", strategy.user_id).maybeSingle();
    if (prof?.telegram_chat_id) {
      await sendTelegram(prof.telegram_chat_id,
        `🤖 ${strategy.name}\n\nRan just now — no games cleared your criteria this time. I'd rather send nothing than a weak pick; I'll look again on the next run.`);
    }
  }

  await sb.from("strategies").update({ last_run_at: nowIso }).eq("id", strategy.id);
  return rows.length;
}

Deno.serve(async (req) => {
  try {
    let strategyId: string | null = null;
    let shard = -1, shards = 0;
    try { const b = await req.json(); strategyId = b?.strategy_id ?? null; shard = Number(b?.shard ?? -1); shards = Number(b?.shards ?? 0); } catch { /* cron */ }

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

    const needParse = strategies.some((s) => s.rule_text && !s.rule_parsed);
    if (needParse) {
      const akey = await anthropicKey();
      if (akey) for (const s of strategies) {
        if (s.rule_text && !s.rule_parsed) {
          const rp = await parseRule(s.rule_text, akey, { mk: s.market_key, side: s.side, label: s.market_label ?? s.market_key });
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
        .not("status", "in", `(${FINISHED_LIVE.join(",")})`).limit(3000);
      for (const r of up ?? []) leagueSet.add(r.league_id);
    }
    // learning layer: load the calibrated temperature (daily self-check) + the league memory
    // BEFORE any scoring, so every probability and every ranking this run reflects what the
    // engine has learned from its own delivered picks.
    await maybeRecalibrate();
    const mem = await buildLeagueMemory();

    const model = await buildModel(Array.from(leagueSet));
    const statM = await buildStatModels(); // corners/cards rates from the collect-stats pipeline
    const aggCache = new Map<number, Cell>();
    const key = await getSecret("api_football_key");

    let inserted = 0;
    for (const s of strategies) inserted += await runStrategy(s, model, statM, aggCache, key, mem);
    return json({ strategies: strategies.length, inserted, oddsCalls, temp: TEMP });
  } catch (e) {
    console.error("run-strategies failed:", e);
    return json({ error: String(e instanceof Error ? e.message : e) }, 500);
  }
});
