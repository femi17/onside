// Forecast backtest + parameter fit (v2).
//   - pages all finished fixtures from Supabase (anon read)
//   - walk-forward by month (ratings built ONLY from matches before each test month → no leakage)
//   - tunes the v2 model's params by coordinate search on a VALIDATION window (minimise 1X2 log-loss)
//   - BASELINE = the DEPLOYED v1 model (venue-only rates normalised by the PREDICTED fixture's league,
//     no temperature), snapshotted inline so the comparison is exact even as forecast.ts evolves
//   - reports 1X2 log-loss/Brier + O/U 2.5 and BTTS binary log-loss + calibration, v1 vs v2 fitted
//
// Run:  cd perf && BT_URL=... BT_ANON=... npx tsx backtest.mts
import {
  buildRatings, teamLambdas, scoreMatrix, marketProbs, DEFAULTS, type Match, type ForecastConfig,
} from "../src/lib/forecast.ts";

const URL = (process.env.BT_URL || "https://mbrtpetpgsggnlcazhqd.supabase.co").replace(/\/$/, "");
const ANON = process.env.BT_ANON || "";
if (!ANON) { console.error("Set BT_ANON to the anon key"); process.exit(1); }

// ---------- load ----------
type Row = { league_id: number; home_team_id: number | null; away_team_id: number | null; ft_home: number | null; ft_away: number | null; home_goals: number | null; away_goals: number | null; kickoff_utc: string };
async function page(offset: number): Promise<Row[]> {
  const u = `${URL}/rest/v1/fixtures?select=league_id,home_team_id,away_team_id,ft_home,ft_away,home_goals,away_goals,kickoff_utc&status=in.(FT,AET,PEN)&order=kickoff_utc.asc&limit=1000&offset=${offset}`;
  const res = await fetch(u, { headers: { apikey: ANON, Authorization: `Bearer ${ANON}` } });
  if (!res.ok) throw new Error(`load ${offset}: ${res.status}`);
  return res.json();
}
async function loadAll(): Promise<Match[]> {
  const first = await page(0);
  const out: Match[] = [];
  const toMatch = (r: Row): Match | null => {
    const hg = r.ft_home ?? r.home_goals, ag = r.ft_away ?? r.away_goals;
    if (r.home_team_id == null || r.away_team_id == null || hg == null || ag == null) return null;
    return { homeId: r.home_team_id, awayId: r.away_team_id, hg, ag, kickoff: Date.parse(r.kickoff_utc), leagueId: r.league_id };
  };
  for (const r of first) { const m = toMatch(r); if (m) out.push(m); }
  let offset = 1000;
  const CONC = 8;
  let done = first.length < 1000;
  while (!done) {
    const offsets = Array.from({ length: CONC }, (_, i) => offset + i * 1000);
    const pages = await Promise.all(offsets.map((o) => page(o).catch(() => [] as Row[])));
    for (const pg of pages) for (const r of pg) { const m = toMatch(r); if (m) out.push(m); }
    if (pages.some((p) => p.length < 1000)) done = true;
    offset += CONC * 1000;
    process.stdout.write(`\r  loaded ~${out.length}`);
  }
  process.stdout.write("\n");
  out.sort((a, b) => a.kickoff - b.kickoff);
  return out;
}

// ---------- shared math ----------
const FACT = [1, 1, 2, 6, 24, 120, 720, 5040, 40320, 362880, 3628800, 39916800];
const pois = (k: number, l: number) => (Math.exp(-l) * Math.pow(l, k)) / FACT[k];
const ELO_BASE = 1500;

// A predictor returns every metric we grade in one shot.
type Pred = { x: [number, number, number]; over25: number; btts: number };

