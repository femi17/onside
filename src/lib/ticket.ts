// Shared ticket/leg logic used by both the Tracker and the Accumulators views —
// a ticket is a ticket whether it's a single bet or a leg of an acca.
import { matchState, type MatchState } from "@/lib/matchState";

export type Stats = {
  momentum: { pressing?: string } | null;
  corners_home: number | null;
  corners_away: number | null;
  corners_home_ht?: number | null; // half-time snapshot — lets 1st/2nd-half corner bets track live
  corners_away_ht?: number | null;
};

// one fixture event, in order. Goals carry the running scoreline; cards (yellow/red) don't.
// Side is the team; the tracker attributes by column + dot, so no team name is stored here.
export type GoalEvent = {
  min: number | null;
  extra?: number | null;
  side: "home" | "away";
  kind: "goal" | "pen" | "og" | "yellow" | "red";
  score?: string;
  player?: string | null;
};

// clock label for an event: "67'" or "45+2'"
export function eventMinute(e: GoalEvent): string {
  if (e.min == null) return "";
  return e.extra ? `${e.min}+${e.extra}'` : `${e.min}'`;
}

export type TrackedTicket = {
  id: string;
  accumulator_id?: string | null;
  market_key: string | null;
  market_label: string | null;
  custom_market: string | null;
  line: number | null;
  side?: string | null;
  period?: string | null; // ft | 1h | 2h — drives period-aware live tracking
  bet_value?: string | null;
  status: string;
  current_value: number | null;
  created_at?: string | null;
  settled_at?: string | null;
  fixtures: {
    home_team: string;
    away_team: string;
    kickoff_utc: string;
    status: string | null;
    elapsed: number | null;
    home_goals: number | null;
    away_goals: number | null;
    extra?: number | null;
    events?: GoalEvent[] | null;
    updated_at?: string | null;
    leagues: { name: string; flag_url: string | null; tier: string | null } | null;
    fixture_stats: Stats | Stats[] | null;
  } | null;
};

export type Group = "live" | "upcoming" | "settled";

// the instant a ticket "belongs to" — its kickoff, else when it settled/was added
export function ticketDate(t: TrackedTicket): string | null {
  return t.fixtures?.kickoff_utc ?? t.settled_at ?? t.created_at ?? null;
}

// start of today in Africa/Lagos (WAT, UTC+1), as a UTC ISO string
export function lagosTodayStartISO(): string {
  const ymd = new Date().toLocaleDateString("en-CA", { timeZone: "Africa/Lagos" });
  return new Date(`${ymd}T00:00:00+01:00`).toISOString();
}

export function oneStat(fs: Stats | Stats[] | null): Stats | null {
  if (!fs) return null;
  return Array.isArray(fs) ? (fs[0] ?? null) : fs;
}

// the regulation minute a running half is capped at (stoppage shows as "+N" via `extra`)
function boundaryFor(status: string | null): number | null {
  return status === "1H" ? 45 : status === "2H" ? 90 : status === "ET" ? 120 : null;
}

// advance the live minute between polls: stored elapsed + minutes since the poll last
// wrote it (only during running halves). Capped at the half boundary so the clock never
// ticks 90 -> 91 and then snaps back when the next poll re-reports 90 — added time is
// shown separately as "90+N" from the feed's `extra`.
export function adjustElapsed(
  status: string | null,
  elapsed: number | null,
  updatedAt: string | null | undefined,
  nowMs?: number
): number | null {
  if (elapsed == null) return elapsed;
  const boundary = boundaryFor(status);
  if (boundary == null) return elapsed; // not a running half — leave as-is
  if (!updatedAt || !nowMs) return Math.min(elapsed, boundary);
  const drift = Math.floor((nowMs - new Date(updatedAt).getTime()) / 60000);
  const raw = elapsed + Math.max(0, Math.min(drift, 15));
  return Math.min(raw, boundary);
}

// pass nowMs (a per-minute tick) to smoothly interpolate the live clock
export function stateOf(t: TrackedTicket, nowMs?: number): MatchState | null {
  const f = t.fixtures;
  if (!f) return null;
  const elapsed = adjustElapsed(f.status, f.elapsed, f.updated_at, nowMs);
  return matchState(f.status, elapsed, f.extra ?? null, f.home_goals, f.away_goals, f.kickoff_utc);
}

export function groupOf(t: TrackedTicket, ms: MatchState | null): Group {
  // a settled bet clears off Live the moment it lands/misses, even mid-game — the Landed and
  // Missed tabs are its home from then on (the live section only tracks bets still in play)
  if (t.status === "won" || t.status === "lost" || t.status === "void" || ms?.phase === "done") return "settled";
  if (t.status === "live" || ms?.phase === "live") return "live";
  return "upcoming";
}

// a 3-letter team code for the momentum meter (Arsenal -> ARS)
export const teamCode = (name?: string) => (name ?? "").replace(/[^A-Za-z]/g, "").slice(0, 3).toUpperCase() || "—";

