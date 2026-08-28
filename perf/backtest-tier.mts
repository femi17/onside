// Tier-seeded Elo backtest — does seeding a team's starting Elo by its league tier improve
// prediction, especially on domestic-cup / cross-tier fixtures, without regressing overall?
//
// Airtight rules:
//   - Walk-forward by month: ratings AND tier assignments for a test month are computed ONLY
//     from matches strictly before that month (no leakage, ever).
//   - Seed offsets (X = top-vs-second gap, Y = cup-only-team penalty) are fitted on a
//     VALIDATION window and then judged untouched on a later TEST window.
//   - Arm A is the deployed v2 model verbatim (DEFAULTS, no seed); Arm B differs ONLY in the seed.
//
// Slices reported: all fixtures / domestic cups / cross-tier cup ties.
//
// Run:  cd perf && BT_ANON=<anon key> npx tsx backtest-tier.mts
import { buildRatings, forecast, type Match } from "../src/lib/forecast.ts";

const URL = (process.env.BT_URL || "https://mbrtpetpgsggnlcazhqd.supabase.co").replace(/\/$/, "");
const ANON = process.env.BT_ANON || "";
if (!ANON) { console.error("Set BT_ANON to the anon key"); process.exit(1); }
const H = { apikey: ANON, Authorization: `Bearer ${ANON}` };

// ---------- load fixtures (same pager as backtest.mts) ----------
// KEYSET pagination (kickoff_utc, id cursor) — deep OFFSET paging over 800k rows hits statement
// timeouts, and the old loader treated a failed page as end-of-data, silently truncating the
// dataset (and with it the whole test window). Keyset stays fast at any depth; failures RETRY
// instead of terminating; end-of-data is only a successful short page.
type Row = { id: number; league_id: number; home_team_id: number | null; away_team_id: number | null; ft_home: number | null; ft_away: number | null; home_goals: number | null; away_goals: number | null; kickoff_utc: string };
async function pageAfter(cursor: { t: string; id: number } | null): Promise<Row[]> {
  const base = `${URL}/rest/v1/fixtures?select=id,league_id,home_team_id,away_team_id,ft_home,ft_away,home_goals,away_goals,kickoff_utc&status=in.(FT,AET,PEN)&order=kickoff_utc.asc,id.asc&limit=1000`;
  const u = cursor
    ? `${base}&or=${encodeURIComponent(`(kickoff_utc.gt.${cursor.t},and(kickoff_utc.eq.${cursor.t},id.gt.${cursor.id}))`)}`
    : base;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const res = await fetch(u, { headers: H });
      if (res.ok) return res.json();
    } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
  }
  throw new Error(`page failed after retries (cursor=${cursor?.t ?? "start"})`);
}
async function loadAll(): Promise<Match[]> {
  const out: Match[] = [];
  const toMatch = (r: Row): Match | null => {
    const hg = r.ft_home ?? r.home_goals, ag = r.ft_away ?? r.away_goals;
    if (r.home_team_id == null || r.away_team_id == null || hg == null || ag == null) return null;
    return { homeId: r.home_team_id, awayId: r.away_team_id, hg, ag, kickoff: Date.parse(r.kickoff_utc), leagueId: r.league_id };
  };
  let cursor: { t: string; id: number } | null = null;
  let rows = 0;
  for (;;) {
    const pg = await pageAfter(cursor);
    rows += pg.length;
    for (const r of pg) { const m = toMatch(r); if (m) out.push(m); }
    if (pg.length < 1000) break;
    const last = pg[pg.length - 1];
    cursor = { t: last.kickoff_utc, id: last.id };
    if (rows % 20000 === 0) process.stdout.write(`\r  loaded ~${rows} rows (${out.length} usable)`);
  }
  process.stdout.write(`\n  total rows=${rows} usable=${out.length}\n`);
  out.sort((a, b) => a.kickoff - b.kickoff);
  return out;
}

// ---------- league metadata ----------
type League = { id: number; name: string; country: string | null; tier: string | null; type: string | null };
async function loadLeagues(): Promise<Map<number, League>> {
  const res = await fetch(`${URL}/rest/v1/leagues?select=id,name,country,tier,type&limit=2000`, { headers: H });
  if (!res.ok) throw new Error(`leagues: ${res.status}`);
  const rows = (await res.json()) as League[];
  return new Map(rows.map((l) => [l.id, l]));
}

const CUP_RE = /\b(cup|pokal|cupen|beker|copa|coppa|coupe|ta[çc]a|karika[s]?|kup[a]?|puchar|pohár|pokal|trophy|shield|beker)\b/i;
const FRIENDLY_RE = /friendl/i;
const INTL_COUNTRIES = new Set(["Europe", "World", "International", "South-America", "Asia", "Africa", "North-America", "Oceania"]);