// ---------- DEPLOYED v1 baseline (snapshot of the pre-2026-08-06 forecast.ts) ----------
// Venue-only time-decayed RAW goal rates, normalised by the PREDICTED fixture's league mean at
// predict time (the cross-league bug), Elo-prior shrinkage, independent Poisson (rho=0, no temp).
const V1 = { halfLifeDays: 90, homeAdvElo: 40, eloK: 10, shrink: 8, eloPerLogGoal: 300 };
type V1Rate = { gf: number; ga: number; n: number };
type V1Ratings = {
  elo: Map<number, number>;
  home: Map<number, V1Rate>; away: Map<number, V1Rate>;
  leagueHome: Map<number, { goals: number; n: number }>; leagueAway: Map<number, { goals: number; n: number }>;
  gHome: { goals: number; n: number }; gAway: { goals: number; n: number };
};
function buildV1(history: Match[]): V1Ratings {
  const matches = [...history].sort((a, b) => a.kickoff - b.kickoff);
  const now = matches.length ? matches[matches.length - 1].kickoff : Date.now();
  const decay = Math.LN2 / (V1.halfLifeDays * 86400_000);
  const elo = new Map<number, number>();
  const getElo = (id: number) => elo.get(id) ?? ELO_BASE;
  const home = new Map<number, V1Rate>(), away = new Map<number, V1Rate>();
  const leagueHome = new Map<number, { goals: number; n: number }>(), leagueAway = new Map<number, { goals: number; n: number }>();
  const gHome = { goals: 0, n: 0 }, gAway = { goals: 0, n: 0 };
  const bump = (m: Map<number, V1Rate>, id: number, gf: number, ga: number, w: number) => {
    const r = m.get(id) ?? { gf: 0, ga: 0, n: 0 };
    r.gf += gf * w; r.ga += ga * w; r.n += w; m.set(id, r);
  };
  for (const mt of matches) {
    if (!Number.isFinite(mt.hg) || !Number.isFinite(mt.ag)) continue;
    const rH = getElo(mt.homeId), rA = getElo(mt.awayId);
    const exp = 1 / (1 + Math.pow(10, -((rH + V1.homeAdvElo) - rA) / 400));
    const s = mt.hg > mt.ag ? 1 : mt.hg === mt.ag ? 0.5 : 0;
    const dr = (rH + V1.homeAdvElo) - rA;
    const g = Math.abs(mt.hg - mt.ag);
    const mult = g <= 1 ? 1 : Math.log(g + 1) * (2.2 / (Math.abs(dr) * 0.001 + 2.2));
    const delta = V1.eloK * mult * (s - exp);
    elo.set(mt.homeId, rH + delta); elo.set(mt.awayId, rA - delta);
    const w = Math.exp(-decay * (now - mt.kickoff));
    bump(home, mt.homeId, mt.hg, mt.ag, w);
    bump(away, mt.awayId, mt.ag, mt.hg, w);
    const lg = mt.leagueId ?? -1;
    const lh = leagueHome.get(lg) ?? { goals: 0, n: 0 }; lh.goals += mt.hg * w; lh.n += w; leagueHome.set(lg, lh);
    const la = leagueAway.get(lg) ?? { goals: 0, n: 0 }; la.goals += mt.ag * w; la.n += w; leagueAway.set(lg, la);
    gHome.goals += mt.hg * w; gHome.n += w; gAway.goals += mt.ag * w; gAway.n += w;
  }
  return { elo, home, away, leagueHome, leagueAway, gHome, gAway };
}
function predFromLambdas(lamH: number, lamA: number, temp = 1): Pred {
  const N = 10;
  const invT = 1 / temp;
  let hw = 0, dr = 0, aw = 0, btts = 0, over25 = 0, tot = 0;
  const cells: number[][] = [];
  for (let x = 0; x <= N; x++) { cells[x] = []; for (let y = 0; y <= N; y++) { let v = pois(x, lamH) * pois(y, lamA); if (invT !== 1 && v > 0) v = Math.pow(v, invT); cells[x][y] = v; tot += v; } }
  for (let x = 0; x <= N; x++) for (let y = 0; y <= N; y++) {
    const v = cells[x][y] / tot;
    if (x > y) hw += v; else if (x === y) dr += v; else aw += v;
    if (x > 0 && y > 0) btts += v;
    if (x + y > 2.5) over25 += v;
  }
  return { x: [hw, dr, aw], over25, btts };
}
function predictV1(r: V1Ratings, hId: number, aId: number, lg: number): Pred {
  const lh = r.leagueHome.get(lg), la = r.leagueAway.get(lg);
  const leagueHome = Math.max(0.1, lh && lh.n > 0 ? lh.goals / lh.n : (r.gHome.n > 0 ? r.gHome.goals / r.gHome.n : 1.45));
  const leagueAway = Math.max(0.1, la && la.n > 0 ? la.goals / la.n : (r.gAway.n > 0 ? r.gAway.goals / r.gAway.n : 1.15));
  const attPrior = (id: number) => Math.exp(((r.elo.get(id) ?? ELO_BASE) - ELO_BASE) / V1.eloPerLogGoal);
  const defPrior = (id: number) => Math.exp(-((r.elo.get(id) ?? ELO_BASE) - ELO_BASE) / V1.eloPerLogGoal);
  const H = r.home.get(hId), A = r.away.get(aId);
  const Hn = H?.n ?? 0, An = A?.n ?? 0;
  const rawHomeAtt = Hn > 0 ? (H!.gf / Hn) / leagueHome : 1;
  const rawHomeDef = Hn > 0 ? (H!.ga / Hn) / leagueAway : 1;
  const rawAwayAtt = An > 0 ? (A!.gf / An) / leagueAway : 1;
  const rawAwayDef = An > 0 ? (A!.ga / An) / leagueHome : 1;
  const K = V1.shrink;
  const shrink = (raw: number, n: number, prior: number) => (raw * n + prior * K) / (n + K);
  const homeAtt = shrink(rawHomeAtt, Hn, attPrior(hId));
  const homeDef = shrink(rawHomeDef, Hn, defPrior(hId));
  const awayAtt = shrink(rawAwayAtt, An, attPrior(aId));
  const awayDef = shrink(rawAwayDef, An, defPrior(aId));
  const clamp = (x: number) => Math.max(0.15, Math.min(6, x));
  return predFromLambdas(clamp(leagueHome * homeAtt * awayDef), clamp(leagueAway * awayAtt * homeDef));
}

