// #2 preset sourcing — which (market × confidence floor) combos are actually VALIDATED?
// A confidence-default agent delivers a pick when the shown % clears its floor. So a preset is
// only safe to seed where, historically, the model's stated confidence HOLDS UP: for picks the
// model rates >= F, do >= F% actually land, with real volume?
//
// Walk-forward, no lookahead: ratings for each month are built ONLY from games before it.
// READ-ONLY — loads fixtures, recomputes the model (src/lib/forecast.ts), never writes.
//
// CAVEAT: live delivery gates on blend50(model, market) (pulled toward the bookmaker's price),
// not raw model prob. This sweep uses raw model prob — it measures MODEL calibration, which is the
// right question for "is this pattern real"; live shown% will sit between this and the market.
//
// Run:  npx tsx perf/sweep-confidence-presets.mts
import { buildRatings, forecast, type Match, type Ratings } from "../src/lib/forecast.ts";

const URL = "https://mbrtpetpgsggnlcazhqd.supabase.co";
const KEY = process.env.BT_ANON || "sb_publishable_hEf434o_sEatsxTHmW9msA_TTbXaNLU";
const H = { apikey: KEY, Authorization: `Bearer ${KEY}` };
const DAYS_BACK = 365;
const FLOORS = [0.60, 0.70, 0.80];
const MIN_N = 300; // volume bar for a floor to count as "seed-worthy" over a year

type Row = { id: number; league_id: number; home_team_id: number | null; away_team_id: number | null; ft_home: number | null; ft_away: number | null; home_goals: number | null; away_goals: number | null; kickoff_utc: string };

async function getJson(u: string): Promise<any[]> {
  for (let attempt = 0; attempt < 5; attempt++) {
    try { const res = await fetch(u, { headers: H }); if (res.ok) return res.json(); } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
  }
  throw new Error(`fetch failed: ${u.slice(0, 120)}`);
}

async function loadHistory(sinceIso: string): Promise<Row[]> {
  const out: Row[] = [];
  let cursor: { t: string; id: number } | null = null;
  for (;;) {
    const base = `${URL}/rest/v1/fixtures?select=id,league_id,home_team_id,away_team_id,ft_home,ft_away,home_goals,away_goals,kickoff_utc&status=in.(FT,AET,PEN)&kickoff_utc=gte.${sinceIso}&order=kickoff_utc.asc,id.asc&limit=1000`;
    const u = cursor ? `${base}&or=${encodeURIComponent(`(kickoff_utc.gt.${cursor.t},and(kickoff_utc.eq.${cursor.t},id.gt.${cursor.id}))`)}` : base;
    const pg = (await getJson(u)) as Row[];
    out.push(...pg);
    if (pg.length < 1000) break;
    const last = pg[pg.length - 1];
    cursor = { t: last.kickoff_utc, id: last.id };
    if (out.length % 50000 < 1000) process.stderr.write(`  history ~${out.length}\n`);
  }
  return out;
}

const hg_ag = (r: Row): [number, number] | null => {
  const hg = r.ft_home ?? r.home_goals, ag = r.ft_away ?? r.away_goals;
  return hg == null || ag == null ? null : [hg, ag];
};
const monthKey = (iso: string) => iso.slice(0, 7);

// candidate selections a confidence-default preset could ship: model prob + settlement outcome
type Mk = ReturnType<typeof forecast>["markets"];
const SELECTIONS: { key: string; prob: (m: Mk) => number; won: (h: number, a: number) => boolean }[] = [
  { key: "Over 1.5",       prob: (m) => m.over(1.5),  won: (h, a) => h + a >= 2 },
  { key: "Over 2.5",       prob: (m) => m.over(2.5),  won: (h, a) => h + a >= 3 },
  { key: "Over 3.5",       prob: (m) => m.over(3.5),  won: (h, a) => h + a >= 4 },
  { key: "Under 2.5",      prob: (m) => m.under(2.5), won: (h, a) => h + a <= 2 },
  { key: "Under 3.5",      prob: (m) => m.under(3.5), won: (h, a) => h + a <= 3 },
  { key: "BTTS yes",       prob: (m) => m.btts,       won: (h, a) => h > 0 && a > 0 },
  { key: "Home to score",  prob: (m) => m.homeToScore, won: (h, a) => h > 0 },
  { key: "Away to score",  prob: (m) => m.awayToScore, won: (h, a) => a > 0 },
  { key: "Home win",       prob: (m) => m.homeWin,    won: (h, a) => h > a },
  { key: "Away win",       prob: (m) => m.awayWin,    won: (h, a) => a > h },
  { key: "DC 1X",          prob: (m) => m.homeWin + m.draw, won: (h, a) => h >= a },
  { key: "DC X2",          prob: (m) => m.draw + m.awayWin, won: (h, a) => a >= h },
  { key: "DC 12",          prob: (m) => m.homeWin + m.awayWin, won: (h, a) => h !== a },
];

