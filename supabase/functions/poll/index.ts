// Onside live poller + settlement engine.
//  - ONE fixtures?live=all call updates every tracked game's score/status (free fan-out).
//  - Monotonic goal/result bets early-settle live from that shared call (0 extra API).
//  - fixtures/events fetched when a goal lands (ticker) and once at settlement for
//    event-based bets (goalscorers, cards, halves). fixtures/statistics only for corners.
//  - Grades tickets, agent_picks AND deliveries (same grade() dictionary).
//  - VAR-aware; single-flight lock; display `events` = goals + cards (grading counts goals only).
//  - Early-pay markets: 1UP/2UP/Never Down, Over Early Goals, Double Chance 1UP.
import { createClient } from "npm:@supabase/supabase-js@2";

const AF_BASE = "https://v3.football.api-sports.io";
const LIVE = ["1H", "2H", "HT", "ET", "BT", "P", "LIVE", "SUSP", "INT"];
const FINISHED = ["FT", "AET", "PEN"];
const NOTPLAYED = ["PST", "CANC", "ABD", "AWD", "WO"];
const REG_TIME = ["1H", "2H", "HT"];
const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

function json(b: unknown, s = 200) { return new Response(JSON.stringify(b), { status: s, headers: { "Content-Type": "application/json" } }); }
async function getSecret(name: string): Promise<string> {
  const { data, error } = await sb.rpc("get_secret", { secret_name: name });
  if (error || !data) throw new Error(`secret ${name}`);
  return data as string;
}
async function afGet(path: string, params: Record<string, string>): Promise<any[]> {
  const key = await getSecret("api_football_key");
  const res = await fetch(`${AF_BASE}/${path}?${new URLSearchParams(params)}`, { headers: { "x-apisports-key": key } });
  await sb.rpc("bump_api_usage");
  const body = await res.json();
  if (!res.ok) throw new Error(`af ${path}: ${res.status}`);
  return body?.response ?? [];
}
const num = (v: any): number | null => {
  if (v == null) return null;
  const x = typeof v === "string" ? Number(v.replace("%", "")) : v;
  return Number.isFinite(x) ? x : null;
};
function statVal(arr: any[], type: string): any { const s = (arr ?? []).find((x: any) => x.type === type); return s ? s.value : null; }
function parseStats(statsArr: any[], liveFx: any) {
  const homeId = liveFx.teams?.home?.id;
  let home: any[] = [], away: any[] = [];
  for (const t of statsArr) { if (t.team?.id === homeId) home = t.statistics; else away = t.statistics; }
  return {
    corners_home: num(statVal(home, "Corner Kicks")), corners_away: num(statVal(away, "Corner Kicks")),
    shots_home: num(statVal(home, "Total Shots")), shots_away: num(statVal(away, "Total Shots")),
    possession_home: num(statVal(home, "Ball Possession")),
    xg_home: num(statVal(home, "expected_goals")), xg_away: num(statVal(away, "expected_goals")),
  };
}
// Per-team totals for the statistics markets (shots / shots on target / offsides / fouls). Same
// source as corners (fixtures/statistics). Returns a name -> [home, away] map for the grader.
function parseTeamStats(statsArr: any[], liveFx: any): Record<string, [number | null, number | null]> {
  const homeId = liveFx?.teams?.home?.id;
  let home: any[] = [], away: any[] = [];
  for (const t of statsArr) { if (t.team?.id === homeId) home = t.statistics; else away = t.statistics; }
  return {
    shots: [num(statVal(home, "Total Shots")), num(statVal(away, "Total Shots"))],
    sot: [num(statVal(home, "Shots on Goal")), num(statVal(away, "Shots on Goal"))],
    offsides: [num(statVal(home, "Offsides")), num(statVal(away, "Offsides"))],
    fouls: [num(statVal(home, "Fouls")), num(statVal(away, "Fouls"))],
  };
}
// Momentum over a rolling ~10-minute window of shots+corners, NOT the change since the last poll.
// Polls run ~20s apart, and a shot/corner rarely lands inside one poll, so a per-poll delta was
// almost always 0 -> "even" forever. Each poll appends a snapshot keyed by the match minute, drops
// snapshots that have aged out of the window, and measures pressure as (current - oldest-in-window)
// per team. The samples ride along in the momentum JSON so no extra table is needed.
const MOMENTUM_WINDOW_MIN = 10;
function momentum(cur: any, prevMomentum: any, elapsed: number | null) {
  const el = elapsed ?? 0;
  const now = {
    el,
    ch: cur.corners_home ?? 0, ca: cur.corners_away ?? 0,
    sh: cur.shots_home ?? 0, sa: cur.shots_away ?? 0,
  };
  const prevSamples: any[] = Array.isArray(prevMomentum?.samples) ? prevMomentum.samples : [];
  // keep a little past the window (stable baseline) and guard against the clock going backwards
  const kept = prevSamples.filter((s) => (s?.el ?? 0) <= el && el - (s?.el ?? 0) <= MOMENTUM_WINDOW_MIN + 2);
  const samples = [...kept, now];
  // baseline = the oldest snapshot still inside the window (samples are chronological)
  const base = samples.find((s) => el - (s?.el ?? 0) <= MOMENTUM_WINDOW_MIN) ?? now;
  const dH = (now.ch - (base.ch ?? 0)) + (now.sh - (base.sh ?? 0));
  const dA = (now.ca - (base.ca ?? 0)) + (now.sa - (base.sa ?? 0));
  let pressing = "even";
  if (dH - dA >= 2) pressing = "home"; else if (dA - dH >= 2) pressing = "away";
  return { pressing, home_delta: dH, away_delta: dA, samples };
}
function isGoalDisallow(detail: string): boolean {
  return /disallow|cancel|overturn|no goal|goal removed/i.test(detail || "");
}
function parseEvents(evs: any[], fx: any): { goals: any[]; cards: any[]; penalty: boolean } {
  const homeId = fx?.teams?.home?.id;
  const goals: any[] = [], cards: any[] = [], disallows: any[] = [];
  let penalty = false;
  for (const e of evs ?? []) {
    if (e.type === "Goal") {
      if (e.detail === "Missed Penalty") { penalty = true; continue; }
      let side = e.team?.id === homeId ? "home" : "away";
      const kind = e.detail === "Penalty" ? "pen" : e.detail === "Own Goal" ? "og" : "goal";
      if (kind === "pen") penalty = true;
      if (e.detail === "Own Goal") side = side === "home" ? "away" : "home";
      goals.push({ min: e.time?.elapsed ?? null, extra: e.time?.extra ?? null, side, kind, player: e.player?.name ?? null, assist: e.assist?.name ?? null });
    } else if (e.type === "Card") {
      const side = e.team?.id === homeId ? "home" : "away";
      cards.push({ min: e.time?.elapsed ?? 0, side, player: e.player?.name ?? null, kind: /red/i.test(e.detail || "") ? "red" : "yellow" });
    } else if (e.type === "Var") {
      const d = e.detail || "";
      if (isGoalDisallow(d)) disallows.push({ side: e.team?.id === homeId ? "home" : "away", player: e.player?.name ?? null, min: e.time?.elapsed ?? 0 });
      else if (/penalty/i.test(d) && !/no penalty/i.test(d)) penalty = true;
    }
  }
  for (const dq of disallows) {
    let idx = -1, best = Infinity;
    for (let i = goals.length - 1; i >= 0; i--) {
      if (goals[i].side !== dq.side) continue;
      if (dq.player && goals[i].player && normName(goals[i].player) === normName(dq.player)) { idx = i; break; }
      const dm = Math.abs((goals[i].min ?? 0) - (dq.min ?? 0));
      if (dm < best) { best = dm; idx = i; }
    }
    if (idx >= 0) goals.splice(idx, 1);
  }
  let h = 0, a = 0;
  for (const g of goals) { if (g.side === "home") h++; else a++; g.score = `${h}-${a}`; }
  return { goals, cards, penalty };
}
function extractGoals(evs: any[], fx: any): any[] { return parseEvents(evs, fx).goals; }
// The `live=all` goals count is the authoritative score. The events endpoint can lag or retain
// a disallowed goal (score reverts to 0-0 but the goal stays in the list with no VAR row), which
// otherwise leaves a phantom goal in the drawer forever. Trim any goal beyond the real per-side
// count (most-recent first -- at the moment of a disallow the bogus goal is the latest), then
// rebuild the running scoreline so stored events never show more goals than actually count.
function reconcileGoals(goals: any[], hg: number, ag: number): any[] {
  const trimSide = (side: string, target: number) => {
    let count = goals.filter((g) => g.side === side).length;
    while (count > target) {
      for (let i = goals.length - 1; i >= 0; i--) { if (goals[i].side === side) { goals.splice(i, 1); break; } }
      count--;
    }
  };
  trimSide("home", hg);
  trimSide("away", ag);
  let h = 0, a = 0;
  for (const g of goals) { if (g.side === "home") h++; else a++; g.score = `${h}-${a}`; }
  return goals;
}
const isCardEv = (e: any): boolean => e?.kind === "yellow" || e?.kind === "red";
function timelineOf(parsed: { goals: any[]; cards: any[] }): any[] {
  return [...parsed.goals, ...parsed.cards].sort((a, b) => (a.min ?? 0) - (b.min ?? 0) || (a.extra ?? 0) - (b.extra ?? 0));
}
function fixtureUpdate(fx: any): Record<string, unknown> {
  const upd: Record<string, unknown> = {
    status: fx.fixture?.status?.short, elapsed: fx.fixture?.status?.elapsed,
    extra: fx.fixture?.status?.extra ?? null,
    home_goals: fx.goals?.home, away_goals: fx.goals?.away, updated_at: new Date().toISOString(),
  };
  if (fx.score?.fulltime?.home != null) upd.ft_home = fx.score.fulltime.home;
  if (fx.score?.fulltime?.away != null) upd.ft_away = fx.score.fulltime.away;
  const winner = fx.teams?.home?.winner ? "home" : fx.teams?.away?.winner ? "away" : null;
  if (winner) upd.winner = winner;
  return upd;
}