// ---------- NEW v2 model ----------
function predictNew(r: ReturnType<typeof buildRatings>, hId: number, aId: number, lg: number): Pred {
  const l = teamLambdas(r, hId, aId, lg);
  const m = marketProbs(scoreMatrix(l.lamH, l.lamA, r.cfg));
  return { x: [m.homeWin, m.draw, m.awayWin], over25: m.over(2.5), btts: m.btts };
}

// ---------- metrics ----------
const clampP = (p: number) => Math.min(1 - 1e-9, Math.max(1e-9, p));
type Metrics = { n: number; logloss: number; brier: number; llOver: number; llBtts: number; bins: { sum: number; hit: number; n: number }[] };
function evalWindow(
  matches: Match[], winStart: number, winEnd: number,
  build: (before: Match[]) => any, predict: (r: any, h: number, a: number, lg: number) => Pred,
): Metrics {
  const buckets = new Map<string, Match[]>(); // window matches grouped by YYYY-MM
  for (const m of matches) {
    if (m.kickoff < winStart || m.kickoff >= winEnd) continue;
    const ym = new Date(m.kickoff).toISOString().slice(0, 7);
    let arr = buckets.get(ym); if (!arr) { arr = []; buckets.set(ym, arr); }
    arr.push(m);
  }
  let n = 0, ll = 0, brier = 0, llOver = 0, llBtts = 0;
  const bins = Array.from({ length: 10 }, () => ({ sum: 0, hit: 0, n: 0 })); // calibration on each 1X2 class prob
  for (const ym of [...buckets.keys()].sort()) {
    const [Y, M] = ym.split("-").map(Number);
    const monthStart = Date.UTC(Y, M - 1, 1);
    const r = build(matches.filter((m) => m.kickoff < monthStart)); // ratings from history BEFORE this month
    for (const m of buckets.get(ym)!) {
      const pr = predict(r, m.homeId, m.awayId, m.leagueId!);
      const y = m.hg > m.ag ? 0 : m.hg === m.ag ? 1 : 2;
      ll += -Math.log(clampP(pr.x[y]));
      brier += pr.x.reduce((s, p, k) => s + (p - (k === y ? 1 : 0)) ** 2, 0);
      const isOver = m.hg + m.ag > 2.5, isBtts = m.hg > 0 && m.ag > 0;
      llOver += -Math.log(clampP(isOver ? pr.over25 : 1 - pr.over25));
      llBtts += -Math.log(clampP(isBtts ? pr.btts : 1 - pr.btts));
      for (let k = 0; k < 3; k++) { const b = Math.max(0, Math.min(9, Math.floor((pr.x[k] || 0) * 10))); bins[b].sum += pr.x[k]; bins[b].hit += k === y ? 1 : 0; bins[b].n++; }
      n++;
    }
  }
  return { n, logloss: ll / n, brier: brier / n, llOver: llOver / n, llBtts: llBtts / n, bins };
}

// ---------- run ----------
console.log("loading finished fixtures…");
const all = await loadAll();
console.log(`  ${all.length} usable matches, ${new Date(all[0].kickoff).toISOString().slice(0,10)} → ${new Date(all[all.length-1].kickoff).toISOString().slice(0,10)}`);
const t = (q: number) => all[Math.floor(all.length * q)].kickoff;
const VAL_START = t(0.6), VAL_END = t(0.8), TEST_START = t(0.8), TEST_END = all[all.length - 1].kickoff + 1;
const buildNew = (cfg: ForecastConfig) => (before: Match[]) => buildRatings(before, cfg);