(async () => {
  const since = new Date(Date.now() - DAYS_BACK * 86400_000).toISOString();
  process.stderr.write("Loading history…\n");
  const rows = (await loadHistory(since)).filter((r) => r.home_team_id != null && r.away_team_id != null && hg_ag(r) != null);
  process.stderr.write(`usable fixtures=${rows.length}\n`);

  const allMatches: Match[] = rows.map((r) => { const [hg, ag] = hg_ag(r)!; return { homeId: r.home_team_id!, awayId: r.away_team_id!, hg, ag, kickoff: Date.parse(r.kickoff_utc), leagueId: r.league_id }; });

  const byMonth = new Map<string, Row[]>();
  for (const r of rows) { const k = monthKey(r.kickoff_utc); (byMonth.get(k) ?? byMonth.set(k, []).get(k)!).push(r); }
  const months = [...byMonth.keys()].sort();
  const WARMUP = 2;

  // per selection, per floor: n picks (model>=floor) and wins
  type Cell = { n: number; won: number };
  const stats = new Map<string, Map<number, Cell>>();
  for (const s of SELECTIONS) { const mm = new Map<number, Cell>(); for (const f of FLOORS) mm.set(f, { n: 0, won: 0 }); stats.set(s.key, mm); }

  let evalN = 0;
  for (let i = WARMUP; i < months.length; i++) {
    const m = months[i];
    const monthStart = Date.parse(`${m}-01T00:00:00Z`);
    const prior = allMatches.filter((x) => x.kickoff < monthStart);
    if (prior.length < 500) continue;
    const r: Ratings = buildRatings(prior, {});
    for (const f of byMonth.get(m)!) {
      const [hg, ag] = hg_ag(f)!;
      const fc = forecast(r, f.home_team_id!, f.away_team_id!, f.league_id);
      evalN++;
      for (const s of SELECTIONS) {
        const p = s.prob(fc.markets);
        const w = s.won(hg, ag);
        const cells = stats.get(s.key)!;
        for (const floor of FLOORS) if (p >= floor) { const c = cells.get(floor)!; c.n++; if (w) c.won++; }
      }
    }
    process.stderr.write(`  ${m}: eval=${byMonth.get(m)!.length}\n`);
  }

  console.log(`\n=== Confidence-default preset sweep · ${DAYS_BACK}d walk-forward · ${evalN} graded fixtures ===`);
  console.log(`For each market at each floor F: n picks the model rated >=F, and how many actually landed.`);
  console.log(`CLEARS = actual hit% >= floor (model's confidence held up). * = volume >= ${MIN_N}.\n`);
  const pad = (s: string, n: number) => s.padEnd(n);
  console.log(pad("Market", 16) + FLOORS.map((f) => pad(`>=${(f * 100).toFixed(0)}%`, 22)).join(""));
  const seedWorthy: { market: string; floor: number; n: number; hit: number }[] = [];
  for (const s of SELECTIONS) {
    const cells = stats.get(s.key)!;
    let rowStr = pad(s.key, 16);
    for (const floor of FLOORS) {
      const c = cells.get(floor)!;
      if (c.n === 0) { rowStr += pad("—", 22); continue; }
      const hit = c.won / c.n;
      const clears = hit >= floor;
      const vol = c.n >= MIN_N;
      const tag = `${clears ? "✓" : "✗"}${vol ? "*" : " "}`;
      rowStr += pad(`n=${c.n} ${(hit * 100).toFixed(1)}% ${tag}`, 22);
      if (clears && vol) seedWorthy.push({ market: s.key, floor, n: c.n, hit });
    }
    console.log(rowStr);
  }

  console.log(`\n=== SEED-WORTHY (clears floor AND n>=${MIN_N}) ===`);
  if (!seedWorthy.length) console.log("  none — no market's stated confidence held up at volume.");
  for (const x of seedWorthy.sort((a, b) => b.hit - a.hit))
    console.log(`  ${pad(x.market, 16)} floor>=${(x.floor * 100).toFixed(0)}%   n=${String(x.n).padStart(5)}   actual ${(x.hit * 100).toFixed(1)}%   (+${((x.hit - x.floor) * 100).toFixed(1)}pt margin)`);
})();