// ---------- fixture orientation guard ----------
// The provider sometimes swaps a fixture's home/away AFTER we stored it (venue moves are common in
// friendlies/cups). Scores and events always arrive in the provider's CURRENT orientation, so a
// stale stored orientation mirrors every number — and a "home" bet silently grades against the
// wrong team (this is how a correct pick can settle "missed"). On every update we adopt the
// provider's orientation: swap the stored teams/events/stats AND flip the side of every open bet so
// each bet keeps pointing at the TEAM that was actually picked when it was placed.
const orientById = new Map<number, { homeId: number | null; awayId: number | null }>();
async function loadOrientations(ids: number[]): Promise<void> {
  for (let i = 0; i < ids.length; i += 500) {
    const { data } = await sb.from("fixtures").select("id,home_team_id,away_team_id").in("id", ids.slice(i, i + 500));
    for (const r of data ?? []) orientById.set(r.id, { homeId: r.home_team_id, awayId: r.away_team_id });
  }
}
function swapKey(k: string): string {
  if (k.startsWith("home_")) return `away_${k.slice(5)}`;
  if (k.startsWith("away_")) return `home_${k.slice(5)}`;
  if (k === "double_chance_1x") return "double_chance_x2";
  if (k === "double_chance_x2") return "double_chance_1x";
  if (k === "double_chance_1x_1up") return "double_chance_x2_1up";
  if (k === "double_chance_x2_1up") return "double_chance_1x_1up";
  return k;
}
const swapSide = (s: string | null): string | null =>
  s === "home" ? "away" : s === "away" ? "home" : s === "1x" ? "x2" : s === "x2" ? "1x" : s;
function swapVal(v: string | null): string | null {
  if (!v) return v;
  const pair = v.match(/^(\d+)(\s*\D\s*)(\d+)$/); // "2-1" / "1:0" score-shaped values mirror
  if (pair) return `${pair[3]}${pair[2]}${pair[1]}`;
  if (/^(home|away)([\s\d].*)?$/i.test(v)) return v.replace(/home|away/i, (w) => (w.toLowerCase() === "home" ? "away" : "home"));
  const htft = v.match(/^(home|away|draw)\s*\/\s*(home|away|draw)$/i);
  if (htft) { const f = (x: string) => (x.toLowerCase() === "home" ? "away" : x.toLowerCase() === "away" ? "home" : "draw"); return `${f(htft[1])}/${f(htft[2])}`; }
  return v;
}
function swapLabel(l: string | null): string | null {
  if (l == null) return l;
  // two-step swap via placeholder tokens so Home/Away exchange cleanly, case preserved
  return l
    .replace(/\bHome\b/g, "@@H@@").replace(/\bAway\b/g, "Home").replace(/@@H@@/g, "Away")
    .replace(/\bhome\b/g, "@@h@@").replace(/\baway\b/g, "home").replace(/@@h@@/g, "away");
}
let orientationFixes = 0;
async function ensureOrientation(fx: any): Promise<void> {
  const id = fx?.fixture?.id;
  const apiHome = fx?.teams?.home?.id, apiAway = fx?.teams?.away?.id;
  if (!id || apiHome == null || apiAway == null) return;
  const stored = orientById.get(id);
  if (!stored || stored.homeId == null || stored.awayId == null) return;
  if (stored.homeId === apiHome) return; // aligned
  // only handle a clean home/away SWAP of the same two teams; a different pairing is sync's problem
  if (stored.homeId !== apiAway || stored.awayId !== apiHome) return;
  orientationFixes++;
  orientById.set(id, { homeId: apiHome, awayId: apiAway });
  // 1) fixture row adopts the provider orientation; stored events (written in the old orientation)
  //    mirror too. Fresh numbers arrive right after via fixtureUpdate in the same orientation.
  const { data: row } = await sb.from("fixtures").select("events").eq("id", id).maybeSingle();
  const events = Array.isArray(row?.events)
    ? row!.events.map((e: any) => ({ ...e, side: e?.side === "home" ? "away" : "home", score: typeof e?.score === "string" ? swapVal(e.score) : e?.score }))
    : row?.events ?? null;
  const patch: Record<string, unknown> = { home_team_id: apiHome, away_team_id: apiAway, events };
  if (fx.teams?.home?.name) patch.home_team = fx.teams.home.name;
  if (fx.teams?.away?.name) patch.away_team = fx.teams.away.name;
  await sb.from("fixtures").update(patch).eq("id", id);
  // 2) sided stats snapshots mirror (momentum regenerates itself next poll)
  const { data: st } = await sb.from("fixture_stats").select("corners_home,corners_away,corners_home_ht,corners_away_ht,shots_home,shots_away,xg_home,xg_away").eq("fixture_id", id).maybeSingle();
  if (st) {
    await sb.from("fixture_stats").update({
      corners_home: st.corners_away, corners_away: st.corners_home,
      corners_home_ht: st.corners_away_ht, corners_away_ht: st.corners_home_ht,
      shots_home: st.shots_away, shots_away: st.shots_home,
      xg_home: st.xg_away, xg_away: st.xg_home,
    }).eq("fixture_id", id);
  }
  // 3) every OPEN bet flips side so it still tracks the team it was placed on (settled bets keep
  //    their history — they were graded under the orientation shown at the time)
  for (const [table, col] of [["tickets", "status"], ["agent_picks", "status"], ["deliveries", "result"]] as const) {
    const q = sb.from(table).select("id,market_key,side,bet_value,market_label").eq("fixture_id", id);
    const { data: rows } = col === "result" ? await q.eq(col, "pending") : await q.in(col, ["pending", "live"]);
    for (const r of rows ?? []) {
      await sb.from(table).update({
        market_key: swapKey(r.market_key ?? ""),
        side: swapSide(r.side ?? null),
        bet_value: swapVal(r.bet_value ?? null),
        market_label: swapLabel(r.market_label ?? null),
      }).eq("id", r.id);
    }
  }
}