function classify(lg: League | undefined) {
  if (!lg) return { cup: false, domesticCup: false, friendly: false, intl: false, numTier: null as number | null };
  const friendly = FRIENDLY_RE.test(lg.name);
  const cup = !friendly && (lg.type === "Cup" || CUP_RE.test(lg.name));
  const intl = INTL_COUNTRIES.has(lg.country ?? "") || lg.tier === "uefa";
  const t = lg.tier;
  const numTier = t === "top" || t === "sa_top" || t === "as_top" ? 1 : t === "mid" ? 2 : null;
  return { cup, domesticCup: cup && !intl, friendly, intl, numTier };
}

// ---------- per-boundary team tiers (from history only) ----------
// tier 1/2: the tiered league the team appeared in most over the trailing 365 days
// tier 3 (proxy): team seen >=2 times, ONLY ever in cup competitions -> a lower-league cup entrant
type TeamTier = { tier: 1 | 2 | 3 | null };
function assignTiers(hist: Match[], leagues: Map<number, League>, boundary: number): Map<number, TeamTier> {
  const yearAgo = boundary - 365 * 86400_000;
  const tierCounts = new Map<number, { t1: number; t2: number }>();
  const seen = new Map<number, { total: number; nonCup: number }>();
  for (const m of hist) {
    const cls = classify(leagues.get(m.leagueId ?? -1));
    for (const id of [m.homeId, m.awayId]) {
      if (cls.friendly) continue;
      const s = seen.get(id) ?? { total: 0, nonCup: 0 };
      s.total++; if (!cls.cup) s.nonCup++;
      seen.set(id, s);
      if (m.kickoff >= yearAgo && cls.numTier) {
        const c = tierCounts.get(id) ?? { t1: 0, t2: 0 };
        if (cls.numTier === 1) c.t1++; else c.t2++;
        tierCounts.set(id, c);
      }
    }
  }
  const out = new Map<number, TeamTier>();
  for (const [id, s] of seen) {
    const c = tierCounts.get(id);
    if (c && c.t1 + c.t2 >= 5) out.set(id, { tier: c.t1 >= c.t2 ? 1 : 2 });
    else if (s.total >= 2 && s.nonCup === 0) out.set(id, { tier: 3 });
    else out.set(id, { tier: null });
  }
  return out;
}

// ---------- scoring ----------
type Acc = { n: number; ll: number; brier: number; hit: number };
const acc = (): Acc => ({ n: 0, ll: 0, brier: 0, hit: 0 });
function score(a: Acc, p: [number, number, number], outcome: 0 | 1 | 2) {
  const EPS = 1e-12;
  a.n++;
  a.ll += -Math.log(Math.max(EPS, p[outcome]));
  for (let k = 0; k < 3; k++) { const y = k === outcome ? 1 : 0; a.brier += (p[k] - y) ** 2; }
  const pick = p.indexOf(Math.max(...p));
  if (pick === outcome) a.hit++;
}
const fmt = (a: Acc) => a.n ? `n=${a.n}  LL=${(a.ll / a.n).toFixed(5)}  Brier=${(a.brier / a.n).toFixed(5)}  fav-hit=${((a.hit / a.n) * 100).toFixed(1)}%` : "n=0";

// ---------- one walk-forward evaluation for a seed config over a month range ----------
function monthStart(y: number, m0: number): number { return Date.UTC(y, m0, 1); }
type SliceAccs = { all: Acc; cup: Acc; cross: Acc };

// month context is seed-independent (history slice + tier map) — computed once, reused by every
// grid point so the fit loop only pays for the Elo/ratings rebuild that the seed actually changes
type MonthCtx = { hist: Match[]; test: Match[]; tiers: Map<number, TeamTier> };
function buildCtxs(matches: Match[], leagues: Map<number, League>, months: { from: number; to: number }[]): MonthCtx[] {
  const lo = (t: number) => { // first index with kickoff >= t (matches sorted)
    let a = 0, b = matches.length;
    while (a < b) { const m = (a + b) >> 1; if (matches[m].kickoff < t) a = m + 1; else b = m; }
    return a;
  };
  return months.map((w) => {
    const cut = lo(w.from), end = lo(w.to);
    const hist = matches.slice(0, cut), test = matches.slice(cut, end);
    return { hist, test, tiers: assignTiers(hist, leagues, w.from) };
  }).filter((c) => c.hist.length && c.test.length);
}

