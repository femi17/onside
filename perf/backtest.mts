// Forecast backtest + parameter fit.
//   - pages all finished fixtures from Supabase (anon read)
//   - walk-forward by month (ratings built ONLY from matches before each test month → no leakage)
//   - tunes the new model's params by coordinate search on a VALIDATION window (minimise 1X2 log-loss)
//   - reports log-loss / Brier / calibration of CURRENT (independent Poisson) vs NEW (Elo + Dixon-Coles)
//     on a held-out TEST window, and prints the fitted parameters to ship.
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
  // discover size, then fetch pages with light concurrency
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

// ---------- CURRENT model (replicates run-strategies: all-time rates, shrink→1, independent Poisson) ----------
const DEF_HOME = 1.45, DEF_AWAY = 1.15, SHRINK = 4;
type Cur = { lh: Map<number, [number, number]>; la: Map<number, [number, number]>; team: Map<number, { hgf: number; hga: number; hn: number; agf: number; aga: number; an: number }> };
function buildCurrent(ms: Match[]): Cur {
  const lh = new Map<number, [number, number]>(), la = new Map<number, [number, number]>();
  const team = new Map<number, { hgf: number; hga: number; hn: number; agf: number; aga: number; an: number }>();
  for (const m of ms) {
    const a = lh.get(m.leagueId!) ?? [0, 0]; a[0] += m.hg; a[1]++; lh.set(m.leagueId!, a);
    const b = la.get(m.leagueId!) ?? [0, 0]; b[0] += m.ag; b[1]++; la.set(m.leagueId!, b);
    const h = team.get(m.homeId) ?? { hgf: 0, hga: 0, hn: 0, agf: 0, aga: 0, an: 0 }; h.hgf += m.hg; h.hga += m.ag; h.hn++; team.set(m.homeId, h);
    const aw = team.get(m.awayId) ?? { hgf: 0, hga: 0, hn: 0, agf: 0, aga: 0, an: 0 }; aw.agf += m.ag; aw.aga += m.hg; aw.an++; team.set(m.awayId, aw);
  }
  return { lh, la, team };
}
const FACT = [1, 1, 2, 6, 24, 120, 720, 5040, 40320, 362880, 3628800, 39916800];
const pois = (k: number, l: number) => (Math.exp(-l) * Math.pow(l, k)) / FACT[k];
function oneX2FromLambda(lamH: number, lamA: number): [number, number, number] {
  let h = 0, d = 0, a = 0;
  for (let x = 0; x <= 10; x++) for (let y = 0; y <= 10; y++) { const p = pois(x, lamH) * pois(y, lamA); if (x > y) h += p; else if (x === y) d += p; else a += p; }
  const s = h + d + a; return [h / s, d / s, a / s];
}
function predictCurrent(c: Cur, hId: number, aId: number, lg: number): [number, number, number] {
  const L = c.lh.get(lg), A2 = c.la.get(lg);
  const lh = Math.max(0.1, L && L[1] ? L[0] / L[1] : DEF_HOME), la = Math.max(0.1, A2 && A2[1] ? A2[0] / A2[1] : DEF_AWAY);
  const H = c.team.get(hId), Aw = c.team.get(aId);
  const rate = (sum: number, n: number, mean: number) => (sum + SHRINK * mean) / (n + SHRINK);
  const homeAtt = H && H.hn ? rate(H.hgf, H.hn, lh) / lh : 1;
  const homeDef = H && H.hn ? rate(H.hga, H.hn, la) / la : 1;
  const awayAtt = Aw && Aw.an ? rate(Aw.agf, Aw.an, la) / la : 1;
  const awayDef = Aw && Aw.an ? rate(Aw.aga, Aw.an, lh) / lh : 1;
  const clamp = (x: number) => Math.max(0.15, Math.min(6, x));
  return oneX2FromLambda(clamp(lh * homeAtt * awayDef), clamp(la * awayAtt * homeDef));
}

// ---------- NEW model 1X2 ----------
function predictNew(r: ReturnType<typeof buildRatings>, hId: number, aId: number, lg: number): [number, number, number] {
  const l = teamLambdas(r, hId, aId, lg);
  const m = marketProbs(scoreMatrix(l.lamH, l.lamA, r.cfg));
  return [m.homeWin, m.draw, m.awayWin];
}