function liveValue(mk: string, hg: number, ag: number, corners: number): number {
  if (mk === "over_8_5_corners") return corners;
  if (mk === "home_to_score" || mk === "home_goals_ou") return hg;
  if (mk === "away_to_score" || mk === "away_goals_ou") return ag;
  if (mk === "btts") return Math.min(hg, 1) + Math.min(ag, 1);
  if (["home_win", "away_win", "draw", "home_win_1up", "away_win_1up", "home_win_2up", "away_win_2up", "draw_2up", "home_win_never_down", "away_win_never_down", "draw_never_down", "double_chance_1x_1up", "double_chance_x2_1up"].includes(mk)) return hg - ag;
  return hg + ag;
}
function earlyResult(mk: string, hg: number, ag: number, elapsed: number | null = null): "won" | "lost" | null {
  const tot = hg + ag;
  switch (mk) {
    case "over_0_5": return tot >= 1 ? "won" : null;
    case "over_1_5": return tot >= 2 ? "won" : null;
    case "over_2_5": return tot >= 3 ? "won" : null;
    case "over_3_5": return tot >= 4 ? "won" : null;
    case "home_to_score": return hg >= 1 ? "won" : null;
    case "away_to_score": return ag >= 1 ? "won" : null;
    case "btts": return hg >= 1 && ag >= 1 ? "won" : null;
    case "home_win_1up": return hg >= ag + 1 ? "won" : null;
    case "away_win_1up": return ag >= hg + 1 ? "won" : null;
    case "home_win_2up": return hg >= ag + 2 ? "won" : null;
    case "away_win_2up": return ag >= hg + 2 ? "won" : null;
    case "home_win_never_down": return ag > hg ? "lost" : null;
    case "away_win_never_down": return hg > ag ? "lost" : null;
    case "double_chance_1x_1up": return hg > ag ? "won" : null;
    case "double_chance_x2_1up": return ag > hg ? "won" : null;
    case "over_1_5_eg": return elapsed != null && elapsed <= 10 && tot >= 1 ? "won" : null;
    case "over_2_5_eg": return elapsed != null && elapsed <= 30 && tot >= 2 ? "won" : null;
    case "over_3_5_eg": return elapsed != null && elapsed <= 50 && tot >= 3 ? "won" : null;
    case "under_2_5": return tot >= 3 ? "lost" : null;
    case "under_3_5": return tot >= 4 ? "lost" : null;
    default: return null;
  }
}
async function updateRowsLive(table: string, rows: any[], liveFx: any, statusCol = "status"): Promise<number> {
  const hg = liveFx.goals?.home ?? 0, ag = liveFx.goals?.away ?? 0;
  const regTime = REG_TIME.includes(liveFx.fixture?.status?.short);
  const elapsed = liveFx.fixture?.status?.elapsed ?? null;
  let settled = 0;
  for (const t of rows) {
    if (t.market_key === "over_8_5_corners") continue;
    const value = liveValue(t.market_key, hg, ag, 0);
    const early = regTime && t.period === "ft" ? earlyResult(t.market_key, hg, ag, elapsed) : null;
    if (early) { await sb.from(table).update({ [statusCol]: early, current_value: value, settled_at: new Date().toISOString() }).eq("id", t.id); settled++; }
    else await sb.from(table).update(statusCol === "status" ? { status: "live", current_value: value } : { current_value: value }).eq("id", t.id);
  }
  return settled;
}
async function updateCornerTickets(tickets: any[], corners: number, liveFx: any): Promise<number> {
  const regTime = REG_TIME.includes(liveFx.fixture?.status?.short);
  let settled = 0;
  for (const t of tickets) {
    // over_8_5_corners (FT-only) early-pays once corners pass the line. corners_ou can be a
    // 1st/2nd-half bet, so never early-settle it on cumulative corners — just keep current_value in
    // step with the live count (tracker + build-up alerts) and let HT/FT settlement grade the period.
    if (t.market_key === "over_8_5_corners") {
      if (regTime && corners > (t.line ?? 8.5)) { await sb.from("tickets").update({ status: "won", current_value: corners, settled_at: new Date().toISOString() }).eq("id", t.id); settled++; }
      else await sb.from("tickets").update({ status: "live", current_value: corners }).eq("id", t.id);
    } else if (t.market_key === "corners_ou") {
      await sb.from("tickets").update({ status: "live", current_value: corners }).eq("id", t.id);
    }
  }
  return settled;
}

// ---------- the grading dictionary ----------
type Facts = {
  hg: number; ag: number; h1h: number; h1a: number; h2h: number; h2a: number;
  goals: any[]; cards: any[]; penalty: boolean; winner: string | null;
  corners: number | null; corners_home: number | null; corners_away: number | null;
  corners_home_ht: number | null; corners_away_ht: number | null;
  teamStats: Record<string, [number | null, number | null]>; hasEvents: boolean;
};
const CORNER_MARKETS = new Set(["over_8_5_corners", "corners_ou", "corner_handicap", "corners_1x2", "home_corners_ou", "away_corners_ou", "corner_range", "home_corner_range", "away_corner_range", "corners_odd_even", "first_corner", "last_corner"]);
// Statistics team markets (shots / shots on target / offsides / fouls), FT only, graded from
// per-team totals in fixtures/statistics. Handled generically in grade() via a regex on the key.
const STAT_MARKETS = new Set([
  "shots_1x2", "shots_ou", "home_shots_ou", "away_shots_ou",
  "sot_1x2", "sot_ou", "home_sot_ou", "away_sot_ou",
  "offsides_1x2", "offsides_ou", "home_offsides_ou", "away_offsides_ou",
  "fouls_1x2", "fouls_ou", "home_fouls_ou", "away_fouls_ou",
]);
const EVENT_MARKETS = new Set([
  "anytime_goalscorer", "first_goalscorer", "last_goalscorer", "player_not_to_score",
  "player_score_assist", "player_assist", "player_card", "player_booked", "player_sent_off",
  "first_team_to_score", "last_team_to_score", "penalty_match", "penalty_scored", "htft", "first_goal_interval", "result_by_minute", "goals_ou_by_minute",
  "cards_ou", "cards_1x2", "booking_points_ou", "home_cards_ou", "away_cards_ou", "exact_cards", "cards_handicap", "home_exact_cards", "away_exact_cards", "first_booking",
  "highest_scoring_half", "home_highest_scoring_half", "away_highest_scoring_half", "htft_cs", "both_halves_ou", "btts_both_halves",
  "home_win_both_halves", "away_win_both_halves", "home_win_either_half", "away_win_either_half",
  "home_from_behind", "away_from_behind", "home_score_both_halves", "away_score_both_halves",
  "home_win_1up", "away_win_1up", "home_win_2up", "away_win_2up", "home_win_never_down", "away_win_never_down", "double_chance_1x_1up", "double_chance_x2_1up",
  "goals_in_row_2", "goals_in_row_3",
  "home_goals_in_row_2", "home_goals_in_row_3", "away_goals_in_row_2", "away_goals_in_row_3",
  "lead_by_1", "lead_by_2", "lead_by_3",
  "home_lead_by_1", "home_lead_by_2", "home_lead_by_3", "away_lead_by_1", "away_lead_by_2", "away_lead_by_3",
]);
const W = (c: boolean): "won" | "lost" => (c ? "won" : "lost");
const pg = (f: Facts, p: string): [number, number] => p === "1h" ? [f.h1h, f.h1a] : p === "2h" ? [f.h2h, f.h2a] : [f.hg, f.ag];
// Per-period corner totals. Corner stats are live+cumulative, so the HT snapshot = 1st-half corners
// and (FT total - HT snapshot) = 2nd-half corners. Returns [null,null] when the needed values are
// missing (e.g. no HT snapshot because the bet was placed after half-time) -> market stays pending.
const pcorners = (f: Facts, p: string): [number | null, number | null] => {
  if (p === "1h") return [f.corners_home_ht, f.corners_away_ht];
  if (p === "2h") {
    if (f.corners_home == null || f.corners_away == null || f.corners_home_ht == null || f.corners_away_ht == null) return [null, null];
    return [f.corners_home - f.corners_home_ht, f.corners_away - f.corners_away_ht];
  }
  return [f.corners_home, f.corners_away];
};
const outcome = (h: number, a: number) => (h > a ? "home" : a > h ? "away" : "draw");
// One leg of a "result OR condition" combo: does the picked result outcome hold? Accepts single
// results (home/draw/away) and double-chance codes (1x/x2/12).
const resultLeg = (sd: string | null, r: string): boolean =>
  sd === "home" ? r === "home" : sd === "away" ? r === "away" : sd === "draw" ? r === "draw"
  : sd === "1x" ? r !== "away" : sd === "x2" ? r !== "home" : sd === "12" ? r !== "draw" : false;
