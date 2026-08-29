// xG-ratings backtest: do attack/defence rates learned from EFFECTIVE goals (xgWeight*xG +
// (1-xgWeight)*goals, where xG exists) predict better than goals-only? Uses the real forecast.ts
// (xgWeight config, default 0 = incumbent), walk-forward by month, α fitted on the FIT months,
// verdict on the held-out TEST months. Reports overall AND the xG-covered subset (both teams
// with ≥5 xG matches in history) — coverage is ~top leagues only, so the gain concentrates there.
//
// Run:  BT_ANON=<publishable key> npx tsx perf/backtest-xg.mts
import { buildRatings, teamLambdas, type Match, type Ratings } from "../src/lib/forecast.ts";

const URL = (process.env.BT_URL || "https://mbrtpetpgsggnlcazhqd.supabase.co").replace(/\/$/, "");
const ANON = process.env.BT_ANON || "";
if (!ANON) { console.error("Set BT_ANON to the publishable key"); process.exit(1); }
const H = { apikey: ANON, Authorization: `Bearer ${ANON}` };

// ---------- fixtures (keyset pagination — offset pagination silently truncates at this size) ----------
type Row = { id: number; league_id: number; home_team_id: number | null; away_team_id: number | null; ft_home: number | null; ft_away: number | null; home_goals: number | null; away_goals: number | null; kickoff_utc: string };
async function pageAfter(cursor: string): Promise<Row[]> {
  const u = `${URL}/rest/v1/fixtures?select=id,league_id,home_team_id,away_team_id,ft_home,ft_away,home_goals,away_goals,kickoff_utc&status=in.(FT,AET,PEN)&kickoff_utc=gt.${encodeURIComponent(cursor)}&order=kickoff_utc.asc&limit=1000`;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetch(u, { headers: H });
      if (res.ok) return res.json();
    } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
  }
  throw new Error(`page after ${cursor}: exhausted retries`);
}
type MatchX = Match & { fid: number };
async function loadFixtures(fromIso: string): Promise<MatchX[]> {
  const out: MatchX[] = [];
  let cursor = fromIso;
  for (;;) {
    const pg = await pageAfter(cursor);
    if (!pg.length) break;
    for (const r of pg) {
      const hg = r.ft_home ?? r.home_goals, ag = r.ft_away ?? r.away_goals;
      const k = Date.parse(r.kickoff_utc);
      if (r.home_team_id == null || r.away_team_id == null || hg == null || ag == null || !Number.isFinite(k)) continue;
      out.push({ fid: r.id, homeId: r.home_team_id, awayId: r.away_team_id, hg, ag, kickoff: k, leagueId: r.league_id });
    }
    cursor = pg[pg.length - 1].kickoff_utc;
    if (pg.length < 1000) break;
    process.stdout.write(`\r  fixtures ~${out.length} (to ${cursor.slice(0, 10)})`);
  }
  process.stdout.write("\n");
  out.sort((a, b) => a.kickoff - b.kickoff);
  return out;
}

// ---------- xG per fixture (fixture_stats.stats.expected_goals = [home, away]) ----------
async function loadXg(): Promise<Map<number, [number, number]>> {
  const map = new Map<number, [number, number]>();
  let cursor = 0;
  for (;;) {
    const u = `${URL}/rest/v1/fixture_stats?select=fixture_id,stats&stats->expected_goals=not.is.null&fixture_id=gt.${cursor}&order=fixture_id.asc&limit=1000`;
    const res = await fetch(u, { headers: H });
    if (!res.ok) throw new Error(`xg page ${cursor}: ${res.status}`);
    const pg: { fixture_id: number; stats: { expected_goals?: [number, number] } }[] = await res.json();
    if (!pg.length) break;
    for (const r of pg) {
      const xg = r.stats?.expected_goals;
      if (Array.isArray(xg) && xg.length === 2 && (Number(xg[0]) > 0 || Number(xg[1]) > 0)) {
        map.set(r.fixture_id, [Number(xg[0]), Number(xg[1])]);
      }
    }
    cursor = pg[pg.length - 1].fixture_id;
    if (pg.length < 1000) break;
    process.stdout.write(`\r  xg rows ~${map.size}`);
  }
  process.stdout.write("\n");
  return map;
}

// ---------- metrics ----------
const FACT = [1, 1, 2, 6, 24, 120, 720, 5040, 40320, 362880, 3628800];
const pois = (k: number, l: number) => (Math.exp(-l) * Math.pow(l, k)) / FACT[k];
function outcomes(lamH: number, lamA: number): { x: [number, number, number]; over25: number } {
  const N = 10;
  let hw = 0, dr = 0, aw = 0, over = 0, tot = 0;
  for (let x = 0; x <= N; x++) for (let y = 0; y <= N; y++) {
    const v = pois(x, lamH) * pois(y, lamA); tot += v;
    if (x > y) hw += v; else if (x === y) dr += v; else aw += v;
    if (x + y > 2.5) over += v;
  }
  return { x: [hw / tot, dr / tot, aw / tot], over25: over / tot };
}
const clampP = (p: number) => Math.min(0.999, Math.max(0.001, p));