export type Track = {
  big: string;
  of: string;
  unit: string;
  fillPct: number;
  flagPct: number | null;
  hit: boolean;
  needN: string;
  needT: string;
  under?: boolean; // under bet: the LINE is the big figure, goals scored the small one
  busted?: boolean; // under bet already broken (scored past the line) — a live loss
  count?: number; // the raw running count toward the line (goals/corners/cards so far)
};

// A single team's corner count for the bet's period, from the live fixture-stats snapshot. Corner
// stats are cumulative, so during the 1st half the running total IS the 1h count; after HT the frozen
// HT snapshot gives 1h, and (full − HT) gives 2h. Mirrors poll's pcorners + the total-corner
// periodCorners closure below, but per team. null = no stats yet. (poll keeps current_value in step
// only for TOTAL corner markets, so team corners read straight from fixture_stats.)
export function periodTeamCorners(t: TrackedTicket, side: "home" | "away"): number | null {
  const stat = oneStat(t.fixtures?.fixture_stats ?? null);
  if (!stat) return null;
  const full = side === "home" ? stat.corners_home : stat.corners_away;
  const ht = side === "home" ? stat.corners_home_ht : stat.corners_away_ht;
  const period = t.period ?? "ft";
  if (period === "1h") return ht ?? full ?? null;                       // after HT the snapshot; during 1st half the running total
  if (period === "2h") return full == null ? null : (ht != null ? Math.max(0, full - ht) : full);
  return full ?? null;
}

// Card tallies from the timed events, counted exactly as settlement does (poll's cardCount):
// yellow = 1, red = 2 — or booking points 10/25 — period by the card's minute (1st half ≤ 45').
export function cardTally(
  t: TrackedTicket,
  side?: "home" | "away",
  weights: { yellow: number; red: number } = { yellow: 1, red: 2 }
): number {
  const period = t.period ?? "ft";
  let n = 0;
  for (const e of (t.fixtures?.events ?? []) as GoalEvent[]) {
    if (e.kind !== "yellow" && e.kind !== "red") continue;
    if (side && e.side !== side) continue;
    const min = e.min ?? 0;
    if (period === "1h" && min > 45) continue;
    if (period === "2h" && min <= 45) continue;
    n += e.kind === "red" ? weights.red : weights.yellow;
  }
  return n;
}

// which team the period's first booking went to; null = no cards yet (mirrors poll's
// firstBookingSide, which only settles "none" once the period is over)
export function firstCardSide(t: TrackedTicket): "home" | "away" | null {
  const period = t.period ?? "ft";
  let best: { side: "home" | "away"; key: number } | null = null;
  for (const e of (t.fixtures?.events ?? []) as GoalEvent[]) {
    if (e.kind !== "yellow" && e.kind !== "red") continue;
    const min = e.min ?? 0;
    if (period === "1h" && min > 45) continue;
    if (period === "2h" && min <= 45) continue;
    const key = min * 100 + (e.extra ?? 0);
    if (!best || key < best.key) best = { side: e.side, key };
  }
  return best?.side ?? null;
}