const normName = (x: string) => (x || "").toLowerCase().replace(/[^a-z ]/g, " ").replace(/\s+/g, " ").trim();
function playerMatch(eventPlayer: string | null, betValue: string | null): boolean {
  if (!eventPlayer || !betValue) return false;
  const et = new Set(normName(eventPlayer).split(" ").filter((w) => w.length >= 3));
  const bt = normName(betValue.replace(/\d+\s*\+?/g, " ")).split(" ").filter((w) => w.length >= 3);
  return bt.length > 0 && bt.some((t) => et.has(t));
}
const reqLine = (v: string | null): number => { const m = (v || "").match(/(\d+)\s*\+/); return m ? Number(m[1]) : 1; };
function cardCount(cards: any[], side: string | null, period: string): number {
  let n = 0;
  for (const c of cards) {
    if (side && c.side !== side) continue;
    if (period === "1h" && !(c.min <= 45)) continue;
    if (period === "2h" && c.min <= 45) continue;
    n += c.kind === "red" ? 2 : 1;
  }
  return n;
}
// 1st Booking -- which team's earliest card (by minute) wins; "none" when no cards in the period.
// Cards ARE timed events (unlike corners), so this is fully auto-gradeable.
function firstBookingSide(cards: any[], period: string): string {
  let best: any = null;
  for (const c of cards) {
    if (period === "1h" && !(c.min <= 45)) continue;
    if (period === "2h" && c.min <= 45) continue;
    if (best === null || (c.min ?? 999) < (best.min ?? 999)) best = c;
  }
  return best ? best.side : "none";
}
function bookingPoints(cards: any[], period: string): number {
  let n = 0;
  for (const c of cards) {
    if (period === "1h" && !(c.min <= 45)) continue;
    if (period === "2h" && c.min <= 45) continue;
    n += c.kind === "red" ? 25 : 10;
  }
  return n;
}
function grade(t: any, f: Facts): "won" | "lost" | "void" | null {
  const k = t.market_key, side = t.side, line = t.line, period = t.period || "ft", val = t.bet_value;
  const [h, a] = pg(f, period);
  const tot = h + a, res = outcome(h, a);
  const needsEv = (EVENT_MARKETS.has(k) || period !== "ft") && !CORNER_MARKETS.has(k) && !STAT_MARKETS.has(k);
  if (needsEv && !f.hasEvents) return null;
  // statistics team markets (shots/SOT/offsides/fouls): 1X2 = more of the stat; O/U = total (or a
  // single team for home_/away_). Graded from per-team totals; null when the stat isn't reported.
  const sm = k.match(/^(?:(home|away)_)?(shots|sot|offsides|fouls)_(1x2|ou)$/);
  if (sm) {
    const [hh, aa] = f.teamStats[sm[2]] ?? [null, null];
    if (hh == null || aa == null) return null;
    if (sm[3] === "1x2") return W(outcome(hh, aa) === side);
    if (line == null) return null;
    const n = sm[1] === "home" ? hh : sm[1] === "away" ? aa : hh + aa;
    if (Number.isInteger(line) && n === line) return "void";
    return W(side === "over" ? n > line : n < line);
  }
  switch (k) {
    case "home_win": return W(res === "home");
    case "away_win": return W(res === "away");
    case "draw": return W(res === "draw");
    case "result_1x2": return W(res === side);
    case "home_win_1up": return W(everLed(f.goals, "home"));
    case "away_win_1up": return W(everLed(f.goals, "away"));
    case "home_win_2up": return W(everLed(f.goals, "home", 2) || res === "home");
    case "away_win_2up": return W(everLed(f.goals, "away", 2) || res === "away");
    case "draw_2up": return W(res === "draw");
    case "home_win_never_down": return W(res === "home" && !everTrailed(f.goals, "home"));
    case "away_win_never_down": return W(res === "away" && !everTrailed(f.goals, "away"));
    case "draw_never_down": return W(res === "draw");
    case "double_chance_1x_1up": return W(everLed(f.goals, "home") || res !== "away");
    case "double_chance_x2_1up": return W(everLed(f.goals, "away") || res !== "home");
    case "double_chance_1x": return W(res !== "away");
    case "double_chance_x2": return W(res !== "home");
    case "double_chance_12": return W(res !== "draw");
    case "double_chance": return W((side === "1x" && res !== "away") || (side === "x2" && res !== "home") || (side === "12" && res !== "draw"));
    case "dnb": return res === "draw" ? "void" : W(res === side);
    case "home_no_bet": return res === "home" ? "void" : W(true);
    case "away_no_bet": return res === "away" ? "void" : W(true);
    case "over_0_5": return W(tot >= 1);
    case "over_1_5": return W(tot >= 2);
    case "over_2_5": return W(tot >= 3);
    case "over_3_5": return W(tot >= 4);
    case "under_2_5": return W(tot <= 2);
    case "under_3_5": return W(tot <= 3);
    case "over_1_5_eg": return W(goalsBy(f.goals, 10) >= 1 || tot >= 2);
    case "over_2_5_eg": return W(goalsBy(f.goals, 30) >= 2 || tot >= 3);
    case "over_3_5_eg": return W(goalsBy(f.goals, 50) >= 3 || tot >= 4);
    case "total_goals_ou": { if (line == null) return null; if (Number.isInteger(line) && tot === line) return "void"; return W(side === "over" ? tot > line : tot < line); }
    case "home_goals_ou": return line == null ? null : (Number.isInteger(line) && h === line ? "void" : W(side === "over" ? h > line : h < line));
    case "away_goals_ou": return line == null ? null : (Number.isInteger(line) && a === line ? "void" : W(side === "over" ? a > line : a < line));
    case "exact_goals": return line == null ? null : W(tot === line);
    case "odd_even": return W((tot % 2 === 1) === (side === "odd"));
    case "home_odd_even": return W((h % 2 === 1) === (side === "odd"));
    case "away_odd_even": return W((a % 2 === 1) === (side === "odd"));
    case "goal_range": case "home_goal_range": { const n = k === "home_goal_range" || side === "home" ? h : side === "away" ? a : tot; return gradeRange(val, n); }
    case "excluded_goals": case "excluded_home_goals": case "excluded_away_goals": { const n = k === "excluded_home_goals" ? h : k === "excluded_away_goals" ? a : tot; const r = gradeRange(val, n); return r === null ? null : W(r === "lost"); }
    case "btts": return W((h > 0 && a > 0) === (side !== "no"));
    case "btts_2plus": return W((h >= 2 && a >= 2) === (side !== "no"));
    case "goals_in_row_2": return W((maxGoalsInRow(f.goals) >= 2) === (side !== "no"));
    case "goals_in_row_3": return W((maxGoalsInRow(f.goals) >= 3) === (side !== "no"));
    case "home_goals_in_row_2": return W((maxGoalsInRow(f.goals, "home") >= 2) === (side !== "no"));
    case "home_goals_in_row_3": return W((maxGoalsInRow(f.goals, "home") >= 3) === (side !== "no"));
    case "away_goals_in_row_2": return W((maxGoalsInRow(f.goals, "away") >= 2) === (side !== "no"));
    case "away_goals_in_row_3": return W((maxGoalsInRow(f.goals, "away") >= 3) === (side !== "no"));
    case "lead_by_1": return W((everLed(f.goals, "home", 1) || everLed(f.goals, "away", 1)) === (side !== "no"));
    case "lead_by_2": return W((everLed(f.goals, "home", 2) || everLed(f.goals, "away", 2)) === (side !== "no"));
    case "lead_by_3": return W((everLed(f.goals, "home", 3) || everLed(f.goals, "away", 3)) === (side !== "no"));
    case "home_lead_by_1": return W(everLed(f.goals, "home", 1) === (side !== "no"));
    case "home_lead_by_2": return W(everLed(f.goals, "home", 2) === (side !== "no"));
    case "home_lead_by_3": return W(everLed(f.goals, "home", 3) === (side !== "no"));
    case "away_lead_by_1": return W(everLed(f.goals, "away", 1) === (side !== "no"));
    case "away_lead_by_2": return W(everLed(f.goals, "away", 2) === (side !== "no"));
    case "away_lead_by_3": return W(everLed(f.goals, "away", 3) === (side !== "no"));
    case "btts_both_halves": return W(f.h1h > 0 && f.h1a > 0 && f.h2h > 0 && f.h2a > 0);
    case "no_draw_btts": return W(h > 0 && a > 0 && res !== "draw");
    case "result_btts": return W(res === side && (h > 0 && a > 0) === (val !== "no"));
    case "result_ou": { if (line == null) return null; const ouW = val === "under" ? tot < line : tot > line; return W(res === side && ouW); }
    case "dc_btts": { const dc = (side === "1x" && res !== "away") || (side === "x2" && res !== "home") || (side === "12" && res !== "draw"); return W(dc && (h > 0 && a > 0) === (val !== "no")); }
    case "dc_ou": { if (line == null) return null; const dc = (side === "1x" && res !== "away") || (side === "x2" && res !== "home") || (side === "12" && res !== "draw"); const ouW = val === "under" ? tot < line : tot > line; return W(dc && ouW); }
    case "ou_btts": { if (line == null) return null; const ouW = side === "under" ? tot < line : tot > line; return W(ouW && (h > 0 && a > 0) === (val !== "no")); }
    // "result OR condition" combos -- Yes wins if EITHER leg happens (side = the result leg).
    case "result_or_ou": { if (line == null) return null; const ou = val === "under" ? tot < line : tot > line; return W(resultLeg(side, res) || ou); }
    case "result_or_btts": { const gg = h > 0 && a > 0; return W(resultLeg(side, res) || (val === "no" ? !gg : gg)); }
    case "result_or_cs": return W(resultLeg(side, res) || h === 0 || a === 0);
    case "home_to_score": return W(h >= 1);
    case "away_to_score": return W(a >= 1);
    case "home_clean_sheet": return W(a === 0);
    case "away_clean_sheet": return W(h === 0);
    case "home_win_to_nil": return W(f.hg > f.ag && f.ag === 0);
    case "away_win_to_nil": return W(f.ag > f.hg && f.hg === 0);
    case "home_win_both_halves": return W(f.h1h > f.h1a && f.h2h > f.h2a);
    case "away_win_both_halves": return W(f.h1a > f.h1h && f.h2a > f.h2h);
    case "home_win_either_half": return W(f.h1h > f.h1a || f.h2h > f.h2a);
    case "away_win_either_half": return W(f.h1a > f.h1h || f.h2a > f.h2h);
    case "home_from_behind": return W(f.hg > f.ag && everTrailed(f.goals, "home"));
    case "away_from_behind": return W(f.ag > f.hg && everTrailed(f.goals, "away"));
    case "home_score_both_halves": return W(f.h1h > 0 && f.h2h > 0);
    case "away_score_both_halves": return W(f.h1a > 0 && f.h2a > 0);
    case "correct_score": { const m = (val || "").match(/(\d+)\D+(\d+)/); return m ? W(h === Number(m[1]) && a === Number(m[2])) : null; }
    case "htft": { const m = (val || "").split("/"); if (m.length !== 2) return null; return W(outcome(f.h1h, f.h1a) === m[0] && outcome(f.hg, f.ag) === m[1]); }
    case "first_team_to_score": { const g0 = f.goals[0]; const s = g0 ? g0.side : "none"; return W(s === side); }
    case "last_team_to_score": { const gl = f.goals[f.goals.length - 1]; const s = gl ? gl.side : "none"; return W(s === side); }
    case "result_by_minute": { const m = (val || "").match(/(\d+)/); if (!m || !side) return null; const N = Number(m[1]); const hm = f.goals.filter((g) => g.side === "home" && (g.min ?? 999) <= N).length; const am = f.goals.filter((g) => g.side === "away" && (g.min ?? 999) <= N).length; return W(outcome(hm, am) === side); }
    case "goals_ou_by_minute": { const m = (val || "").match(/(\d+)/); if (!m || line == null) return null; const n = goalsBy(f.goals, Number(m[1])); return W(side === "over" ? n > line : n < line); }
    case "first_goal_interval": { const g0 = f.goals.find((g) => (g.min ?? 999) <= 90); const min = g0 ? (g0.min ?? 0) : null; if (/none/i.test(val || "")) return W(min === null); if (min === null) return W(false); return gradeRange((val || "").replace(/\\s/g, ""), min); }
    case "highest_scoring_half": { const d = (f.h1h + f.h1a) - (f.h2h + f.h2a); const hi = d > 0 ? "1h" : d < 0 ? "2h" : "equal"; return W(hi === side); }
    case "home_highest_scoring_half": { const d = f.h1h - f.h2h; const hi = d > 0 ? "1h" : d < 0 ? "2h" : "equal"; return W(hi === side); }
    case "away_highest_scoring_half": { const d = f.h1a - f.h2a; const hi = d > 0 ? "1h" : d < 0 ? "2h" : "equal"; return W(hi === side); }
    case "teams_to_score": { const s = h > 0 && a > 0 ? "both" : h > 0 ? "home" : a > 0 ? "away" : "none"; return W(s === side); }
    case "htft_cs": { const m = (val || "").match(/(\d+)\D+(\d+)\D+(\d+)\D+(\d+)/); return m ? W(f.h1h === Number(m[1]) && f.h1a === Number(m[2]) && f.hg === Number(m[3]) && f.ag === Number(m[4])) : null; }
    case "both_halves_ou": { if (line == null) return null; const o1 = (f.h1h + f.h1a) > line, o2 = (f.h2h + f.h2a) > line; return W(side === "over" ? o1 && o2 : !o1 && !o2); }
    case "winning_margin": return gradeMargin(val, h, a);
    case "handicap": return gradeHandicap(side, line, h, a);
    case "handicap_eu": { const m = (val || "").match(/(\d+)\s*:\s*(\d+)/); if (!m || !side) return null; return W(outcome(h + Number(m[1]), a + Number(m[2])) === side); }
    case "anytime_goalscorer": { const n = f.goals.filter((g) => g.kind !== "og" && playerMatch(g.player, val)).length; return W(n >= reqLine(val)); }
    case "first_goalscorer": { const g0 = f.goals.find((g) => g.kind !== "og"); return W(!!g0 && playerMatch(g0.player, val)); }
    case "last_goalscorer": { const gs = f.goals.filter((g) => g.kind !== "og"); const gl = gs[gs.length - 1]; return W(!!gl && playerMatch(gl.player, val)); }
    case "player_not_to_score": return W(!f.goals.some((g) => g.kind !== "og" && playerMatch(g.player, val)));
    case "player_assist": return W(f.goals.some((g) => playerMatch(g.assist, val)));
    case "player_score_assist": return W(f.goals.some((g) => (g.kind !== "og" && playerMatch(g.player, val)) || playerMatch(g.assist, val)));
    case "player_card": return W(f.cards.some((c) => playerMatch(c.player, val)));
    case "player_booked": return W(f.cards.some((c) => c.kind === "yellow" && playerMatch(c.player, val)));
    case "player_sent_off": return W(f.cards.some((c) => c.kind === "red" && playerMatch(c.player, val)));
    case "cards_ou": { if (line == null) return null; const n = cardCount(f.cards, null, period); return W(side === "over" ? n > line : n < line); }
    case "home_cards_ou": { if (line == null) return null; const n = cardCount(f.cards, "home", period); return W(side === "over" ? n > line : n < line); }
    case "away_cards_ou": { if (line == null) return null; const n = cardCount(f.cards, "away", period); return W(side === "over" ? n > line : n < line); }
    case "exact_cards": { if (line == null) return null; return W(cardCount(f.cards, null, period) === line); }
    case "home_exact_cards": { if (line == null) return null; return W(cardCount(f.cards, "home", period) === line); }
    case "away_exact_cards": { if (line == null) return null; return W(cardCount(f.cards, "away", period) === line); }
    case "cards_handicap": return gradeHandicap(side, line, cardCount(f.cards, "home", period), cardCount(f.cards, "away", period));
    case "booking_points_ou": { if (line == null) return null; const n = bookingPoints(f.cards, period); return W(side === "over" ? n > line : n < line); }
    case "cards_1x2": { const ch = cardCount(f.cards, "home", period), ca = cardCount(f.cards, "away", period); return W(outcome(ch, ca) === side); }
    case "first_booking": return W(firstBookingSide(f.cards, period) === side);
    case "penalty_match": return W(f.penalty);
    case "penalty_scored": return W(f.goals.some((g) => g.kind === "pen"));
    case "over_8_5_corners": return f.corners == null ? null : W(f.corners > (line ?? 8.5));
    case "corners_ou": { if (line == null) return null; const [ch, ca] = pcorners(f, period); if (ch == null || ca == null) return null; const ct = ch + ca; if (Number.isInteger(line) && ct === line) return "void"; return W(side === "over" ? ct > line : ct < line); }
    case "corner_handicap": { const [ch, ca] = pcorners(f, period); return (ch == null || ca == null) ? null : gradeHandicap(side, line, ch, ca); }
    case "corners_1x2": { const [ch, ca] = pcorners(f, period); return (ch == null || ca == null) ? null : W(outcome(ch, ca) === side); }
    case "home_corners_ou": { const [ch] = pcorners(f, period); return (ch == null || line == null) ? null : (Number.isInteger(line) && ch === line ? "void" : W(side === "over" ? ch > line : ch < line)); }
    case "away_corners_ou": { const [, ca] = pcorners(f, period); return (ca == null || line == null) ? null : (Number.isInteger(line) && ca === line ? "void" : W(side === "over" ? ca > line : ca < line)); }
    case "corner_range": { const [ch, ca] = pcorners(f, period); return (ch == null || ca == null) ? null : gradeRange(val, ch + ca); }
    case "home_corner_range": { const [ch] = pcorners(f, period); return ch == null ? null : gradeRange(val, ch); }
    case "away_corner_range": { const [, ca] = pcorners(f, period); return ca == null ? null : gradeRange(val, ca); }
    case "corners_odd_even": { const [ch, ca] = pcorners(f, period); return (ch == null || ca == null) ? null : W(((ch + ca) % 2 === 1) === (side === "odd")); }
    case "first_corner": case "last_corner": { const ch = f.corners_home, ca = f.corners_away; if (ch == null || ca == null) return null; if (ch === 0 && ca === 0) return W(side === "none"); if (ch > 0 && ca === 0) return W(side === "home"); if (ca > 0 && ch === 0) return W(side === "away"); return null; }
    case "home_to_qualify": return f.winner ? W(f.winner === "home") : null;
    case "away_to_qualify": return f.winner ? W(f.winner === "away") : null;
    default: return null;
  }
}
function gradeRange(val: string | null, n: number): "won" | "lost" | null {
  if (!val) return null;
  const plus = val.match(/(\d+)\s*\+/); if (plus) return W(n >= Number(plus[1]));
  const rng = val.match(/(\d+)\s*-\s*(\d+)/); if (rng) return W(n >= Number(rng[1]) && n <= Number(rng[2]));
  const one = val.match(/^(\d+)$/); if (one) return W(n === Number(one[1]));
  return null;
}
function gradeMargin(val: string | null, hg: number, ag: number): "won" | "lost" | null {
  if (!val) return null;
  const m = val.match(/(home|away)?\s*(\d+)/); if (!m) return null;
  const team = m[1], by = Number(m[2]); const diff = hg - ag;
  if (team === "home") return W(diff === by);
  if (team === "away") return W(-diff === by);
  return W(Math.abs(diff) === by);
}
function gradeHandicap(side: string | null, line: number | null, h: number, a: number): "won" | "lost" | "void" | null {
  if (line == null || !side) return null;
  const adj = side === "home" ? (h + line) - a : (a + line) - h;
  if (Number.isInteger(line) && adj === 0) return "void";
  return W(adj > 0);
}
function everTrailed(goals: any[], team: string): boolean {
  let h = 0, a = 0;
  for (const g of goals) { if (g.side === "home") h++; else a++; if (team === "home" ? a > h : h > a) return true; }
  return false;
}
function everLed(goals: any[], team: string, margin = 1): boolean {
  let h = 0, a = 0;
  for (const g of goals) { if (g.side === "home") h++; else a++; if (team === "home" ? h - a >= margin : a - h >= margin) return true; }
  return false;
}
function goalsBy(goals: any[], minute: number): number {
  let n = 0;
  for (const g of goals) if ((g.min ?? 999) <= minute) n++;
  return n;
}
// longest streak of consecutive goals with no opponent goal between (own goals count for the
// team credited, matching the score). No `team` = any team's longest run ("N in a row"); with
// `team` = that team's longest run ("home/away N in a row", reset when the opponent scores).
function maxGoalsInRow(goals: any[], team?: string): number {
  let max = 0, curTeam: string | null = null, run = 0;
  for (const g of goals) {
    if (team) {
      if (g.side === team) { run++; if (run > max) max = run; } else run = 0;
    } else {
      if (g.side === curTeam) run++; else { curTeam = g.side; run = 1; }
      if (run > max) max = run;
    }
  }
  return max;
}