// coordinate search on VAL 1X2 log-loss. Structural params first, calibration (temp) last.
const GRID: Partial<Record<keyof ForecastConfig, number[]>> = {
  venueWeight: [1, 0.6, 0.4, 0.2, 0],
  leagueShrink: [0, 10, 30],
  halfLifeDays: [90, 180, 365],
  homeAdvElo: [40, 60, 80],
  eloK: [10, 20, 30],
  shrink: [2, 4, 8, 12],
  rho: [-0.15, -0.08, 0],
  eloPerLogGoal: [200, 300, 450],
  temp: [1, 1.08, 1.15, 1.25, 1.4],
};
const TUNE_KEYS = ["venueWeight", "leagueShrink", "halfLifeDays", "homeAdvElo", "eloK", "shrink", "rho", "eloPerLogGoal", "temp"] as (keyof ForecastConfig)[];
let best: ForecastConfig = { ...DEFAULTS };
const score = (cfg: ForecastConfig) => evalWindow(all, VAL_START, VAL_END, buildNew(cfg), predictNew).logloss;
let bestLL = score(best);
console.log(`\ntuning (VAL 1X2 log-loss, start ${bestLL.toFixed(4)})…`);
for (let pass = 0; pass < 2; pass++) {
  for (const key of TUNE_KEYS) {
    for (const v of GRID[key]!) {
      const cand = { ...best, [key]: v };
      const ll = score(cand);
      if (ll < bestLL - 1e-5) { bestLL = ll; best = cand; }
    }
    process.stdout.write(`\r  pass ${pass + 1} · ${key}=${best[key]} · VAL ll ${bestLL.toFixed(4)}          `);
  }
}
console.log("\n\nfitted params:", JSON.stringify({
  halfLifeDays: best.halfLifeDays, homeAdvElo: best.homeAdvElo, eloK: best.eloK, shrink: best.shrink,
  rho: best.rho, eloPerLogGoal: best.eloPerLogGoal, venueWeight: best.venueWeight,
  leagueShrink: best.leagueShrink, temp: best.temp,
}));

// final held-out TEST comparison: deployed v1 vs fitted v2
const v1 = evalWindow(all, TEST_START, TEST_END, buildV1, predictV1);
const v2 = evalWindow(all, TEST_START, TEST_END, buildNew(best), predictNew);
const pct = (a: number, b: number) => `${(((a - b) / a) * 100).toFixed(1)}%`;
console.log(`\n=== TEST window (${new Date(TEST_START).toISOString().slice(0,10)} → held out, n=${v2.n}) ===`);
console.log(`                    1X2 ll    Brier     O/U2.5 ll  BTTS ll`);
console.log(`  deployed v1       ${v1.logloss.toFixed(4)}    ${v1.brier.toFixed(4)}    ${v1.llOver.toFixed(4)}     ${v1.llBtts.toFixed(4)}`);
console.log(`  new v2 (fitted)   ${v2.logloss.toFixed(4)}    ${v2.brier.toFixed(4)}    ${v2.llOver.toFixed(4)}     ${v2.llBtts.toFixed(4)}`);
console.log(`  improvement       ${pct(v1.logloss, v2.logloss)}      ${pct(v1.brier, v2.brier)}      ${pct(v1.llOver, v2.llOver)}       ${pct(v1.llBtts, v2.llBtts)}   (positive = v2 better)`);
console.log(`\ncalibration (v2) — predicted 1X2 prob vs actual, by 10% bin:`);
for (let i = 0; i < 10; i++) { const b = v2.bins[i]; if (b.n) console.log(`  ${(i*10).toString().padStart(2)}-${i*10+10}%  pred ${(b.sum/b.n*100).toFixed(1)}%  actual ${(b.hit/b.n*100).toFixed(1)}%  (n=${b.n})`); }
console.log(`\ncalibration (v1 deployed) — same bins:`);
for (let i = 0; i < 10; i++) { const b = v1.bins[i]; if (b.n) console.log(`  ${(i*10).toString().padStart(2)}-${i*10+10}%  pred ${(b.sum/b.n*100).toFixed(1)}%  actual ${(b.hit/b.n*100).toFixed(1)}%  (n=${b.n})`); }