// progress toward the line, betslip-style (big number, "X more", line flag). null = market with no line
export function liveTrack(t: TrackedTicket): Track | null {
  const v = Number(t.current_value ?? 0);
  const won = t.status === "won";
  const period = t.period ?? "ft";
  // period-aware counts, mirroring the build-up push. During a half the live totals ARE that half's
  // count; for the 2nd half we subtract the (stable) 1st-half goals from the events timeline, and
  // 2nd-half corners = live full − the HT corner snapshot.
  const evs = Array.isArray(t.fixtures?.events) ? t.fixtures!.events! : [];
  const isGoalEv = (e: GoalEvent) => e.kind === "goal" || e.kind === "pen" || e.kind === "og";
  const goals1h = (side?: "home" | "away") =>
    evs.filter((e) => isGoalEv(e) && (e.min ?? 999) <= 45 && (!side || e.side === side)).length;
  const periodGoals = (side?: "home" | "away") => {
    const full = side === "home" ? (t.fixtures?.home_goals ?? 0) : side === "away" ? (t.fixtures?.away_goals ?? 0)
      : (t.fixtures?.home_goals ?? 0) + (t.fixtures?.away_goals ?? 0);
    if (period === "1h") return goals1h(side);
    if (period === "2h") return Math.max(0, full - goals1h(side));
    return full;
  };
  const stat = Array.isArray(t.fixtures?.fixture_stats) ? t.fixtures?.fixture_stats[0] : t.fixtures?.fixture_stats;
  const cornerHT = stat && stat.corners_home_ht != null && stat.corners_away_ht != null
    ? stat.corners_home_ht + stat.corners_away_ht : null;
  const periodCorners = () => {
    if (period === "1h") return cornerHT ?? v;            // during 1st half the live count IS the 1h count
    if (period === "2h") return cornerHT != null ? Math.max(0, v - cornerHT) : v;
    return v;
  };
  // `count` defaults to the stored value (total goals/corners); team O/U passes that team's goals
  const overLine = (line: number, unit: string, count = v): Track => {
    const needed = Math.floor(line) + 1;
    const max = needed + 1;
    const hit = won || count >= needed;
    const more = Math.max(0, needed - count);
    return {
      big: `${count}`, of: ` / ${line}`, unit,
      fillPct: Math.min(100, (count / max) * 100),
      flagPct: (line / max) * 100,
      hit,
      count,
      needN: hit ? "✓ Landed" : `${more} more`,
      needT: hit ? "cleared the line" : "to clear the line",
    };
  };
  // Under mirrors Over, but the LINE is the dominant figure and the goals scored is the small
  // number that must stay below it. It breaks (busts) once scored passes the line.
  const underLine = (line: number, unit: string, count = v): Track => {
    const bust = Math.floor(line) + 1; // total that breaks it (3 for 2.5)
    const busted = count >= bust;
    const left = Math.max(0, bust - count); // goals/corners/cards until it breaks
    const one = unit.replace(/s$/, ""); // "goal" / "corner" / "card" / "point"
    return {
      big: `${line}`, of: " under", unit,
      fillPct: Math.min(100, (count / bust) * 100),
      flagPct: null,
      hit: won,
      busted,
      under: true,
      count,
      needN: unit === "goals" ? `${count} scored` : `${count} ${count === 1 ? one : unit}`,
      needT: busted ? "line broken" : won ? "stayed under" : left === 1 ? `1 ${one} ends it` : `${left} ${unit} end it`,
    };
  };
  switch (t.market_key) {
    case "home_goals_ou":
    case "away_goals_ou": {
      // only that team's goals count toward the line, in the bet's period
      const g = periodGoals(t.market_key === "home_goals_ou" ? "home" : "away");
      const line = t.line ?? 0.5;
      return t.side === "under" ? underLine(line, "goals", g) : overLine(line, "goals", g);
    }
    case "over_0_5": return overLine(0.5, "goals");
    case "over_1_5": return overLine(1.5, "goals");
    case "over_2_5": return overLine(2.5, "goals");
    case "over_3_5": return overLine(3.5, "goals");
    // Early Goals variants track the same Over line (they just settle early if goals come fast)
    case "over_1_5_eg": return overLine(1.5, "goals");
    case "over_2_5_eg": return overLine(2.5, "goals");
    case "over_3_5_eg": return overLine(3.5, "goals");
    case "under_2_5": return underLine(2.5, "goals");
    case "under_3_5": return underLine(3.5, "goals");
    case "over_8_5_corners": return overLine(t.line ?? 8.5, "corners");
    // corners over/under on any line — poll keeps current_value in step with the live corner count
    case "corners_ou": { const line = t.line ?? 9.5; const c = periodCorners(); return t.side === "under" ? underLine(line, "corners", c) : overLine(line, "corners", c); }
    // one team's corners over/under (period-aware) — only that team's corners count toward the line.
    // current_value isn't kept in step for these, so read the team total from the fixture-stats snapshot.
    case "home_corners_ou":
    case "away_corners_ou": {
      const c = periodTeamCorners(t, t.market_key === "home_corners_ou" ? "home" : "away") ?? 0;
      const line = t.line ?? 4.5;
      return t.side === "under" ? underLine(line, "corners", c) : overLine(line, "corners", c);
    }
    // total goals over/under on ANY line (e.g. Over 4.5) — current_value holds total goals.
    // Without this it fell through to null and rendered as a home-v-away scoreline.
    case "total_goals_ou": {
      const line = t.line ?? 2.5;
      const g = periodGoals();
      return t.side === "under" ? underLine(line, "goals", g) : overLine(line, "goals", g);
    }
    // ---- bookings: counted live from the timed card events, exactly as settlement counts them
    //      (YC=1, RC=2; booking points 10/25; period by the card's minute) ----
    case "cards_ou": {
      const n = cardTally(t);
      const line = t.line ?? 3.5;
      return t.side === "under" ? underLine(line, "cards", n) : overLine(line, "cards", n);
    }
    case "home_cards_ou":
    case "away_cards_ou": {
      const n = cardTally(t, t.market_key === "home_cards_ou" ? "home" : "away");
      const line = t.line ?? 1.5;
      return t.side === "under" ? underLine(line, "cards", n) : overLine(line, "cards", n);
    }
    case "booking_points_ou": {
      const n = cardTally(t, undefined, { yellow: 10, red: 25 });
      const line = t.line ?? 30;
      return t.side === "under" ? underLine(line, "points", n) : overLine(line, "points", n);
    }
    // exact bookings behaves like an under (can't "land" mid-game — more cards may come),
    // but it busts the moment the count passes the target
    case "exact_cards":
    case "home_exact_cards":
    case "away_exact_cards": {
      const team = t.market_key === "home_exact_cards" ? "home" : t.market_key === "away_exact_cards" ? "away" : undefined;
      const n = cardTally(t, team);
      const line = t.line ?? 0;
      const busted = n > line;
      return {
        big: `${n}`, of: ` / ${line} exact`, unit: "cards",
        fillPct: Math.min(100, (n / Math.max(1, line + 1)) * 100),
        flagPct: null,
        hit: won,
        busted,
        under: true, // urgency reads like an under: closer to busting floats up
        needN: won ? "✓ Landed" : busted ? "passed it" : n === line ? "on the number" : `${line - n} more`,
        needT: won ? "exact count" : busted ? "over the exact count" : n === line ? "no more cards" : "to hit the number",
      };
    }
    case "home_to_score":
    case "away_to_score": {
      const hit = won || v >= 1;
      // name the backed team in the readout ("Thun to score") so it's clear who must score
      const team = (t.market_key === "home_to_score" ? t.fixtures?.home_team : t.fixtures?.away_team) ?? "team";
      return { big: `${v}`, of: v === 1 ? " goal" : " goals", unit: "", fillPct: hit ? 100 : 0, flagPct: null, hit, needN: hit ? "✓ Landed" : "needs a goal", needT: hit ? `${team} scored` : `${team} to score` };
    }
    // btts renders as a scoreline (home : away) in the card, not a "/2" progress bar
    default:
      return null; // result / btts / double chance / qualify / under / custom — no line track
  }
}