async function buildFacts(fixtureId: number, rows: any[]): Promise<Facts> {
  const { data: fx } = await sb.from("fixtures").select("home_goals,away_goals,ft_home,ft_away,winner,events").eq("id", fixtureId).single();
  const { data: st } = await sb.from("fixture_stats").select("corners_home,corners_away,corners_home_ht,corners_away_ht").eq("fixture_id", fixtureId).maybeSingle();
  const hg = fx?.ft_home ?? fx?.home_goals ?? 0, ag = fx?.ft_away ?? fx?.away_goals ?? 0;
  let cornersHome: number | null = st?.corners_home ?? null;
  let cornersAway: number | null = st?.corners_away ?? null;
  let corners = st ? (st.corners_home ?? 0) + (st.corners_away ?? 0) : null;
  let goals: any[] = Array.isArray(fx?.events) ? fx.events.filter((e: any) => !isCardEv(e)) : [];
  let cards: any[] = [];
  let penalty = false;
  let hasEvents = false;
  let teamStats: Record<string, [number | null, number | null]> = {};
  const needCorners = rows.some((t) => CORNER_MARKETS.has(t.market_key));
  const needStats = rows.some((t) => STAT_MARKETS.has(t.market_key));
  const needEvents = needCorners || needStats || rows.some((t) => EVENT_MARKETS.has(t.market_key) || (t.period && t.period !== "ft"));
  if (needEvents) {
    try {
      const raw = await afGet("fixtures", { id: String(fixtureId) });
      const one = raw[0];
      const parsed = parseEvents(one?.events ?? [], one);
      reconcileGoals(parsed.goals, hg, ag); // keep the goal timeline consistent with the final score
      goals = parsed.goals; cards = parsed.cards; penalty = parsed.penalty; hasEvents = true;
      await sb.from("fixtures").update({ events: timelineOf(parsed) }).eq("id", fixtureId);
      // corner + statistics markets grade from the FINAL per-team totals -- fetch fresh at settlement
      if (needCorners || needStats) {
        try {
          const sArr = await afGet("fixtures/statistics", { fixture: String(fixtureId) });
          if (sArr.length) {
            if (needCorners) { const ps = parseStats(sArr, one); cornersHome = ps.corners_home; cornersAway = ps.corners_away; corners = (ps.corners_home ?? 0) + (ps.corners_away ?? 0); }
            if (needStats) teamStats = parseTeamStats(sArr, one);
          }
        } catch (_e2) { /* keep stored corners */ }
      }
    } catch (_e) { hasEvents = false; }
  }
  const h1h = goals.filter((g) => g.side === "home" && (g.min ?? 0) <= 45).length;
  const h1a = goals.filter((g) => g.side === "away" && (g.min ?? 0) <= 45).length;
  return { hg, ag, h1h, h1a, h2h: Math.max(0, hg - h1h), h2a: Math.max(0, ag - h1a), goals, cards, penalty, winner: fx?.winner ?? null, corners, corners_home: cornersHome, corners_away: cornersAway, corners_home_ht: st?.corners_home_ht ?? null, corners_away_ht: st?.corners_away_ht ?? null, teamStats, hasEvents };
}