function evalRange(
  ctxs: MonthCtx[], leagues: Map<number, League>, X: number, Y: number,
  calib?: { bins: { pSum: number; hits: number; n: number }[] },
): SliceAccs {
  const S: SliceAccs = { all: acc(), cup: acc(), cross: acc() };
  for (const { hist, test, tiers } of ctxs) {
    const seed = (id: number): number => {
      const t = tiers.get(id)?.tier;
      if (t === 1) return 1500 + X / 2;
      if (t === 2) return 1500 - X / 2;
      if (t === 3) return 1500 - Y;
      return 1500;
    };
    const r = buildRatings(hist, {}, X === 0 && Y === 0 ? undefined : seed);
    for (const m of test) {
      const cls = classify(leagues.get(m.leagueId ?? -1));
      if (cls.friendly) continue;
      const f = forecast(r, m.homeId, m.awayId, m.leagueId);
      const p: [number, number, number] = [f.markets.homeWin, f.markets.draw, f.markets.awayWin];
      const outcome: 0 | 1 | 2 = m.hg > m.ag ? 0 : m.hg === m.ag ? 1 : 2;
      score(S.all, p, outcome);
      if (cls.domesticCup) {
        score(S.cup, p, outcome);
        const tH = tiers.get(m.homeId)?.tier, tA = tiers.get(m.awayId)?.tier;
        if (tH != null && tA != null && tH !== tA) {
          score(S.cross, p, outcome);
          if (calib) {
            const fav = Math.max(p[0], p[2]);
            const favSide: 0 | 2 = p[0] >= p[2] ? 0 : 2;
            const b = Math.min(9, Math.floor(fav * 10));
            calib.bins[b].pSum += fav; calib.bins[b].n++;
            if (outcome === favSide) calib.bins[b].hits++;
          }
        }
      }
    }
  }
  return S;
}

// ---------- main ----------
(async () => {
  console.log("Loading fixtures…");
  const matches = await loadAll();
  const leagues = await loadLeagues();
  console.log(`fixtures=${matches.length}  leagues=${leagues.size}`);

  const mkMonths = (fromY: number, fromM0: number, count: number) =>
    Array.from({ length: count }, (_, i) => {
      const y = fromY + Math.floor((fromM0 + i) / 12), m = (fromM0 + i) % 12;
      return { from: monthStart(y, m), to: monthStart(m === 11 ? y + 1 : y, (m + 1) % 12) };
    });
  console.log("Building month contexts…");
  const VAL = buildCtxs(matches, leagues, mkMonths(2024, 7, 12));  // 2024-08 .. 2025-07
  const TEST = buildCtxs(matches, leagues, mkMonths(2025, 7, 13)); // 2025-08 .. 2026-08

  // ----- fit X, Y on validation (primary: cross-tier LL; guard: overall LL must not worsen >0.1%)
  console.log("\n== validation fit ==");
  const base = evalRange(VAL, leagues, 0, 0);
  console.log(`A (no seed)   all: ${fmt(base.all)}\n              cup: ${fmt(base.cup)}\n            cross: ${fmt(base.cross)}`);
  let best = { X: 0, Y: 0, ll: base.cross.ll / Math.max(1, base.cross.n) };
  for (const X of [0, 60, 120, 180, 240, 300, 360]) {
    for (const Y of [0, 80, 120, 160, 200, 240]) {
      if (X === 0 && Y === 0) continue;
      const s = evalRange(VAL, leagues, X, Y);
      const cross = s.cross.ll / Math.max(1, s.cross.n);
      const allDelta = (s.all.ll / s.all.n) / (base.all.ll / base.all.n) - 1;
      console.log(`  X=${X} Y=${Y}  cross-LL=${cross.toFixed(5)}  allΔ=${(allDelta * 100).toFixed(3)}%`);
      if (cross < best.ll && allDelta < 0.001) best = { X, Y, ll: cross };
    }
  }
  console.log(`fitted: X=${best.X} Y=${best.Y}`);

  // ----- final judgement on untouched test window
  console.log("\n== test window (untouched) ==");
  const calibA = { bins: Array.from({ length: 10 }, () => ({ pSum: 0, hits: 0, n: 0 })) };
  const calibB = { bins: Array.from({ length: 10 }, () => ({ pSum: 0, hits: 0, n: 0 })) };
  const A = evalRange(TEST, leagues, 0, 0, calibA);
  const B = evalRange(TEST, leagues, best.X, best.Y, calibB);
  for (const [label, S] of [["A (deployed v2)", A], ["B (tier-seeded)", B]] as const) {
    console.log(`${label}\n   all: ${fmt(S.all)}\n   cup: ${fmt(S.cup)}\n cross: ${fmt(S.cross)}`);
  }
  const pct = (a: number, b: number) => (((b - a) / a) * 100).toFixed(2) + "%";
  if (A.cross.n && B.cross.n) {
    console.log(`\nB vs A — cross-tier LL: ${pct(A.cross.ll / A.cross.n, B.cross.ll / B.cross.n)}  ` +
      `cup LL: ${pct(A.cup.ll / A.cup.n, B.cup.ll / B.cup.n)}  all LL: ${pct(A.all.ll / A.all.n, B.all.ll / B.all.n)}`);
  }
  console.log("\ncross-tier favourite calibration (test window)  [bin: predicted vs actual]");
  for (let b = 0; b < 10; b++) {
    const a = calibA.bins[b], c = calibB.bins[b];
    if (a.n < 20 && c.n < 20) continue;
    const line = (x: { pSum: number; hits: number; n: number }) => x.n ? `${((x.pSum / x.n) * 100).toFixed(1)}→${((x.hits / x.n) * 100).toFixed(1)} (n=${x.n})` : "—";
    console.log(`  ${b * 10}-${b * 10 + 10}%   A: ${line(a)}   B: ${line(c)}`);
  }
})();