// which team the user actually backed, so the tracker can make that side the
// dominant figure (like the big number on Over/Under). null = no single side
// (draw / over / btts / corners). We lean home when it's ambiguous.
const HOME_MARKETS = new Set([
  "home_win", "home_win_1up", "home_win_2up", "home_win_never_down", "home_to_score", "home_clean_sheet", "home_win_to_nil",
  "home_win_both_halves", "home_win_either_half", "home_from_behind",
  "home_score_both_halves", "home_to_qualify", "double_chance_1x", "double_chance_1x_1up", "home_goals_ou",
]);
const AWAY_MARKETS = new Set([
  "away_win", "away_win_1up", "away_win_2up", "away_win_never_down", "away_to_score", "away_clean_sheet", "away_win_to_nil",
  "away_win_both_halves", "away_win_either_half", "away_from_behind",
  "away_score_both_halves", "away_to_qualify", "double_chance_x2", "double_chance_x2_1up", "away_goals_ou",
]);
export function backedSide(marketKey: string | null | undefined, side?: string | null): "home" | "away" | null {
  const k = marketKey ?? "";
  if (HOME_MARKETS.has(k)) return "home";
  if (AWAY_MARKETS.has(k)) return "away";
  // side-driven markets (1x2, DNB, handicap) take the picked side
  if (["result_1x2", "dnb", "home_no_bet", "away_no_bet", "handicap", "handicap_eu", "winning_margin", "first_team_to_score", "last_team_to_score"].includes(k)) {
    return side === "home" ? "home" : side === "away" ? "away" : null;
  }
  return null;
}

// For 1X2-family result bets: which outcome the pick needs, and whether it's landing on the
// CURRENT score. Mirrors settlement — grade() decides 1X2 from the 90-minute result
// (ft_home/ft_away, overtime excluded) — so a live "on course / not yet" verdict lines up
// with how the bet will actually settle. Returns null for non-result markets.
export function resultStanding(
  marketKey: string | null | undefined,
  side: string | null | undefined,
  hg: number,
  ag: number
): { pick: string; landing: boolean } | null {
  const cur = hg > ag ? "home" : ag > hg ? "away" : "draw";
  const on = (needs: string[], pick: string) => ({ pick, landing: needs.includes(cur) });
  switch (marketKey) {
    case "home_win": return on(["home"], "Home");
    case "away_win": return on(["away"], "Away");
    case "draw": return on(["draw"], "Draw");
    // 1UP lands the instant its team is one goal ahead — which is exactly "currently leading"
    case "home_win_1up": return on(["home"], "Home 1UP");
    case "away_win_1up": return on(["away"], "Away 1UP");
    // 2UP tracks like a win (early-locks on a two-goal lead)
    case "home_win_2up": return on(["home"], "Home 2UP");
    case "away_win_2up": return on(["away"], "Away 2UP");
    case "draw_2up": return on(["draw"], "Draw 2UP");
    // Never Down tracks like a win (early-locks LOST the moment its team trails)
    case "home_win_never_down": return on(["home"], "Home never down");
    case "away_win_never_down": return on(["away"], "Away never down");
    case "draw_never_down": return on(["draw"], "Draw never down");
    case "result_1x2":
      return side === "away" ? on(["away"], "Away") : side === "draw" ? on(["draw"], "Draw") : on(["home"], "Home");
    case "double_chance_1x": case "double_chance_1x_1up": return on(["home", "draw"], "Home or draw");
    case "double_chance_x2": case "double_chance_x2_1up": return on(["draw", "away"], "Draw or away");
    case "double_chance_12": return on(["home", "away"], "Home or away");
    default: return null;
  }
}