async function settleRows(table: string, rows: any[], facts: Facts, statusCol = "status") {
  const now = new Date().toISOString();
  const corners = facts.corners ?? 0;
  for (const t of rows) {
    if (t.market_key === "custom") continue;
    const r = grade(t, facts);
    if (r === null) continue;
    await sb.from(table).update({ [statusCol]: r, current_value: liveValue(t.market_key, facts.hg, facts.ag, corners), settled_at: now }).eq("id", t.id);
  }
}
const EARLY_MARKETS = new Set(["over_0_5", "over_1_5", "over_2_5", "over_3_5", "home_to_score", "away_to_score", "btts", "under_2_5", "under_3_5"]);
async function revertVarSettles(table: string, statusCol: string, fixtureId: number, hg: number, ag: number, regTime: boolean): Promise<number> {
  if (!regTime) return 0;
  const { data: rows } = await sb.from(table).select("id,market_key,period").eq("fixture_id", fixtureId).in(statusCol, ["won", "lost"]).not("settled_at", "is", null);
  const openVal = statusCol === "status" ? "live" : "pending";
  let n = 0;
  for (const r of rows ?? []) {
    if ((r.period ?? "ft") !== "ft" || !EARLY_MARKETS.has(r.market_key)) continue;
    if (earlyResult(r.market_key, hg, ag) === null) {
      await sb.from(table).update({ [statusCol]: openVal, current_value: hg + ag, settled_at: null }).eq("id", r.id);
      n++;
    }
  }
  return n;
}
async function settle(fixtureId: number) {
  const cols = "id,market_key,side,line,period,bet_value";
  const { data: ts } = await sb.from("tickets").select(cols).eq("fixture_id", fixtureId).in("status", ["pending", "live"]);
  const { data: aps } = await sb.from("agent_picks").select(cols).eq("fixture_id", fixtureId).in("status", ["pending", "live"]);
  const { data: dls } = await sb.from("deliveries").select(cols).eq("fixture_id", fixtureId).eq("result", "pending");
  const all = [...(ts ?? []), ...(aps ?? []), ...(dls ?? [])];
  if (!all.length) return;
  const facts = await buildFacts(fixtureId, all);
  await settleRows("tickets", ts ?? [], facts);
  await settleRows("agent_picks", aps ?? [], facts);
  await settleRows("deliveries", dls ?? [], facts, "result");
}

