// Feature backtest: does adjusting the v2 lambdas for REST/CONGESTION and RECENT FORM improve
// held-out prediction? Walk-forward by month (ratings frozen at month start — no leakage; rest/
// form features update fixture-by-fixture, as production would compute them fresh daily).
// Params are fitted on the FIT months and evaluated once on the later TEST months.
//
//   REST: multiplier exp(bShort) on a team's attack when it kicked off <= 3.5 days ago
//         (congestion fatigue), exp(bLong) when >= 10 days (rust / layoff).
//   FORM: a team's last-5 league-relative attack ratio vs its long-run rating, raised to gamma —
//         gamma 0 = incumbent model, higher = form moves the lambdas.
//
// Run:  BT_ANON=<publishable key> npx tsx perf/backtest-features.mts
import { buildRatings, teamLambdas, type Match, type Ratings } from "../src/lib/forecast.ts";

const URL = (process.env.BT_URL || "https://mbrtpetpgsggnlcazhqd.supabase.co").replace(/\/$/, "");
const ANON = process.env.BT_ANON || "";
if (!ANON) { console.error("Set BT_ANON to the publishable key"); process.exit(1); }

type Row = { league_id: number; home_team_id: number | null; away_team_id: number | null; ft_home: number | null; ft_away: number | null; home_goals: number | null; away_goals: number | null; kickoff_utc: string };
// Keyset pagination (cursor on kickoff_utc, tie-broken by id) with retries. Offset pagination
// dies at 500k+ rows: one timed-out page both drops data AND ends the loop early, which is
// exactly the silent truncation that produced the all-NaN first run of this script.
async function pageAfter(cursor: string): Promise<Row[]> {
  const u = `${URL}/rest/v1/fixtures?select=league_id,home_team_id,away_team_id,ft_home,ft_away,home_goals,away_goals,kickoff_utc&status=in.(FT,AET,PEN)&kickoff_utc=gt.${encodeURIComponent(cursor)}&order=kickoff_utc.asc&limit=1000`;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetch(u, { headers: { apikey: ANON, Authorization: `Bearer ${ANON}` } });
      if (res.ok) return res.json();
    } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
  }
  throw new Error(`page after ${cursor}: exhausted retries`);
}
async function loadAll(fromIso: string): Promise<Match[]> {
  const out: Match[] = [];
  const toMatch = (r: Row): Match | null => {
    const hg = r.ft_home ?? r.home_goals, ag = r.ft_away ?? r.away_goals;
    if (r.home_team_id == null || r.away_team_id == null || hg == null || ag == null) return null;
    const k = Date.parse(r.kickoff_utc);
    if (!Number.isFinite(k)) return null;
    return { homeId: r.home_team_id, awayId: r.away_team_id, hg, ag, kickoff: k, leagueId: r.league_id };
  };
  let cursor = fromIso;
  for (;;) {
    const pg = await pageAfter(cursor);
    if (!pg.length) break;
    for (const r of pg) { const m = toMatch(r); if (m) out.push(m); }
    cursor = pg[pg.length - 1].kickoff_utc; // strictly-greater cursor; same-timestamp stragglers
    if (pg.length < 1000) break;            // are rare and immaterial at this sample size
    process.stdout.write(`\r  loaded ~${out.length} (to ${cursor.slice(0, 10)})`);
  }
  process.stdout.write("\n");
  out.sort((a, b) => a.kickoff - b.kickoff);
  return out;
}

// ---------- score matrix -> metrics ----------
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

// ---------- per-fixture prediction context, collected once ----------
type Ctx = {
  lamH: number; lamA: number; // incumbent v2 lambdas
  restH: number; restA: number; // days since each team's previous match (99 = none known)
  formH: number | null; formA: number | null; // last-5 league-relative attack ratio / long-run rating
  hg: number; ag: number; // actuals
  test: boolean; // false = fit months, true = held-out test months
};