// Consecutive-goal runs from the event timeline: the longest streak one team scored without
// the opponent replying (maxRun), plus the team currently on a run and its length. An own
// goal counts for the team it's credited to (matching how the score is built). Used by the
// "any team to score N goals in a row" markets — the trolly rises for whoever's on a run.
export function goalRuns(t: TrackedTicket): { maxRun: number; curTeam: "home" | "away" | null; curRun: number } {
  const goals = ((t.fixtures?.events ?? []) as GoalEvent[])
    .filter((e) => e.kind === "goal" || e.kind === "pen" || e.kind === "og")
    .slice()
    .sort((x, y) => (x.min ?? 0) - (y.min ?? 0) || (x.extra ?? 0) - (y.extra ?? 0));
  let maxRun = 0;
  let curTeam: "home" | "away" | null = null;
  let curRun = 0;
  for (const g of goals) {
    if (g.side === curTeam) curRun++;
    else { curTeam = g.side; curRun = 1; }
    if (curRun > maxRun) maxRun = curRun;
  }
  return { maxRun, curTeam, curRun };
}

// Consecutive-goal runs for ONE named team: their longest streak with no reply between
// (maxRun) and their live run (curRun, reset to 0 the moment the opponent scores). Drives the
// "home/away team to score N goals in a row" markets.
export function goalRunsFor(t: TrackedTicket, team: "home" | "away"): { maxRun: number; curRun: number } {
  const goals = ((t.fixtures?.events ?? []) as GoalEvent[])
    .filter((e) => e.kind === "goal" || e.kind === "pen" || e.kind === "og")
    .slice()
    .sort((x, y) => (x.min ?? 0) - (y.min ?? 0) || (x.extra ?? 0) - (y.extra ?? 0));
  let maxRun = 0;
  let curRun = 0;
  for (const g of goals) {
    if (g.side === team) {
      curRun++;
      if (curRun > maxRun) maxRun = curRun;
    } else curRun = 0;
  }
  return { maxRun, curRun };
}

// The biggest lead held at any point (maxLead) from the goal timeline, plus the current lead +
// who holds it. No `team` = whichever team ("any team to lead by N"); with `team` = that team's
// signed lead ("home/away to lead by N"), where a negative curLead means they're trailing.
export function leadStats(t: TrackedTicket, team?: "home" | "away"): { maxLead: number; curLead: number; leader: "home" | "away" | null } {
  const goals = ((t.fixtures?.events ?? []) as GoalEvent[])
    .filter((e) => e.kind === "goal" || e.kind === "pen" || e.kind === "og")
    .slice()
    .sort((x, y) => (x.min ?? 0) - (y.min ?? 0) || (x.extra ?? 0) - (y.extra ?? 0));
  const diffOf = (h: number, a: number) => (team === "away" ? a - h : team === "home" ? h - a : Math.abs(h - a));
  let h = 0;
  let a = 0;
  let maxLead = 0; // level (0) is never "a lead of ≥1", so this baseline is right for team markets too
  for (const g of goals) {
    if (g.side === "home") h++;
    else a++;
    maxLead = Math.max(maxLead, diffOf(h, a));
  }
  // the live score is authoritative; fold it in so a lag in events can't understate the lead
  const hg = t.fixtures?.home_goals ?? h;
  const ag = t.fixtures?.away_goals ?? a;
  const curLead = diffOf(hg, ag);
  maxLead = Math.max(maxLead, curLead);
  return { maxLead, curLead, leader: hg > ag ? "home" : ag > hg ? "away" : null };
}

// A traffic-light read on how the bet is doing RIGHT NOW, updated live as the score moves:
// green = currently winning (frozen now → win), red = currently losing, yellow = in the
// balance (level, or one goal from flipping, or too early to call).
export type Signal = "green" | "yellow" | "red";
// parse a goal-count target into an inclusive [lo, hi] band: "2" → [2,2], "2-3" → [2,3], "4+" → [4,∞).
// Shared by the live traffic-light and the manual-settle grader for exact/range/excluded goal markets.
export function parseGoalBand(v: string | null | undefined): [number, number] | null {
  const s = (v ?? "").trim();
  let m = s.match(/^(\d+)\s*\+$/); if (m) return [Number(m[1]), Infinity];
  m = s.match(/^(\d+)\s*-\s*(\d+)$/); if (m) return [Number(m[1]), Number(m[2])];
  m = s.match(/^(\d+)$/); if (m) return [Number(m[1]), Number(m[1])];
  return null;
}