// At half-time every 1st-half bet is fully decided, so settle them now (the 1st-half score, cards
// and corner snapshot are final). 2nd-half/full-match bets keep waiting for FT. Idempotent: once a
// row is won/lost it drops out of the pending/live query, so re-running across HT polls is a no-op.
async function settleHalfTime(fixtureId: number) {
  const cols = "id,market_key,side,line,period,bet_value";
  const { data: ts } = await sb.from("tickets").select(cols).eq("fixture_id", fixtureId).eq("period", "1h").in("status", ["pending", "live"]);
  const { data: aps } = await sb.from("agent_picks").select(cols).eq("fixture_id", fixtureId).eq("period", "1h").in("status", ["pending", "live"]);
  const { data: dls } = await sb.from("deliveries").select(cols).eq("fixture_id", fixtureId).eq("period", "1h").eq("result", "pending");
  const all = [...(ts ?? []), ...(aps ?? []), ...(dls ?? [])];
  if (!all.length) return 0;
  const facts = await buildFacts(fixtureId, all);
  await settleRows("tickets", ts ?? [], facts);
  await settleRows("agent_picks", aps ?? [], facts);
  await settleRows("deliveries", dls ?? [], facts, "result");
  return all.length;
}

async function poll() {
  const now = Date.now();
  const nowIso = new Date().toISOString();
  { const staleCut = new Date(now - 30 * 60 * 1000).toISOString();
    const { data: stale } = await sb.from("fixtures").select("id").in("status", LIVE).lt("updated_at", staleCut);
    const ids = (stale ?? []).map((r: any) => r.id);
    if (ids.length) {
      const { data: bet } = await sb.from("tickets").select("fixture_id").in("fixture_id", ids).in("status", ["pending", "live"]);
      const guard = new Set((bet ?? []).map((r: any) => r.fixture_id));
      const close = ids.filter((id: number) => !guard.has(id));
      if (close.length) await sb.from("fixtures").update({ status: "FT", updated_at: nowIso }).in("id", close);
    }
  }
  const winStart = new Date(now - 3 * 3600 * 1000).toISOString();
  const winEnd = new Date(now + 5 * 60 * 1000).toISOString();

  const { data: windowFx } = await sb.from("fixtures").select("id,status,elapsed")
    .gte("kickoff_utc", winStart).lte("kickoff_utc", winEnd).not("status", "in", `(${FINISHED.join(",")})`);

  const { data: trackedTix } = await sb.from("tickets").select("fixture_id").in("status", ["pending", "live"]).not("fixture_id", "is", null);
  const { data: apTix } = await sb.from("agent_picks").select("fixture_id").in("status", ["pending", "live"]).not("fixture_id", "is", null);
  const { data: dlTix } = await sb.from("deliveries").select("fixture_id").eq("result", "pending").not("fixture_id", "is", null);
  const trackedIds = [...new Set([...(trackedTix ?? []).map((t: any) => t.fixture_id), ...(apTix ?? []).map((t: any) => t.fixture_id), ...(dlTix ?? []).map((t: any) => t.fixture_id)])];

  let dueTracked: any[] = [];
  if (trackedIds.length) {
    const { data } = await sb.from("fixtures").select("id,status").in("id", trackedIds).not("status", "in", `(${FINISHED.join(",")})`).lte("kickoff_utc", winEnd);
    dueTracked = data ?? [];
  }
  if ((!windowFx || windowFx.length === 0) && dueTracked.length === 0) return { skipped: true, reason: "nothing in play or due" };

  const live = await afGet("fixtures", { live: "all" });
  const liveMap = new Map<number, any>();
  for (const fx of live) liveMap.set(fx.fixture.id, fx);
  const ourIds = new Set<number>([...(windowFx ?? []).map((f: any) => f.id), ...trackedIds]);

  const { data: activeTickets } = await sb.from("tickets").select("id,market_key,line,period,fixture_id").in("status", ["pending", "live"]).neq("market_key", "custom").not("fixture_id", "is", null);
  const byFixture = new Map<number, any[]>();
  for (const t of activeTickets ?? []) { const arr = byFixture.get(t.fixture_id) ?? []; arr.push(t); byFixture.set(t.fixture_id, arr); }

  const { data: activeAP } = await sb.from("agent_picks").select("id,market_key,line,period,fixture_id").in("status", ["pending", "live"]).neq("market_key", "custom").not("fixture_id", "is", null);
  const apByFixture = new Map<number, any[]>();
  for (const t of activeAP ?? []) { const arr = apByFixture.get(t.fixture_id) ?? []; arr.push(t); apByFixture.set(t.fixture_id, arr); }

  const { data: activeDL } = await sb.from("deliveries").select("id,market_key,line,period,fixture_id").eq("result", "pending").neq("market_key", "custom").not("fixture_id", "is", null);
  const dlByFixture = new Map<number, any[]>();
  for (const t of activeDL ?? []) { const arr = dlByFixture.get(t.fixture_id) ?? []; arr.push(t); dlByFixture.set(t.fixture_id, arr); }

  const prevById = new Map<number, { tot: number; hasEvents: boolean; evGoals: number }>();
  { const ids = Array.from(new Set([...byFixture.keys(), ...apByFixture.keys(), ...dlByFixture.keys()]));
    if (ids.length) { const { data } = await sb.from("fixtures").select("id,home_goals,away_goals,events").in("id", ids);
      for (const r of data ?? []) prevById.set(r.id, { tot: (r.home_goals ?? 0) + (r.away_goals ?? 0), hasEvents: Array.isArray(r.events) && r.events.length > 0, evGoals: Array.isArray(r.events) ? r.events.filter((e: any) => !isCardEv(e)).length : 0 }); } }

  const earlyIds = new Set<number>();
  { const sinceIso = new Date(now - 3 * 3600 * 1000).toISOString();
    const em = Array.from(EARLY_MARKETS);
    for (const [table, col] of [["tickets", "status"], ["agent_picks", "status"], ["deliveries", "result"]] as const) {
      const { data } = await sb.from(table).select("fixture_id").in(col, ["won", "lost"]).not("settled_at", "is", null).gte("settled_at", sinceIso).in("market_key", em).not("fixture_id", "is", null);
      for (const r of data ?? []) earlyIds.add(r.fixture_id as number);
    }
  }

  // stored home/away per fixture — lets every update spot a provider-side orientation swap
  await loadOrientations(Array.from(new Set([...ourIds, ...earlyIds])));

  let updated = 0, finalized = 0, statsUpdated = 0, settledLive = 0, reconciled = 0, eventsUpdated = 0, reverted = 0;
  // per-pass caps so a busy slate drains over 20s ticks instead of overrunning one pass (skipped
  // fixtures stay pending/eligible and are handled next pass). Scores still update for ALL live games.
  let eventsBudget = 60, settleBudget = 40;

  for (const [id, fx] of liveMap) {
    if (!ourIds.has(id) && !earlyIds.has(id)) continue;
    await ensureOrientation(fx); // provider swapped home/away since we stored it → adopt + flip open bets
    await sb.from("fixtures").update(fixtureUpdate(fx)).eq("id", id);
    updated++;
    const hg = fx.goals?.home ?? 0, ag = fx.goals?.away ?? 0, tot = hg + ag;
    const regTime = REG_TIME.includes(fx.fixture?.status?.short);
    const tickets = byFixture.get(id);
    if (tickets) settledLive += await updateRowsLive("tickets", tickets, fx);
    const apk = apByFixture.get(id);
    if (apk) settledLive += await updateRowsLive("agent_picks", apk, fx);
    const dlk = dlByFixture.get(id);
    if (dlk) settledLive += await updateRowsLive("deliveries", dlk, fx, "result");

    if (earlyIds.has(id) && regTime) {
      const rv = (await revertVarSettles("tickets", "status", id, hg, ag, regTime))
        + (await revertVarSettles("agent_picks", "status", id, hg, ag, regTime))
        + (await revertVarSettles("deliveries", "result", id, hg, ag, regTime));
      reverted += rv;
    }

    const prev = prevById.get(id);
    const scoreChanged = prev ? tot !== prev.tot : tot > 0;
    const tickerMismatch = prev ? prev.evGoals !== tot : false;
    if (((tickets?.length ?? 0) || (apk?.length ?? 0) || (dlk?.length ?? 0) || earlyIds.has(id)) && (scoreChanged || tickerMismatch || !prev?.hasEvents) && eventsBudget > 0) {
      eventsBudget--;
      try {
        const parsed = parseEvents(await afGet("fixtures/events", { fixture: String(id) }), fx);
        reconcileGoals(parsed.goals, hg, ag); // drop any goal the score says was disallowed
        const evs = timelineOf(parsed);
        await sb.from("fixtures").update({ events: evs }).eq("id", id); eventsUpdated++;
      } catch (_e) { /* non-fatal */ }
    }
  }

  for (const f of windowFx ?? []) {
    if (liveMap.has(f.id) || !LIVE.includes(f.status)) continue;
    // a live game that vanished from the feed NEAR full time really did finish -- force FT + settle.
    // one that vanished early (or barely started, e.g. a postponement/abandonment/feed glitch) is
    // NOT a result -- leave it for reconcile (fresh API status -> voids postponed/not-played games)
    // so we never grade a phantom 0-0 as won/lost.
    if ((f.elapsed ?? 0) < 80) continue;
    if (settleBudget <= 0) continue; // drain remaining settlements next pass
    settleBudget--;
    await sb.from("fixtures").update({ status: "FT", updated_at: nowIso }).eq("id", f.id);
    await settle(f.id); finalized++;
  }

  const reconcileIds = dueTracked.filter((f: any) => !liveMap.has(f.id)).map((f: any) => f.id);
  for (let i = 0; i < reconcileIds.length; i += 20) {
    const chunk = reconcileIds.slice(i, i + 20);
    const results = await afGet("fixtures", { ids: chunk.join("-") });
    for (const fx of results) {
      const short = fx.fixture?.status?.short;
      if (FINISHED.includes(short) && settleBudget <= 0) continue; // drain remaining settlements next pass
      await ensureOrientation(fx); // reconcile fetches carry teams too — same swap guard as live
      await sb.from("fixtures").update(fixtureUpdate(fx)).eq("id", fx.fixture.id);
      if (FINISHED.includes(short)) { settleBudget--; await settle(fx.fixture.id); }
      else if (NOTPLAYED.includes(short)) {
        await sb.from("tickets").update({ status: "void", settled_at: nowIso }).eq("fixture_id", fx.fixture.id).in("status", ["pending", "live"]);
        await sb.from("agent_picks").update({ status: "void", settled_at: nowIso }).eq("fixture_id", fx.fixture.id).in("status", ["pending", "live"]);
        await sb.from("deliveries").update({ result: "void", settled_at: nowIso }).eq("fixture_id", fx.fixture.id).eq("result", "pending");
      }
      reconciled++;
    }
  }

  const cornerFixtures = [...byFixture.entries()].filter(([id, ts]) => liveMap.has(id) && ts.some((t) => CORNER_MARKETS.has(t.market_key))).map(([id]) => id);
  for (const id of cornerFixtures) {
    const statsArr = await afGet("fixtures/statistics", { fixture: String(id) });
    if (!statsArr.length) continue;
    const parsed = parseStats(statsArr, liveMap.get(id));
    const { data: prev } = await sb.from("fixture_stats").select("momentum").eq("fixture_id", id).maybeSingle();
    const elapsed = liveMap.get(id)?.fixture?.status?.elapsed ?? null;
    const row: Record<string, unknown> = { fixture_id: id, ...parsed, momentum: momentum(parsed, prev?.momentum, elapsed), updated_at: nowIso };
    // At HT the live corner totals ARE the 1st-half count (stats are cumulative) -- snapshot them so
    // 1st/2nd-half corner markets can grade later (2nd half = full-time total - this snapshot).
    if (liveMap.get(id)?.fixture?.status?.short === "HT") { row.corners_home_ht = parsed.corners_home; row.corners_away_ht = parsed.corners_away; }
    await sb.from("fixture_stats").upsert(row);
    const corners = (parsed.corners_home ?? 0) + (parsed.corners_away ?? 0);
    settledLive += await updateCornerTickets(byFixture.get(id) ?? [], corners, liveMap.get(id));
    statsUpdated++;
  }

  // Half-time settlement: 1st-half bets are final once the half ends. Runs AFTER the corner-stats
  // loop so the HT corner snapshot is already stored for this poll. Only touches fixtures at HT that
  // have active bets; settleHalfTime early-returns for those without any 1st-half rows.
  let htSettled = 0;
  const activeBetIds = new Set<number>([...byFixture.keys(), ...apByFixture.keys(), ...dlByFixture.keys()]);
  for (const id of activeBetIds) {
    if (liveMap.get(id)?.fixture?.status?.short === "HT") htSettled += await settleHalfTime(id);
  }

  return { window: windowFx?.length ?? 0, live: liveMap.size, updated, finalized, reconciled, statsUpdated, settledLive, htSettled, eventsUpdated, reverted, orientationFixes };
}
Deno.serve(async () => {
  try {
    const { data: got } = await sb.rpc("acquire_poll_lock");
    if (!got) return json({ skipped: true, reason: "poll already running" });
    try { return json(await poll()); }
    finally { await sb.rpc("release_poll_lock"); }
  } catch (e) { console.error("poll failed:", e); return json({ error: String(e) }, 500); }
});
