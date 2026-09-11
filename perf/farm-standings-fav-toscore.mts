// THROWAWAY FARM (chat-only) — hypothesis test for the "standings favourite to score" agent:
//   RULE: in a league fixture, the FAVOURITE = the higher-placed team. If the favourite sits
//   1st–4th AND the opponent sits 10th-or-lower, take the game and back the FAVOURITE TO SCORE
//   (home_to_score if they play home, away_to_score if away). Win = favourite scored >= 1 goal.
//
// We reconstruct POINT-IN-TIME standings from our own fixtures: for every (league, season) we
// process matches in kickoff order and read each team's rank from the table AS IT STOOD BEFORE
// that match — no lookahead. Standings are never stored; the live agent will fetch them from
// API-Football at run time. READ-ONLY: loads fixtures + league tiers, writes nothing.
//
// Run:  BT_ANON=<anon/publishable key> npx tsx perf/farm-standings-fav-toscore.mts
//   optional: FARM_DAYS=1600 (history window; default = everything)

const URL = "https://mbrtpetpgsggnlcazhqd.supabase.co";
const ANON = process.env.BT_ANON || "";
if (!ANON) { console.error("Set BT_ANON"); process.exit(1); }
const H = { apikey: ANON, Authorization: `Bearer ${ANON}` };

const FAV_TOP = 4;      // favourite must be ranked 1..4
const OPP_BOT = 10;     // opponent must be ranked >= 10
const MIN_PLAYED = 6;   // both teams must have played this many games (ranks meaningless earlier)
const MIN_TEAMS = 12;   // league-season must have >= 12 teams so "10th+" is a real position
const DAYS_BACK = Number(process.env.FARM_DAYS || 2000);

type Row = {
  id: number; league_id: number; season: number;
  home_team_id: number | null; away_team_id: number | null;
  ft_home: number | null; ft_away: number | null;
  home_goals: number | null; away_goals: number | null;
  kickoff_utc: string;
};

async function getJson(u: string): Promise<any[]> {
  for (let attempt = 0; attempt < 6; attempt++) {
    try { const res = await fetch(u, { headers: H }); if (res.ok) return res.json(); } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
  }
  throw new Error(`fetch failed: ${u.slice(0, 120)}`);
}

async function loadLeagueMeta(): Promise<Map<number, { type: string; tier: string | null }>> {
  const m = new Map<number, { type: string; tier: string | null }>();
  const rows = await getJson(`${URL}/rest/v1/leagues?select=id,type,tier&limit=5000`);
  for (const r of rows) m.set(r.id, { type: r.type ?? "", tier: r.tier ?? null });
  return m;
}
// Universe = the SAME leagues the live agent hunts: tier-tagged (league_mode 'all'), minus UEFA
// (European cups are knockout — no league table to reconstruct). `type` is unusable here (NULL for
// almost every league), so we scope by tier, which is exactly what resolveLeagueIds('all') does.
const eligibleLeague = (meta: Map<number, { type: string; tier: string | null }>, leagueId: number): boolean => {
  const t = meta.get(leagueId)?.tier ?? null;
  return t != null && t !== "uefa";
};