export function betSignal(t: TrackedTicket, hg: number, ag: number): Signal | null {
  if (t.status === "won") return "green";
  if (t.status === "lost") return "red";
  if (t.status === "void") return null;
  const mk = t.market_key ?? "";
  const tot = hg + ag, diff = hg - ag;
  const lead = (fav: number, dog: number): Signal => (fav > dog ? "green" : fav === dog ? "yellow" : "red");
  switch (mk) {
    case "home_win": case "home_win_1up": case "home_win_2up": case "home_win_never_down": case "dnb": case "home_no_bet":
      return lead(hg, ag);
    case "away_win": case "away_win_1up": case "away_win_2up": case "away_win_never_down": case "away_no_bet":
      return lead(ag, hg);
    case "result_1x2":
      return t.side === "away" ? lead(ag, hg) : t.side === "draw" ? (diff === 0 ? "green" : Math.abs(diff) === 1 ? "yellow" : "red") : lead(hg, ag);
    case "draw": case "draw_2up": case "draw_never_down":
      return diff === 0 ? "green" : Math.abs(diff) === 1 ? "yellow" : "red";
    case "double_chance_1x": case "double_chance_1x_1up": return diff >= 0 ? "green" : diff === -1 ? "yellow" : "red";
    case "double_chance_x2": case "double_chance_x2_1up": return diff <= 0 ? "green" : diff === 1 ? "yellow" : "red";
    case "double_chance_12": return diff !== 0 ? "green" : "yellow";
    case "over_0_5": return tot >= 1 ? "green" : "yellow";
    case "over_1_5": case "over_1_5_eg": return tot >= 2 ? "green" : tot === 1 ? "yellow" : "red";
    case "over_2_5": case "over_2_5_eg": return tot >= 3 ? "green" : tot === 2 ? "yellow" : "red";
    case "over_3_5": case "over_3_5_eg": return tot >= 4 ? "green" : tot === 3 ? "yellow" : "red";
    case "under_2_5": return tot >= 3 ? "red" : tot === 2 ? "yellow" : "green";
    case "under_3_5": return tot >= 4 ? "red" : tot === 3 ? "yellow" : "green";
    case "home_goals_ou": case "away_goals_ou": {
      const g = mk === "home_goals_ou" ? hg : ag, need = Math.floor(t.line ?? 0.5) + 1;
      return t.side === "under"
        ? g >= need ? "red" : g === need - 1 ? "yellow" : "green"
        : g >= need ? "green" : g === need - 1 ? "yellow" : "red";
    }
    case "btts": return hg > 0 && ag > 0 ? "green" : hg > 0 || ag > 0 ? "yellow" : "red";
    case "btts_2plus": {
      const both = hg >= 2 && ag >= 2;
      if (t.side === "no") return both ? "red" : "green"; // No holds until both reach 2
      return both ? "green" : hg >= 2 || ag >= 2 ? "yellow" : "red";
    }
    case "goals_in_row_2":
    case "goals_in_row_3": {
      const need = mk === "goals_in_row_3" ? 3 : 2;
      const { maxRun, curRun } = goalRuns(t);
      const hit = maxRun >= need; // once achieved, Yes is locked — a broken streak later can't undo it
      if (t.side === "no") return hit ? "red" : curRun >= need - 1 ? "yellow" : "green";
      return hit ? "green" : curRun >= need - 1 ? "yellow" : "red";
    }
    case "home_goals_in_row_2": case "home_goals_in_row_3":
    case "away_goals_in_row_2": case "away_goals_in_row_3": {
      const need = mk.endsWith("3") ? 3 : 2;
      const team = mk.startsWith("home") ? "home" : "away";
      const { maxRun, curRun } = goalRunsFor(t, team);
      const hit = maxRun >= need;
      if (t.side === "no") return hit ? "red" : curRun >= need - 1 ? "yellow" : "green";
      return hit ? "green" : curRun >= need - 1 ? "yellow" : "red";
    }
    case "lead_by_1": case "lead_by_2": case "lead_by_3": {
      const need = mk === "lead_by_3" ? 3 : mk === "lead_by_2" ? 2 : 1;
      const { maxLead, curLead } = leadStats(t);
      const hit = maxLead >= need; // once a lead of N happened it's locked; the gap closing can't undo it
      if (t.side === "no") return hit ? "red" : curLead >= need - 1 ? "yellow" : "green";
      return hit ? "green" : curLead >= need - 1 ? "yellow" : "red";
    }
    case "home_lead_by_1": case "home_lead_by_2": case "home_lead_by_3":
    case "away_lead_by_1": case "away_lead_by_2": case "away_lead_by_3": {
      const need = mk.endsWith("3") ? 3 : mk.endsWith("2") ? 2 : 1;
      const team = mk.startsWith("home") ? "home" : "away";
      const { maxLead, curLead } = leadStats(t, team);
      const hit = maxLead >= need;
      if (t.side === "no") return hit ? "red" : curLead >= need - 1 ? "yellow" : "green";
      return hit ? "green" : curLead >= need - 1 ? "yellow" : "red";
    }
    case "home_to_score": return hg > 0 ? "green" : "yellow";
    case "away_to_score": return ag > 0 ? "green" : "yellow";
    case "first_team_to_score": {
      // "none" = no goal: green while 0-0, red once anyone scores. home/away: green if your
      // side has scored and the other hasn't; red if only the other has; else too early/ambiguous.
      if (t.side === "none") return tot === 0 ? "green" : "red";
      const yes = t.side === "home" ? hg : ag, no = t.side === "home" ? ag : hg;
      return yes > 0 && no === 0 ? "green" : no > 0 && yes === 0 ? "red" : "yellow";
    }
    case "home_clean_sheet": return ag === 0 ? "green" : "red";
    case "away_clean_sheet": return hg === 0 ? "green" : "red";
    case "over_8_5_corners": { const c = Number(t.current_value ?? 0), line = t.line ?? 8.5; return c > line ? "green" : c >= line - 1 ? "yellow" : "red"; }
    case "corners_ou": {
      // total corners O/U, period-aware: prefer the fixture-stats snapshot, fall back to current_value
      const ch = periodTeamCorners(t, "home"), ca = periodTeamCorners(t, "away");
      const c = ch != null && ca != null ? ch + ca : Number(t.current_value ?? 0);
      const need = Math.floor(t.line ?? 9.5) + 1;
      return t.side === "under"
        ? c >= need ? "red" : c === need - 1 ? "yellow" : "green"
        : c >= need ? "green" : c === need - 1 ? "yellow" : "red";
    }
    case "home_corners_ou": case "away_corners_ou": {
      const c = periodTeamCorners(t, mk === "home_corners_ou" ? "home" : "away") ?? 0;
      const need = Math.floor(t.line ?? 4.5) + 1;
      return t.side === "under"
        ? c >= need ? "red" : c === need - 1 ? "yellow" : "green"
        : c >= need ? "green" : c === need - 1 ? "yellow" : "red";
    }
    case "handicap_eu": {
      // apply the head-start "H:A" from bet_value, then judge the adjusted result for the pick
      const m = (t.bet_value ?? "").match(/(\d+)\s*:\s*(\d+)/);
      const ah = hg + (m ? Number(m[1]) : 0), aa = ag + (m ? Number(m[2]) : 0);
      if (t.side === "home") return ah > aa ? "green" : ah === aa ? "yellow" : "red";
      if (t.side === "away") return aa > ah ? "green" : ah === aa ? "yellow" : "red";
      return ah === aa ? "green" : Math.abs(ah - aa) === 1 ? "yellow" : "red"; // draw
    }
    case "handicap": {
      // Asian: signed line on the picked side; adj>0 winning, adj<0 losing, adj===0 push (void→amber)
      const L = t.line ?? 0;
      const adj = t.side === "home" ? hg + L - ag : ag + L - hg;
      return adj > 0 ? "green" : adj < 0 ? "red" : "yellow";
    }
    // ---- bookings family: judged on live card counts (YC=1, RC=2), same as settlement ----
    case "cards_ou": {
      const n = cardTally(t);
      const need = Math.floor(t.line ?? 3.5) + 1;
      return t.side === "under"
        ? n >= need ? "red" : n === need - 1 ? "yellow" : "green"
        : n >= need ? "green" : n === need - 1 ? "yellow" : "red";
    }
    case "home_cards_ou": case "away_cards_ou": {
      const n = cardTally(t, mk === "home_cards_ou" ? "home" : "away");
      const need = Math.floor(t.line ?? 1.5) + 1;
      return t.side === "under"
        ? n >= need ? "red" : n === need - 1 ? "yellow" : "green"
        : n >= need ? "green" : n === need - 1 ? "yellow" : "red";
    }
    case "booking_points_ou": {
      const n = cardTally(t, undefined, { yellow: 10, red: 25 });
      const line = t.line ?? 30;
      // within one yellow (10 pts) of the line = in the balance
      return t.side === "under"
        ? n > line ? "red" : n > line - 10 ? "yellow" : "green"
        : n > line ? "green" : n > line - 10 ? "yellow" : "red";
    }
    case "exact_cards": case "home_exact_cards": case "away_exact_cards": {
      const team = mk === "home_exact_cards" ? "home" : mk === "away_exact_cards" ? "away" : undefined;
      const n = cardTally(t, team);
      const line = t.line ?? 0;
      return n > line ? "red" : n === line ? "green" : n === line - 1 ? "yellow" : "red";
    }
    case "cards_1x2": {
      const ch = cardTally(t, "home"), ca = cardTally(t, "away");
      const cur = ch > ca ? "home" : ca > ch ? "away" : "draw";
      return cur === t.side ? "green" : Math.abs(ch - ca) <= 1 ? "yellow" : "red";
    }
    case "cards_handicap": {
      const L = t.line ?? 0;
      const ch = cardTally(t, "home"), ca = cardTally(t, "away");
      const adj = t.side === "home" ? ch + L - ca : ca + L - ch;
      return adj > 0 ? "green" : adj < 0 ? "red" : "yellow";
    }
    case "first_booking": {
      // the first card locks the outcome the moment it's shown
      const first = firstCardSide(t);
      if (t.side === "none") return first ? "red" : "green";
      return first ? (first === t.side ? "green" : "red") : "yellow";
    }
    // ---- exact / range / excluded goal counts — graded on the right team's goals (goals only rise) ----
    case "exact_goals": {
      const line = t.line ?? 0;
      return tot === line ? "green" : "red"; // green only while the total is exactly the mark, else losing now
    }
    case "goal_range": case "home_goal_range": case "away_goal_range": {
      const band = parseGoalBand(t.bet_value); if (!band) return "yellow";
      const [lo, hi] = band;
      const n = mk === "home_goal_range" || t.side === "home" ? hg : mk === "away_goal_range" || t.side === "away" ? ag : tot;
      // current standing: green while the count is inside the range (winning now), red otherwise
      return n >= lo && n <= hi ? "green" : "red";
    }
    case "excluded_goals": case "excluded_home_goals": case "excluded_away_goals": {
      const band = parseGoalBand(t.bet_value); if (!band) return "yellow";
      const [lo, hi] = band;
      const n = mk === "excluded_home_goals" ? hg : mk === "excluded_away_goals" ? ag : tot;
      // current standing: the bet LOSES only if the count lands in the excluded band, so it's red
      // while the count sits IN the band and green otherwise. Goals only rise, so once the count
      // climbs past a finite band it can never return — it stays green (effectively landed).
      return n >= lo && n <= hi ? "red" : "green";
    }
    default: return "yellow";
  }
}

