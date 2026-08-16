// Plain-English read-back of a parsed agent rule ({ filters, select } from the run-strategies
// rule engine). Shown in the strategy builder so a rule that mistranslates — or translates to
// nothing — is caught BEFORE the agent ever picks with it. The field phrases must cover
// RULE_FIELDS in supabase/functions/run-strategies/index.ts; an unknown field falls back to its
// raw key so a vocabulary addition can never break the builder.

export type RuleCond = { field: string; op: string; value: number; value2: number };
// branches carry a when-LIST (all must hold; empty = default) — the legacy single
// when_field shape from older stored parses still renders
export type RuleBranch = {
  when?: RuleCond[];
  when_field?: string;
  when_op?: string;
  when_value?: number;
  when_value2?: number;
  market_key: string;
  side: string;
  line: number;
};
export type ParsedRule = { filters: RuleCond[]; select: RuleBranch[] };

const FIELD: Record<string, string> = {
  home_odds: "the home-win odds",
  draw_odds: "the draw odds",
  away_odds: "the away-win odds",
  fav_odds: "the favourite's odds",
  dog_odds: "the underdog's odds",
  over_1_5_odds: "the Over 1.5 odds",
  over_2_5_odds: "the Over 2.5 odds",
  under_2_5_odds: "the Under 2.5 odds",
  btts_yes_odds: "the both-teams-score odds",
  market_odds: "the fair odds on your market",
  model_prob: "the model's probability for your market",
  market_prob: "the bookies' probability for your market",
  edge: "the edge on your market",
  home_wins_last5: "the home team's wins in its last 5",
  away_wins_last5: "the away team's wins in its last 5",
  home_form_ppg: "the home team's points per game (last 5)",
  away_form_ppg: "the away team's points per game (last 5)",
  home_win_prob: "the model's home-win chance",
  away_win_prob: "the model's away-win chance",
  home_score_prob: "the chance the home team scores",
  away_score_prob: "the chance the away team scores",
  home_goals_blend: "the home team's blend (goals scored + conceded per game, last 5)",
  away_goals_blend: "the away team's blend (goals scored + conceded per game, last 5)",
  goals_blend: "the two teams' combined blend",
  min_goals_blend: "the lower of the two teams' blends",
  home_goals_avg: "goals the home team scores per game (last 5)",
  away_goals_avg: "goals the away team scores per game (last 5)",
  h2h_n: "how many head-to-head meetings are on record",
  h2h_over25: "head-to-head meetings (last up to 10) that went over 2.5 goals",
  h2h_over35: "head-to-head meetings (last up to 10) that went over 3.5 goals",
  h2h_avg_goals: "the average total goals across the last head-to-head meetings",
  h2h_btts: "head-to-head meetings (last up to 10) where both teams scored",
  h2h_home_wins: "head-to-head meetings (last up to 10) the home team won",
  h2h_away_wins: "head-to-head meetings (last up to 10) the away team won",
  h2h_home_scored: "head-to-head meetings (last up to 10) where the home team scored",
  h2h_away_scored: "head-to-head meetings (last up to 10) where the away team scored",
  home_corners_avg: "the home team's corners per game (recent games with corner stats)",
  away_corners_avg: "the away team's corners per game (recent games with corner stats)",
  corners_avg: "the two teams' combined corners per game",
};
// probability-like fields read better as percentages
const PCT = new Set(["model_prob", "market_prob", "edge", "home_win_prob", "away_win_prob", "home_score_prob", "away_score_prob"]);

const MARKET: Record<string, string> = {
  home_win: "Home win",
  away_win: "Away win",
  draw: "Draw",
  double_chance_1x: "Double chance (1X)",
  double_chance_x2: "Double chance (X2)",
  double_chance_12: "Double chance (12)",
  over_1_5: "Over 1.5 goals",
  over_2_5: "Over 2.5 goals",
  over_3_5: "Over 3.5 goals",
  under_2_5: "Under 2.5 goals",
  under_3_5: "Under 3.5 goals",
  btts: "Both teams to score",
  home_to_score: "Home team to score",
  away_to_score: "Away team to score",
};

const val = (field: string, n: number) => (PCT.has(field) ? `${Math.round(n * 100)}%` : `${n}`);

function cond(field: string, op: string, v: number, v2: number): string {
  const f = FIELD[field] ?? field.replace(/_/g, " ");
  switch (op) {
    case "gte": return `${f} is at least ${val(field, v)}`;
    case "gt": return `${f} is above ${val(field, v)}`;
    case "lte": return `${f} is at most ${val(field, v)}`;
    case "lt": return `${f} is below ${val(field, v)}`;
    case "eq": return `${f} is exactly ${val(field, v)}`;
    case "between": return `${f} is between ${val(field, v)} and ${val(field, v2)}`;
    default: return `${f} ${op} ${val(field, v)}`;
  }
}

// One sentence per condition/branch, in the exact order the engine evaluates them.
// empty = the parse holds nothing actionable (the engine would silently ignore the rule).
export function describeRule(p: ParsedRule | null | undefined): { lines: string[]; empty: boolean } {
  const filters = Array.isArray(p?.filters) ? p!.filters : [];
  const select = Array.isArray(p?.select) ? p!.select : [];
  if (!filters.length && !select.length) return { lines: [], empty: true };
  const lines: string[] = [];
  for (const c of filters) lines.push(`Only games where ${cond(c.field, c.op, c.value, c.value2)}.`);
  let hasDefault = false;
  for (const b of select) {
    const m = MARKET[b.market_key] ?? b.market_key.replace(/_/g, " ");
    const conds: RuleCond[] = Array.isArray(b.when)
      ? b.when
      : !b.when_field || b.when_field === "always" || b.when_op === "always"
        ? []
        : [{ field: b.when_field, op: b.when_op ?? "", value: b.when_value ?? 0, value2: b.when_value2 ?? 0 }];
    // a default branch always fires — anything after it is dead, exactly like the engine
    if (conds.length === 0) {
      lines.push(`Otherwise → bet ${m}.`);
      hasDefault = true;
      break;
    }
    lines.push(`If ${conds.map((c) => cond(c.field, c.op, c.value, c.value2)).join(" and ")} → bet ${m}.`);
  }
  if (select.length && !hasDefault) lines.push("If none of those match → skip the game.");
  return { lines, empty: false };
}