type TestRow = { m: MatchX; covered: boolean };
function evalAlpha(ratingsByBound: Map<number, Ratings>, bounds: number[], rows: TestRow[], subset: "all" | "covered") {
  let ll = 0, br = 0, llOU = 0, n = 0;
  for (const { m, covered } of rows) {
    if (subset === "covered" && !covered) continue;
    const b = bounds.filter((x) => x <= m.kickoff).pop()!;
    const lam = teamLambdas(ratingsByBound.get(b)!, m.homeId, m.awayId, m.leagueId);
    if (!lam.confident) continue;
    const o = outcomes(lam.lamH, lam.lamA);
    const idx = m.hg > m.ag ? 0 : m.hg === m.ag ? 1 : 2;
    ll += -Math.log(clampP(o.x[idx]));
    br += o.x.reduce((s, p, i) => s + (p - (i === idx ? 1 : 0)) ** 2, 0);
    const isOver = m.hg + m.ag > 2.5 ? 1 : 0;
    llOU += -(isOver * Math.log(clampP(o.over25)) + (1 - isOver) * Math.log(clampP(1 - o.over25)));
    n++;
  }
  return { ll: ll / n, br: br / n, llOU: llOU / n, n };
}

(async () => {
  console.log("loading…");
  const from = new Date(); from.setUTCMonth(from.getUTCMonth() - 15);
  const [all, xg] = await Promise.all([loadFixtures(from.toISOString()), loadXg()]);
  let tagged = 0;
  for (const m of all) { const x = xg.get(m.fid); if (x) { m.xgH = x[0]; m.xgA = x[1]; tagged++; } }
  console.log(`  ${all.length} matches, ${xg.size} xG rows, ${tagged} tagged`);

  const end = new Date(); end.setUTCDate(1); end.setUTCHours(0, 0, 0, 0);
  const monthStart = (k: number) => { const d = new Date(end); d.setUTCMonth(d.getUTCMonth() - k); return d.getTime(); };
  const FIT_FROM = monthStart(4), TEST_FROM = monthStart(2), TEST_TO = end.getTime();
  const bounds = [monthStart(4), monthStart(3), monthStart(2), monthStart(1)];

  // coverage flag: both teams have >=5 xG-tagged matches strictly before kickoff
  const xgSeen = new Map<number, number>();
  const rows: { m: MatchX; covered: boolean; test: boolean }[] = [];
  for (const m of all) {
    if (m.kickoff >= FIT_FROM && m.kickoff < TEST_TO) {
      const covered = (xgSeen.get(m.homeId) ?? 0) >= 5 && (xgSeen.get(m.awayId) ?? 0) >= 5;
      rows.push({ m, covered, test: m.kickoff >= TEST_FROM });
    }
    if (m.xgH != null) {
      xgSeen.set(m.homeId, (xgSeen.get(m.homeId) ?? 0) + 1);
      xgSeen.set(m.awayId, (xgSeen.get(m.awayId) ?? 0) + 1);
    }
  }
  const fitRows = rows.filter((r) => !r.test), testRows = rows.filter((r) => r.test);
  const covFit = fitRows.filter((r) => r.covered).length, covTest = testRows.filter((r) => r.covered).length;
  console.log(`  fit n=${fitRows.length} (covered ${covFit})  test n=${testRows.length} (covered ${covTest})`);
  if (fitRows.length < 5000 || testRows.length < 5000) { console.error("sample too thin"); process.exit(1); }

  const ALPHAS = [0, 0.3, 0.5, 0.7, 1.0];
  const results: { a: number; fit: any; testAll: any; testCov: any }[] = [];
  for (const a of ALPHAS) {
    const rb = new Map<number, Ratings>();
    for (const b of bounds) rb.set(b, buildRatings(all.filter((m) => m.kickoff < b), { xgWeight: a }));
    results.push({
      a,
      fit: evalAlpha(rb, bounds, fitRows, "all"),
      testAll: evalAlpha(rb, bounds, testRows, "all"),
      testCov: evalAlpha(rb, bounds, testRows, "covered"),
    });
    process.stdout.write(`\r  α=${a} done`);
  }
  console.log("\n");

  const base = results.find((r) => r.a === 0)!;
  const pct = (x: number, b: number) => `${((1 - x / b) * 100).toFixed(2)}%`;
  console.log("α      FIT-LL       TEST-LL(all)          TEST-LL(xG-covered)      TEST-OU(all)");
  for (const r of results) {
    console.log(
      `${r.a.toFixed(1)}   ${r.fit.ll.toFixed(5)}   ${r.testAll.ll.toFixed(5)} (${pct(r.testAll.ll, base.testAll.ll)})   ` +
      `${r.testCov.ll.toFixed(5)} (${pct(r.testCov.ll, base.testCov.ll)}, n=${r.testCov.n})   ` +
      `${r.testAll.llOU.toFixed(5)} (${pct(r.testAll.llOU, base.testAll.llOU)})`,
    );
  }
  const bestFit = [...results].sort((x, y) => x.fit.ll - y.fit.ll)[0];
  console.log(`\nα chosen on FIT months: ${bestFit.a}`);
  console.log(`held-out verdict at that α: all ${pct(bestFit.testAll.ll, base.testAll.ll)}, xG-covered ${pct(bestFit.testCov.ll, base.testCov.ll)} (positive = better than goals-only)`);
})();