(async () => {
  console.log("loading fixtures…");
  // ~15 months: enough history behind the earliest ratings boundary (halfLife 90d ⇒ >4 half-lives)
  const from = new Date(); from.setUTCMonth(from.getUTCMonth() - 15);
  const all = await loadAll(from.toISOString());
  console.log(`  ${all.length} finished matches since ${from.toISOString().slice(0, 10)}`);

  // months: fit on M-4..M-3, test on M-2..M-1 (last 4 complete months, temporal split)
  const end = new Date(); end.setUTCDate(1); end.setUTCHours(0, 0, 0, 0); // start of current month
  const monthStart = (k: number) => { const d = new Date(end); d.setUTCMonth(d.getUTCMonth() - k); return d.getTime(); };
  const FIT_FROM = monthStart(4), TEST_FROM = monthStart(2), TEST_TO = end.getTime();

  // ratings per month boundary (frozen at month start, exactly like the engine rebuilds daily
  // from only-past matches — the monthly freeze just makes the walk cheap)
  const bounds = [monthStart(4), monthStart(3), monthStart(2), monthStart(1)];
  const ratingsAt = new Map<number, Ratings>();
  for (const b of bounds) {
    const hist = all.filter((m) => m.kickoff < b);
    ratingsAt.set(b, buildRatings(hist));
    process.stdout.write(`\r  ratings @ ${new Date(b).toISOString().slice(0, 10)} (${hist.length} matches)`);
  }
  console.log();

  // walk chronologically keeping per-team last-kickoff + last-5 (league-relative attack ratios)
  const lastKick = new Map<number, number>();
  const last5 = new Map<number, number[]>(); // league-relative goals-for ratios, newest last
  const push5 = (id: number, v: number) => { const a = last5.get(id) ?? []; a.push(v); if (a.length > 5) a.shift(); last5.set(id, a); };

  const ctxs: Ctx[] = [];
  for (const m of all) {
    const inWindow = m.kickoff >= FIT_FROM && m.kickoff < TEST_TO;
    if (inWindow) {
      const b = bounds.filter((x) => x <= m.kickoff).pop()!;
      const r = ratingsAt.get(b)!;
      const lam = teamLambdas(r, m.homeId, m.awayId, m.leagueId);
      if (lam.confident) {
        const day = 86400_000;
        const lkH = lastKick.get(m.homeId), lkA = lastKick.get(m.awayId);
        // long-run attack rating each side's form is compared against (same shrunk blend the model
        // uses internally — approximated by overall gf ratio; thin data -> no form signal)
        const oh = r.overall.get(m.homeId), oa = r.overall.get(m.awayId);
        const longH = oh && oh.n >= 4 ? oh.gf / oh.n : null;
        const longA = oa && oa.n >= 4 ? oa.gf / oa.n : null;
        const f5h = last5.get(m.homeId), f5a = last5.get(m.awayId);
        ctxs.push({
          lamH: lam.lamH, lamA: lam.lamA,
          restH: lkH ? Math.min(99, (m.kickoff - lkH) / day) : 99,
          restA: lkA ? Math.min(99, (m.kickoff - lkA) / day) : 99,
          formH: f5h && f5h.length === 5 && longH ? (f5h.reduce((s, x) => s + x, 0) / 5) / Math.max(0.1, longH) : null,
          formA: f5a && f5a.length === 5 && longA ? (f5a.reduce((s, x) => s + x, 0) / 5) / Math.max(0.1, longA) : null,
          hg: m.hg, ag: m.ag, test: m.kickoff >= TEST_FROM,
        });
      }
    }
    // update trackers AFTER predicting this fixture (features always strictly past)
    lastKick.set(m.homeId, m.kickoff); lastKick.set(m.awayId, m.kickoff);
    const b0 = bounds[0];
    const r0 = ratingsAt.get(bounds.filter((x) => x <= Math.max(m.kickoff, b0)).pop() ?? b0)!;
    const lg = m.leagueId ?? -1;
    const lh = r0.leagueHome.get(lg), la = r0.leagueAway.get(lg);
    const mh = lh && lh.n > 0 ? lh.goals / lh.n : 1.45, ma = la && la.n > 0 ? la.goals / la.n : 1.15;
    push5(m.homeId, m.hg / Math.max(0.1, mh));
    push5(m.awayId, m.ag / Math.max(0.1, ma));
  }
  const fit = ctxs.filter((c) => !c.test), test = ctxs.filter((c) => c.test);
  console.log(`  fit n=${fit.length}  test n=${test.length}`);
  if (fit.length < 5000 || test.length < 5000) {
    console.error("sample too thin — data load or window bug, refusing to fit"); process.exit(1);
  }

  // ---------- evaluate a (bShort, bLong, gamma) combo ----------
  const CL = (x: number) => Math.max(0.15, Math.min(6, x));
  function evalCombo(rows: Ctx[], bShort: number, bLong: number, gamma: number) {
    let ll = 0, br = 0, llOU = 0, n = 0;
    for (const c of rows) {
      let lh = c.lamH, la = c.lamA;
      const restMul = (rest: number) => (rest <= 3.5 ? Math.exp(bShort) : rest >= 10 && rest < 99 ? Math.exp(bLong) : 1);
      lh *= restMul(c.restH); la *= restMul(c.restA);
      if (gamma > 0) {
        if (c.formH != null) lh *= Math.pow(Math.max(0.6, Math.min(1.6, c.formH)), gamma);
        if (c.formA != null) la *= Math.pow(Math.max(0.6, Math.min(1.6, c.formA)), gamma);
      }
      const o = outcomes(CL(lh), CL(la));
      const idx = c.hg > c.ag ? 0 : c.hg === c.ag ? 1 : 2;
      ll += -Math.log(clampP(o.x[idx]));
      br += o.x.reduce((s, p, i) => s + (p - (i === idx ? 1 : 0)) ** 2, 0);
      const isOver = c.hg + c.ag > 2.5 ? 1 : 0;
      llOU += -(isOver * Math.log(clampP(o.over25)) + (1 - isOver) * Math.log(clampP(1 - o.over25)));
      n++;
    }
    return { ll: ll / n, br: br / n, llOU: llOU / n };
  }

  // ---------- fit: coordinate grid on the fit months ----------
  console.log("\nfitting on months -4..-3 …");
  const base = evalCombo(fit, 0, 0, 0);
  console.log(`  incumbent   fit LL=${base.ll.toFixed(5)}  Brier=${base.br.toFixed(5)}  OU-LL=${base.llOU.toFixed(5)}`);
  let best = { bShort: 0, bLong: 0, gamma: 0, ll: base.ll };
  for (const bShort of [-0.10, -0.06, -0.03, 0]) {
    for (const bLong of [-0.06, -0.03, 0, 0.03]) {
      for (const gamma of [0, 0.05, 0.1, 0.2, 0.3]) {
        const e = evalCombo(fit, bShort, bLong, gamma);
        if (e.ll < best.ll) best = { bShort, bLong, gamma, ll: e.ll };
      }
    }
  }
  console.log(`  fitted: bShort=${best.bShort} bLong=${best.bLong} gamma=${best.gamma}  (fit LL ${best.ll.toFixed(5)}, ${((1 - best.ll / base.ll) * 100).toFixed(2)}% better)`);

  // ---------- the verdict: held-out test months ----------
  console.log("\nheld-out test months -2..-1:");
  const t0 = evalCombo(test, 0, 0, 0);
  const t1 = evalCombo(test, best.bShort, best.bLong, best.gamma);
  const restOnly = evalCombo(test, best.bShort, best.bLong, 0);
  const formOnly = evalCombo(test, 0, 0, best.gamma);
  const line = (name: string, e: { ll: number; br: number; llOU: number }) =>
    console.log(`  ${name.padEnd(12)} LL=${e.ll.toFixed(5)} (${((1 - e.ll / t0.ll) * 100).toFixed(2)}%)  Brier=${e.br.toFixed(5)}  OU-LL=${e.llOU.toFixed(5)}`);
  line("incumbent", t0);
  line("rest-only", restOnly);
  line("form-only", formOnly);
  line("rest+form", t1);
  console.log("\npositive % = better than incumbent. Ship only what wins here.");
})();