async function loadHistory(sinceIso: string): Promise<Row[]> {
  const out: Row[] = [];
  let cursor: { t: string; id: number } | null = null;
  for (;;) {
    const base = `${URL}/rest/v1/fixtures?select=id,league_id,season,home_team_id,away_team_id,ft_home,ft_away,home_goals,away_goals,kickoff_utc&status=in.(FT,AET,PEN)&kickoff_utc=gte.${sinceIso}&order=kickoff_utc.asc,id.asc&limit=1000`;
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

const hg = (r: Row) => r.ft_home ?? r.home_goals;
const ag = (r: Row) => r.ft_away ?? r.away_goals;

type TeamRow = { pts: number; played: number; gf: number; ga: number };
type Agg = { n: number; scored: number };
const mk = (): Agg => ({ n: 0, scored: 0 });
const add = (a: Agg, favScored: boolean) => { a.n++; if (favScored) a.scored++; };
const pct = (a: Agg) => (a.n ? ((100 * a.scored) / a.n).toFixed(1) + "%" : "—");

// rank of a team within the current table (1 = top). pts desc, GD desc, GF desc.
function rankOf(table: Map<number, TeamRow>, teamId: number): { rank: number; teams: number } {
  const arr = [...table.entries()].sort((a, b) => {
    const A = a[1], B = b[1];
    if (B.pts !== A.pts) return B.pts - A.pts;
    const gdA = A.gf - A.ga, gdB = B.gf - B.ga;
    if (gdB !== gdA) return gdB - gdA;
    return B.gf - A.gf;
  });
  const idx = arr.findIndex((e) => e[0] === teamId);
  return { rank: idx < 0 ? -1 : idx + 1, teams: arr.length };
}

(async () => {
  const since = new Date(Date.now() - DAYS_BACK * 86400_000).toISOString();
  process.stderr.write("Loading league meta…\n");
  const meta = await loadLeagueMeta();
  process.stderr.write("Loading history…\n");
  const all = await loadHistory(since);
  // scope to the live agent's universe: tier-tagged domestic leagues (excludes UEFA cups)
  const rows = all.filter((r) =>
    r.home_team_id != null && r.away_team_id != null && hg(r) != null && ag(r) != null &&
    eligibleLeague(meta, r.league_id));
  process.stderr.write(`usable tier-tagged fixtures=${rows.length}\n`);

  // group by league|season, already in kickoff order from the global sort
  const groups = new Map<string, Row[]>();
  for (const r of rows) {
    const k = `${r.league_id}|${r.season}`;
    (groups.get(k) ?? groups.set(k, []).get(k)!).push(r);
  }

  const overall = mk();
  const favHome = mk(), favAway = mk();
  const byTier = new Map<string, Agg>();
  const bySeason = new Map<number, Agg>();
  // context baselines within the same eligible leagues
  const baseTop4AnyOpp = mk();   // a top-4 team to score, opponent unrestricted
  const baseAnyTeam = mk();      // any team in these leagues to score (per side)

  for (const [, fixtures] of groups) {
    const table = new Map<number, TeamRow>();
    const ensure = (id: number) => table.get(id) ?? table.set(id, { pts: 0, played: 0, gf: 0, ga: 0 }).get(id)!;
    for (const f of fixtures) {
      const home = f.home_team_id!, away = f.away_team_id!;
      const h = hg(f)!, a = ag(f)!;
      const hRow = table.get(home), aRow = table.get(away);
      // evaluate BEFORE applying this result
      if (hRow && aRow && hRow.played >= MIN_PLAYED && aRow.played >= MIN_PLAYED) {
        const rh = rankOf(table, home), ra = rankOf(table, away);
        if (rh.teams >= MIN_TEAMS) {
          const tier = meta.get(f.league_id)?.tier ?? "(untiered)";
          // baseline: any team to score (count each side once, cheap sample via home side)
          add(baseAnyTeam, h > 0);
          // one side top-4, the other 10th+
          const homeIsFav = rh.rank <= FAV_TOP && ra.rank >= OPP_BOT;
          const awayIsFav = ra.rank <= FAV_TOP && rh.rank >= OPP_BOT;
          if (homeIsFav || awayIsFav) {
            const favScored = homeIsFav ? h > 0 : a > 0;
            add(overall, favScored);
            add(homeIsFav ? favHome : favAway, favScored);
            byTier.set(tier, (byTier.get(tier) ?? mk())); add(byTier.get(tier)!, favScored);
            bySeason.set(f.season, (bySeason.get(f.season) ?? mk())); add(bySeason.get(f.season)!, favScored);
          }
          // context: any top-4 team to score regardless of opponent rank
          if (rh.rank <= FAV_TOP) add(baseTop4AnyOpp, h > 0);
          if (ra.rank <= FAV_TOP) add(baseTop4AnyOpp, a > 0);
        }
      }
      // apply result to the table
      const hr = ensure(home), ar = ensure(away);
      hr.played++; ar.played++; hr.gf += h; hr.ga += a; ar.gf += a; ar.ga += h;
      if (h > a) hr.pts += 3; else if (a > h) ar.pts += 3; else { hr.pts += 1; ar.pts += 1; }
    }
  }

  const line = (label: string, a: Agg) => console.log(`${label.padEnd(30)} n=${String(a.n).padStart(6)}   favscores ${pct(a).padStart(6)}`);
  console.log(`\n=== FARM: favourite (top ${FAV_TOP}) vs opponent (${OPP_BOT}th+) → favourite TO SCORE ===`);
  console.log(`league comps only · min played ${MIN_PLAYED} · min ${MIN_TEAMS} teams · walk-forward, no lookahead\n`);
  line("RULE (fav to score)", overall);
  console.log("");
  line("  fav playing HOME", favHome);
  line("  fav playing AWAY", favAway);
  console.log("\n-- by league tier --");
  for (const [t, a] of [...byTier.entries()].sort((x, y) => y[1].n - x[1].n)) line(`  ${t}`, a);
  console.log("\n-- by season --");
  for (const [s, a] of [...bySeason.entries()].sort((x, y) => x[0] - y[0])) line(`  ${s}`, a);
  console.log("\n-- context baselines (same leagues) --");
  line("  any top-4 team to score", baseTop4AnyOpp);
  line("  any home team to score", baseAnyTeam);
})();