// ---------- metrics ----------
const clampP = (p: number) => Math.min(1 - 1e-9, Math.max(1e-9, p));
function evalWindow(
  matches: Match[], winStart: number, winEnd: number,
  build: (before: Match[]) => any, predict: (r: any, h: number, a: number, lg: number) => [number, number, number],
) {
  const buckets = new Map<string, Match[]>(); // window matches grouped by YYYY-MM
  for (const m of matches) {
    if (m.kickoff < winStart || m.kickoff >= winEnd) continue;
    const ym = new Date(m.kickoff).toISOString().slice(0, 7);
    let arr = buckets.get(ym); if (!arr) { arr = []; buckets.set(ym, arr); }
    arr.push(m);
  }
  let n = 0, ll = 0, brier = 0;
  const bins = Array.from({ length: 10 }, () => ({ sum: 0, hit: 0, n: 0 })); // calibration on each class's prob
  for (const ym of [...buckets.keys()].sort()) {
    const [Y, M] = ym.split("-").map(Number);
    const monthStart = Date.UTC(Y, M - 1, 1);
    const r = build(matches.filter((m) => m.kickoff < monthStart)); // ratings from history BEFORE this month
    for (const m of buckets.get(ym)!) {
      const ps = predict(r, m.homeId, m.awayId, m.leagueId!);
      const y = m.hg > m.ag ? 0 : m.hg === m.ag ? 1 : 2;
      ll += -Math.log(clampP(ps[y]));
      brier += ps.reduce((s, p, k) => s + (p - (k === y ? 1 : 0)) ** 2, 0);
      for (let k = 0; k < 3; k++) { const b = Math.max(0, Math.min(9, Math.floor((ps[k] || 0) * 10))); bins[b].sum += ps[k]; bins[b].hit += k === y ? 1 : 0; bins[b].n++; }
      n++;
    }
  }
  return { n, logloss: ll / n, brier: brier / n, bins };
}

// ---------- run ----------
console.log("loading finished fixtures…");
const all = await loadAll();
console.log(`  ${all.length} usable matches, ${new Date(all[0].kickoff).toISOString().slice(0,10)} → ${new Date(all[all.length-1].kickoff).toISOString().slice(0,10)}`);
const t = (q: number) => all[Math.floor(all.length * q)].kickoff;
const VAL_START = t(0.6), VAL_END = t(0.8), TEST_START = t(0.8), TEST_END = all[all.length - 1].kickoff + 1;
const buildNew = (cfg: ForecastConfig) => (before: Match[]) => buildRatings(before, cfg);

// coordinate search on VAL log-loss
const GRID: Record<keyof ForecastConfig, number[]> = {
  halfLifeDays: [90, 180, 365, 100000], homeAdvElo: [40, 60, 80], eloK: [10, 20, 30],
  shrink: [2, 4, 8], rho: [-0.15, -0.08, 0], eloPerLogGoal: [200, 300, 450],
  minMatches: [DEFAULTS.minMatches], defHome: [DEFAULTS.defHome], defAway: [DEFAULTS.defAway], maxGoals: [DEFAULTS.maxGoals],
};
let best: ForecastConfig = { ...DEFAULTS };
const score = (cfg: ForecastConfig) => evalWindow(all, VAL_START, VAL_END, buildNew(cfg), predictNew).logloss;
let bestLL = score(best);
console.log(`\ntuning (VAL log-loss, start ${bestLL.toFixed(4)})…`);
for (let pass = 0; pass < 2; pass++) {
  for (const key of ["halfLifeDays", "homeAdvElo", "eloK", "shrink", "rho", "eloPerLogGoal"] as (keyof ForecastConfig)[]) {
    for (const v of GRID[key]) {
      const cand = { ...best, [key]: v };
      const ll = score(cand);
      if (ll < bestLL - 1e-5) { bestLL = ll; best = cand; }
    }
    process.stdout.write(`\r  pass ${pass + 1} · ${key}=${best[key]} · VAL ll ${bestLL.toFixed(4)}          `);
  }
}
console.log("\n\nfitted params:", JSON.stringify({ halfLifeDays: best.halfLifeDays, homeAdvElo: best.homeAdvElo, eloK: best.eloK, shrink: best.shrink, rho: best.rho, eloPerLogGoal: best.eloPerLogGoal }));

// final held-out TEST comparison
const cur = evalWindow(all, TEST_START, TEST_END, buildCurrent, predictCurrent);
const neu = evalWindow(all, TEST_START, TEST_END, buildNew(best), predictNew);
const pct = (a: number, b: number) => `${(((a - b) / a) * 100).toFixed(1)}%`;
console.log(`\n=== TEST window (${new Date(TEST_START).toISOString().slice(0,10)} → held out, n=${neu.n}) ===`);
console.log(`               log-loss    Brier`);
console.log(`  current      ${cur.logloss.toFixed(4)}     ${cur.brier.toFixed(4)}`);
console.log(`  new (fitted) ${neu.logloss.toFixed(4)}     ${neu.brier.toFixed(4)}`);
console.log(`  improvement  ${pct(cur.logloss, neu.logloss)}      ${pct(cur.brier, neu.brier)}   (positive = new is better)`);
console.log(`\ncalibration (new) — predicted prob vs actual, by 10% bin:`);
for (let i = 0; i < 10; i++) { const b = neu.bins[i]; if (b.n) console.log(`  ${(i*10).toString().padStart(2)}-${i*10+10}%  pred ${(b.sum/b.n*100).toFixed(1)}%  actual ${(b.hit/b.n*100).toFixed(1)}%  (n=${b.n})`); }