// how close a live bet is to landing — higher bubbles to the top
export function liveUrgency(t: TrackedTicket): number {
  const track = liveTrack(t);
  // under bets: a fuller bar is closer to LOSING, so invert (nearest-to-breaking floats up)
  if (track?.under) return track.busted ? 0 : 100 - track.fillPct;
  if (track) return track.hit ? 100 : track.fillPct;
  if (t.market_key === "home_win") return Number(t.current_value ?? 0) > 0 ? 85 : 35;
  return 50;
}

// markets a final score alone can settle (mirrors the poll settlement engine); used for manual
// settle when the data feed never covered a game. null result = a push/void or a market a score
// can't decide (corners, cards, players, free-text).
export const SCORE_GRADABLE = new Set([
  "home_win", "away_win", "draw", "result_1x2",
  "double_chance_1x", "double_chance_x2", "double_chance_12",
  "btts", "home_to_score", "away_to_score",
  "over_0_5", "over_1_5", "over_2_5", "over_3_5", "under_2_5", "under_3_5", "total_goals_ou",
  "handicap",
  "exact_goals", "goal_range", "home_goal_range", "away_goal_range",
  "excluded_goals", "excluded_home_goals", "excluded_away_goals",
]);
export function scoreGrade(mk: string | null, side: string | null, line: number | null, h: number, a: number, betValue: string | null = null): "won" | "lost" | null {
  const W = (b: boolean): "won" | "lost" => (b ? "won" : "lost");
  switch (mk) {
    case "home_win": return W(h > a);
    case "away_win": return W(a > h);
    case "draw": return W(h === a);
    case "result_1x2": return W(side === "home" ? h > a : side === "away" ? a > h : h === a);
    case "double_chance_1x": return W(h >= a);
    case "double_chance_x2": return W(a >= h);
    case "double_chance_12": return W(h !== a);
    case "btts": { const yes = h > 0 && a > 0; return W(side === "no" ? !yes : yes); }
    case "home_to_score": return W(h > 0);
    case "away_to_score": return W(a > 0);
    case "over_0_5": return W(h + a > 0.5);
    case "over_1_5": return W(h + a > 1.5);
    case "over_2_5": return W(h + a > 2.5);
    case "over_3_5": return W(h + a > 3.5);
    case "under_2_5": return W(h + a < 2.5);
    case "under_3_5": return W(h + a < 3.5);
    case "total_goals_ou": return line == null ? null : W(side === "under" ? h + a < line : h + a > line);
    case "handicap": {
      if (line == null || !side) return null;
      const adj = side === "home" ? (h + line) - a : (a + line) - h;
      if (Number.isInteger(line) && adj === 0) return null; // push / void
      return W(adj > 0);
    }
    case "exact_goals": return line == null ? null : W(h + a === line);
    case "goal_range": case "home_goal_range": case "away_goal_range": {
      const band = parseGoalBand(betValue); if (!band) return null;
      const n = mk === "home_goal_range" || side === "home" ? h : mk === "away_goal_range" || side === "away" ? a : h + a;
      return W(n >= band[0] && n <= band[1]);
    }
    case "excluded_goals": case "excluded_home_goals": case "excluded_away_goals": {
      const band = parseGoalBand(betValue); if (!band) return null;
      const n = mk === "excluded_home_goals" ? h : mk === "excluded_away_goals" ? a : h + a;
      return W(!(n >= band[0] && n <= band[1])); // wins when the count is NOT in the excluded band
    }
    default: return null;
  }
}
