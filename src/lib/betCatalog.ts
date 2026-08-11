// Onside football bet catalog + grading dictionary — the SportyBet market set,
// encoded from Complete_Betting_Markets_Glossary.md so we can RECOGNISE and
// AUTO-GRADE any bet a user types or uploads. This is the moat.
//
// recognizeBet() maps free text to a canonical { marketKey, side, line, period,
// value }. The poll engine grades each ticket by looking that market up (the
// "dictionary") and applying its rule to the match facts. Symmetry is built in:
// every 1st-half market has a 2nd-half twin (period "1h"/"2h"), and every home
// market has an away twin — the glossary omits the away side when the home side
// is already shown, so recognition and grading fill both in.

export type BetValueSpec = {
  kind: "player" | "line" | "score" | "range" | "text";
  label: string; // shown above the input
  placeholder: string;
};

const PLAYER: BetValueSpec = { kind: "player", label: "Which player?", placeholder: "e.g. Osorio, Jonathan" };
const SCORE: BetValueSpec = { kind: "score", label: "Which score?", placeholder: "e.g. 2-1" };
const RANGE: BetValueSpec = { kind: "range", label: "Which range?", placeholder: "e.g. 2-3, 4+" };
const LINE: BetValueSpec = { kind: "line", label: "Which line?", placeholder: "e.g. 2.5" };
const TEXT: BetValueSpec = { kind: "text", label: "Your exact selection", placeholder: "as printed on your slip" };

export type Period = "ft" | "1h" | "2h";

export type CatalogMarket = {
  id: string;
  label: string;
  group: "Result" | "Goals" | "Both teams" | "Team" | "Half" | "Score" | "Corners" | "Bookings" | "Stats" | "Player" | "Special";
  gradeableKey: string | null;
  value?: BetValueSpec;
  rule: string;
};

// Documentation of the families we grade (recognition is driven by recognizeBet).
export const BET_CATALOG: CatalogMarket[] = [
  { id: "result_1x2", label: "Match result (1X2)", group: "Result", gradeableKey: "result_1x2", rule: "1 home / X draw / 2 away, by period." },
  { id: "home_win_1up", label: "Home 1UP", group: "Result", gradeableKey: "home_win_1up", rule: "Pays the moment home leads by one goal; final result then no longer matters." },
  { id: "away_win_1up", label: "Away 1UP", group: "Result", gradeableKey: "away_win_1up", rule: "Pays the moment away leads by one goal; final result then no longer matters." },
  { id: "home_win_2up", label: "Home 2UP", group: "Result", gradeableKey: "home_win_2up", rule: "Home to win; paid early if home leads by two goals at any time (regular time)." },
  { id: "away_win_2up", label: "Away 2UP", group: "Result", gradeableKey: "away_win_2up", rule: "Away to win; paid early if away leads by two goals at any time (regular time)." },
  { id: "draw_2up", label: "Draw 2UP", group: "Result", gradeableKey: "draw_2up", rule: "Match ends level (no early payout — a draw can't lead by two)." },
  { id: "home_win_never_down", label: "Home Never Down", group: "Result", gradeableKey: "home_win_never_down", rule: "Home wins without ever trailing; going a goal behind loses it, even on a comeback." },
  { id: "away_win_never_down", label: "Away Never Down", group: "Result", gradeableKey: "away_win_never_down", rule: "Away wins without ever trailing; going a goal behind loses it, even on a comeback." },
  { id: "draw_never_down", label: "Draw Never Down", group: "Result", gradeableKey: "draw_never_down", rule: "Match ends level (regular 1X2 draw)." },
  { id: "double_chance_1x_1up", label: "Home or draw (1X) 1UP", group: "Result", gradeableKey: "double_chance_1x_1up", rule: "Pays early if home leads at any moment; else a normal 1X (home or draw)." },
  { id: "double_chance_x2_1up", label: "Draw or away (X2) 1UP", group: "Result", gradeableKey: "double_chance_x2_1up", rule: "Pays early if away leads at any moment; else a normal X2 (draw or away)." },
  { id: "over_1_5_eg", label: "Over 1.5 (Early Goals)", group: "Goals", gradeableKey: "over_1_5_eg", rule: "Pays early if 1 goal by the 10th minute; else a normal Over 1.5." },
  { id: "over_2_5_eg", label: "Over 2.5 (Early Goals)", group: "Goals", gradeableKey: "over_2_5_eg", rule: "Pays early if 2 goals by the 30th minute; else a normal Over 2.5." },
  { id: "over_3_5_eg", label: "Over 3.5 (Early Goals)", group: "Goals", gradeableKey: "over_3_5_eg", rule: "Pays early if 3 goals by the 50th minute; else a normal Over 3.5." },
  { id: "double_chance", label: "Double chance", group: "Result", gradeableKey: "double_chance", rule: "Two of the three outcomes (1X/X2/12)." },
  { id: "dnb", label: "Draw no bet", group: "Result", gradeableKey: "dnb", rule: "Pick a team; stake voided on a draw." },
  { id: "team_no_bet", label: "Home/Away no bet", group: "Result", gradeableKey: "home_no_bet", rule: "Voided if the named team wins." },
  { id: "total_goals_ou", label: "Total goals over/under", group: "Goals", gradeableKey: "total_goals_ou", value: LINE, rule: "Total goals over/under a line, by period." },
  { id: "team_goals_ou", label: "Team goals over/under", group: "Team", gradeableKey: "home_goals_ou", value: LINE, rule: "A team's goals over/under a line." },
  { id: "odd_even", label: "Odd/Even goals", group: "Goals", gradeableKey: "odd_even", rule: "Total goals odd or even (0 is even)." },
  { id: "exact_goals", label: "Exact goals", group: "Goals", gradeableKey: "exact_goals", value: LINE, rule: "Exact number of goals." },
  { id: "goal_range", label: "Goal range / multigoals", group: "Goals", gradeableKey: "goal_range", value: RANGE, rule: "Total goals within a range." },
  { id: "excluded_goals", label: "Excluded number of goals", group: "Goals", gradeableKey: "excluded_goals", value: RANGE, rule: "Bet against an exact total-goals count (wins if NOT that number)." },
  { id: "btts", label: "Both teams to score", group: "Both teams", gradeableKey: "btts", rule: "Both teams score (Yes/No), by period." },
  { id: "btts_2plus", label: "Both teams score 2+", group: "Both teams", gradeableKey: "btts_2plus", rule: "Both teams score 2 or more." },
  { id: "goals_in_row_2", label: "Any team 2 goals in a row", group: "Goals", gradeableKey: "goals_in_row_2", rule: "Any team scores 2+ goals in a row (no reply between)." },
  { id: "goals_in_row_3", label: "Any team 3 goals in a row", group: "Goals", gradeableKey: "goals_in_row_3", rule: "Any team scores 3+ goals in a row (no reply between)." },
  { id: "home_goals_in_row_2", label: "Home 2 goals in a row", group: "Team", gradeableKey: "home_goals_in_row_2", rule: "Home team scores 2+ goals in a row (no reply between)." },
  { id: "home_goals_in_row_3", label: "Home 3 goals in a row", group: "Team", gradeableKey: "home_goals_in_row_3", rule: "Home team scores 3+ goals in a row (no reply between)." },
  { id: "away_goals_in_row_2", label: "Away 2 goals in a row", group: "Team", gradeableKey: "away_goals_in_row_2", rule: "Away team scores 2+ goals in a row (no reply between)." },
  { id: "away_goals_in_row_3", label: "Away 3 goals in a row", group: "Team", gradeableKey: "away_goals_in_row_3", rule: "Away team scores 3+ goals in a row (no reply between)." },
  { id: "lead_by_1", label: "Any team to lead by 1", group: "Goals", gradeableKey: "lead_by_1", rule: "Any team leads by 1+ at any point in regular time." },
  { id: "lead_by_2", label: "Any team to lead by 2", group: "Goals", gradeableKey: "lead_by_2", rule: "Any team leads by 2+ at any point in regular time." },
  { id: "lead_by_3", label: "Any team to lead by 3", group: "Goals", gradeableKey: "lead_by_3", rule: "Any team leads by 3+ at any point in regular time." },
  { id: "home_lead_by_1", label: "Home to lead by 1", group: "Team", gradeableKey: "home_lead_by_1", rule: "Home team leads by 1+ at any point in regular time." },
  { id: "home_lead_by_2", label: "Home to lead by 2", group: "Team", gradeableKey: "home_lead_by_2", rule: "Home team leads by 2+ at any point in regular time." },
  { id: "home_lead_by_3", label: "Home to lead by 3", group: "Team", gradeableKey: "home_lead_by_3", rule: "Home team leads by 3+ at any point in regular time." },
  { id: "away_lead_by_1", label: "Away to lead by 1", group: "Team", gradeableKey: "away_lead_by_1", rule: "Away team leads by 1+ at any point in regular time." },
  { id: "away_lead_by_2", label: "Away to lead by 2", group: "Team", gradeableKey: "away_lead_by_2", rule: "Away team leads by 2+ at any point in regular time." },
  { id: "away_lead_by_3", label: "Away to lead by 3", group: "Team", gradeableKey: "away_lead_by_3", rule: "Away team leads by 3+ at any point in regular time." },
  { id: "clean_sheet", label: "Clean sheet", group: "Team", gradeableKey: "home_clean_sheet", rule: "A team concedes no goals." },
  { id: "win_to_nil", label: "Win to nil", group: "Team", gradeableKey: "home_win_to_nil", rule: "A team wins without conceding." },
  { id: "win_both_halves", label: "Win both halves", group: "Team", gradeableKey: "home_win_both_halves", rule: "A team wins the 1st and 2nd half." },
  { id: "win_either_half", label: "Win either half", group: "Team", gradeableKey: "home_win_either_half", rule: "A team wins at least one half." },
  { id: "from_behind", label: "Win from behind", group: "Team", gradeableKey: "home_from_behind", rule: "A team wins after trailing." },
  { id: "correct_score", label: "Correct score", group: "Score", gradeableKey: "correct_score", value: SCORE, rule: "Exact score, by period." },
  { id: "result_btts", label: "1X2 & GG/NG", group: "Special", gradeableKey: "result_btts", rule: "Match result AND both teams to score." },
  { id: "result_ou", label: "1X2 & Over/Under", group: "Special", gradeableKey: "result_ou", value: LINE, rule: "Match result AND total goals over/under." },
  { id: "dc_btts", label: "Double Chance & GG/NG", group: "Special", gradeableKey: "dc_btts", rule: "Double chance AND both teams to score." },
  { id: "dc_ou", label: "Double Chance & Over/Under", group: "Special", gradeableKey: "dc_ou", value: LINE, rule: "Double chance AND total goals over/under." },
  { id: "ou_btts", label: "Over/Under & GG/NG", group: "Special", gradeableKey: "ou_btts", value: LINE, rule: "Total goals over/under AND both teams to score." },
  { id: "result_or_ou", label: "1X2 or Over/Under", group: "Special", gradeableKey: "result_or_ou", value: LINE, rule: "Result OR total goals over/under — either wins." },
  { id: "result_or_btts", label: "1X2 or GG/NG", group: "Special", gradeableKey: "result_or_btts", rule: "Result OR both teams to score — either wins." },
  { id: "result_or_cs", label: "1X2 or Clean Sheet", group: "Special", gradeableKey: "result_or_cs", rule: "Result OR either team keeps a clean sheet — either wins." },
  { id: "htft", label: "Half-time/Full-time", group: "Score", gradeableKey: "htft", value: TEXT, rule: "Leader at HT and at FT." },
  { id: "htft_cs", label: "HT/FT correct score", group: "Score", gradeableKey: "htft_cs", value: TEXT, rule: "Exact 1st-half score and exact full-time score." },
  { id: "teams_to_score", label: "Teams to score", group: "Goals", gradeableKey: "teams_to_score", rule: "Which team(s) score: both / home / away / neither." },
  { id: "home_highest_scoring_half", label: "Home highest scoring half", group: "Half", gradeableKey: "home_highest_scoring_half", rule: "Which half the Home team scored more in." },
  { id: "first_team_to_score", label: "First team to score", group: "Score", gradeableKey: "first_team_to_score", rule: "Which team scores first (or none)." },
  { id: "first_goal_interval", label: "When will the 1st goal be scored", group: "Goals", gradeableKey: "first_goal_interval", value: TEXT, rule: "Which minute interval the first goal falls in (or None)." },
  { id: "result_by_minute", label: "1X2 up to minute N", group: "Result", gradeableKey: "result_by_minute", value: TEXT, rule: "1X2 counting only goals up to minute N." },
  { id: "goals_ou_by_minute", label: "Total goals up to minute N", group: "Goals", gradeableKey: "goals_ou_by_minute", value: TEXT, rule: "Total goals over/under a line, counting only goals up to minute N." },
  { id: "last_team_to_score", label: "Last team to score", group: "Score", gradeableKey: "last_team_to_score", rule: "Which team scores last (or none)." },
  { id: "highest_scoring_half", label: "Highest scoring half", group: "Half", gradeableKey: "highest_scoring_half", rule: "Which half has more goals (or equal)." },
  { id: "both_halves_ou", label: "Both halves over/under", group: "Half", gradeableKey: "both_halves_ou", value: LINE, rule: "Each half over/under the line." },
  { id: "winning_margin", label: "Winning margin", group: "Result", gradeableKey: "winning_margin", value: TEXT, rule: "By how many goals the winner wins." },
  { id: "handicap", label: "Asian handicap", group: "Result", gradeableKey: "handicap", value: TEXT, rule: "Home/Away on a ± line, e.g. home +0.5. Whole balls can push (void)." },
  { id: "handicap_eu", label: "Handicap", group: "Result", gradeableKey: "handicap_eu", rule: "Home/Draw/Away on a scoreline head-start, e.g. 0:1 (away +1). Overtime excluded." },
  { id: "anytime_goalscorer", label: "Anytime goalscorer", group: "Player", gradeableKey: "anytime_goalscorer", value: PLAYER, rule: "Player scores at any time." },
  { id: "first_goalscorer", label: "First goalscorer", group: "Player", gradeableKey: "first_goalscorer", value: PLAYER, rule: "Player scores the first goal." },
  { id: "last_goalscorer", label: "Last goalscorer", group: "Player", gradeableKey: "last_goalscorer", value: PLAYER, rule: "Player scores the last goal." },
  { id: "player_score_assist", label: "Player to score or assist", group: "Player", gradeableKey: "player_score_assist", value: PLAYER, rule: "Player scores or assists." },
  { id: "player_assist", label: "Player to assist", group: "Player", gradeableKey: "player_assist", value: PLAYER, rule: "Player registers an assist." },
  { id: "player_card", label: "Player to be carded", group: "Player", gradeableKey: "player_card", value: PLAYER, rule: "Player receives any card." },
  { id: "player_booked", label: "Player to be booked", group: "Player", gradeableKey: "player_booked", value: PLAYER, rule: "Player receives a yellow." },
  { id: "player_sent_off", label: "Player to be sent off", group: "Player", gradeableKey: "player_sent_off", value: PLAYER, rule: "Player receives a red." },
  { id: "cards_ou", label: "Bookings over/under", group: "Bookings", gradeableKey: "cards_ou", value: LINE, rule: "Total bookings over/under (YC=1, RC=2)." },
  { id: "cards_1x2", label: "Bookings 1X2", group: "Bookings", gradeableKey: "cards_1x2", rule: "Which team gets more bookings." },
  { id: "first_booking", label: "1st booking", group: "Bookings", gradeableKey: "first_booking", rule: "Which team gets the first card (Home/None/Away)." },
  { id: "booking_points_ou", label: "Booking points over/under", group: "Bookings", gradeableKey: "booking_points_ou", value: LINE, rule: "Booking points over/under (YC=10, RC=25)." },
  { id: "cards_handicap", label: "Bookings handicap", group: "Bookings", gradeableKey: "cards_handicap", rule: "Card-count handicap on the picked team." },
  { id: "home_exact_cards", label: "Home exact bookings", group: "Bookings", gradeableKey: "home_exact_cards", value: LINE, rule: "Exact number of Home cards." },
  { id: "penalty_match", label: "Penalty in the match", group: "Special", gradeableKey: "penalty_match", rule: "A penalty is awarded in the match." },
  { id: "penalty_scored", label: "Penalty scored", group: "Special", gradeableKey: "penalty_scored", rule: "A goal is scored from a penalty." },
  { id: "over_8_5_corners", label: "Over corners", group: "Corners", gradeableKey: "over_8_5_corners", value: LINE, rule: "Total corners over a line." },
  { id: "corners_ou", label: "Corners over/under", group: "Corners", gradeableKey: "corners_ou", value: LINE, rule: "Total corners over/under a line (incl. 1st/2nd half)." },
  { id: "corner_handicap", label: "Corner handicap", group: "Corners", gradeableKey: "corner_handicap", rule: "Corner-count handicap on the picked team." },
  { id: "corners_1x2", label: "Corners 1X2", group: "Corners", gradeableKey: "corners_1x2", rule: "Which team wins the corner count." },
  { id: "home_corners_ou", label: "Home corners over/under", group: "Corners", gradeableKey: "home_corners_ou", value: LINE, rule: "Home corner count over/under." },
  { id: "corner_range", label: "Corner range", group: "Corners", gradeableKey: "corner_range", value: RANGE, rule: "Total corners within a range." },
  { id: "home_corner_range", label: "Home corner range", group: "Corners", gradeableKey: "home_corner_range", value: RANGE, rule: "Home corners within a range." },
  { id: "away_corner_range", label: "Away corner range", group: "Corners", gradeableKey: "away_corner_range", value: RANGE, rule: "Away corners within a range." },
  { id: "corners_odd_even", label: "Corners odd/even", group: "Corners", gradeableKey: "corners_odd_even", rule: "Total corners odd or even." },
  { id: "shots_1x2", label: "Shots 1X2", group: "Stats", gradeableKey: "shots_1x2", rule: "Which team has more total shots." },
  { id: "shots_ou", label: "Shots over/under", group: "Stats", gradeableKey: "shots_ou", value: LINE, rule: "Total shots over/under a line." },
  { id: "sot_1x2", label: "Shots on target 1X2", group: "Stats", gradeableKey: "sot_1x2", rule: "Which team has more shots on target." },
  { id: "sot_ou", label: "Shots on target over/under", group: "Stats", gradeableKey: "sot_ou", value: LINE, rule: "Total shots on target over/under a line." },
  { id: "offsides_1x2", label: "Offsides 1X2", group: "Stats", gradeableKey: "offsides_1x2", rule: "Which team has more offsides." },
  { id: "offsides_ou", label: "Offsides over/under", group: "Stats", gradeableKey: "offsides_ou", value: LINE, rule: "Total offsides over/under a line." },
  { id: "fouls_1x2", label: "Fouls 1X2", group: "Stats", gradeableKey: "fouls_1x2", rule: "Which team commits more fouls." },
  { id: "fouls_ou", label: "Fouls over/under", group: "Stats", gradeableKey: "fouls_ou", value: LINE, rule: "Total fouls over/under a line." },
  { id: "home_to_qualify", label: "Home to qualify", group: "Special", gradeableKey: "home_to_qualify", rule: "Home advances (incl. ET/pens)." },
  { id: "away_to_qualify", label: "Away to qualify", group: "Special", gradeableKey: "away_to_qualify", rule: "Away advances (incl. ET/pens)." },
];

export type RecognizedBet = {
  marketKey: string; // canonical engine key, or "custom" when we can't grade it yet
  label: string; // clean, completed label (period-prefixed; value appended after " — ")
  line: number | null;
  side: string | null;
  period: Period; // which period the bet covers
  gradeable: boolean; // true = the poll engine settles it from the glossary rules
  value?: string | null; // a value extracted from the text (player, score, range…)
  needsValue?: BetValueSpec | null; // when set, the UI must collect this value
  valueTarget?: "bet_value" | "side"; // where the collected value goes (default bet_value)
};

// Lowercase + collapse whitespace, and drop SEPARATOR dashes ("1X2 - Home" → "1x2 home") the way
// bookmakers punctuate market names. A dash between two digits ("2 - 1" correct score) is kept.
const norm = (s: string) =>
  s.toLowerCase()
    .replace(/([^0-9\s])\s+[-–—·|]\s+/g, "$1 ")
    .replace(/\s+[-–—·|]\s+([^0-9\s])/g, " $1")
    .replace(/\s+/g, " ").replace(/\.$/, "").trim();
const cap = (s: string) => s.replace(/\b\w/g, (c) => c.toUpperCase());

// exact-phrase alias table
const ALIASES: Record<string, RecognizedBet> = {};
const A = (aliases: string[], marketKey: string, label: string, side: string | null = null, gradeable = true) => {
  for (const a of aliases) ALIASES[a] = { marketKey, label, line: null, side, period: "ft", gradeable, value: null, needsValue: null };
};
const D = (aliases: string[], label: string, side: string | null = null) => A(aliases, "custom", label, side, false);

// ---- Result ----
A(["1", "home", "home win", "home to win", "1x2 home", "1x2 1", "match result home", "full time result home", "ft result home", "result home"], "home_win", "Home win", "home");
A(["2", "away", "away win", "away to win", "1x2 away", "1x2 2", "match result away", "full time result away", "ft result away", "result away"], "away_win", "Away win", "away");
A(["x", "draw", "tie", "1x2 draw", "1x2 x", "match result draw", "full time result draw", "ft result draw", "result draw"], "draw", "Draw", "draw");
A(["1x", "home or draw", "draw or home", "home/draw", "double chance 1x", "double chance home"], "double_chance_1x", "Home or draw (1X)", "1x");
A(["x2", "away or draw", "draw or away", "draw/away", "double chance x2", "double chance away"], "double_chance_x2", "Draw or away (X2)", "x2");
A(["12", "home or away", "away or home", "double chance 12"], "double_chance_12", "Home or away (12)", "12");
A(["home dnb", "1 dnb", "home draw no bet"], "dnb", "Home (draw no bet)", "home");
A(["away dnb", "2 dnb", "away draw no bet"], "dnb", "Away (draw no bet)", "away");
D(["home no bet"], "Home no bet", "home"); // needs a draw/away sub-pick we don't capture
D(["away no bet"], "Away no bet", "away");
// ---- Both teams / team to score ----
A(["gg", "btts", "btts yes", "both teams to score", "both teams to score yes", "both team to score", "goal goal", "both to score"], "btts", "Both teams to score", "yes");
A(["ng", "no goal", "btts no", "both teams to score no", "no goal ng"], "btts", "No goal (NG)", "no");
A(["home to score", "home scores", "home team to score", "home yes"], "home_to_score", "Home team to score", "home");
A(["away to score", "away scores", "away team to score", "away yes"], "away_to_score", "Away team to score", "away");
A(["gg2", "both teams to score 2", "both teams score 2", "gg 2+"], "btts_2plus", "Both teams score 2+", "yes");
A(["2 goals in a row", "2 in a row", "two goals in a row", "two in a row", "any team 2 in a row", "any team to score 2 in a row"], "goals_in_row_2", "Any team 2 goals in a row", "yes");
A(["3 goals in a row", "3 in a row", "three goals in a row", "three in a row", "any team 3 in a row", "any team to score 3 in a row"], "goals_in_row_3", "Any team 3 goals in a row", "yes");
A(["home 2 in a row", "home 2 goals in a row", "home team 2 in a row", "home team to score 2 in a row"], "home_goals_in_row_2", "Home 2 goals in a row", "yes");
A(["home 3 in a row", "home 3 goals in a row", "home team 3 in a row", "home team to score 3 in a row"], "home_goals_in_row_3", "Home 3 goals in a row", "yes");
A(["away 2 in a row", "away 2 goals in a row", "away team 2 in a row", "away team to score 2 in a row"], "away_goals_in_row_2", "Away 2 goals in a row", "yes");
A(["away 3 in a row", "away 3 goals in a row", "away team 3 in a row", "away team to score 3 in a row"], "away_goals_in_row_3", "Away 3 goals in a row", "yes");
A(["lead by 1", "any team to lead by 1", "team to lead by 1", "lead by 1 goal"], "lead_by_1", "Any team to lead by 1", "yes");
A(["lead by 2", "any team to lead by 2", "team to lead by 2", "lead by 2 goals"], "lead_by_2", "Any team to lead by 2", "yes");
A(["lead by 3", "any team to lead by 3", "team to lead by 3", "lead by 3 goals"], "lead_by_3", "Any team to lead by 3", "yes");
A(["home to lead by 1", "home lead by 1", "home team to lead by 1"], "home_lead_by_1", "Home to lead by 1", "yes");
A(["home to lead by 2", "home lead by 2", "home team to lead by 2"], "home_lead_by_2", "Home to lead by 2", "yes");
A(["home to lead by 3", "home lead by 3", "home team to lead by 3"], "home_lead_by_3", "Home to lead by 3", "yes");
A(["away to lead by 1", "away lead by 1", "away team to lead by 1"], "away_lead_by_1", "Away to lead by 1", "yes");
A(["away to lead by 2", "away lead by 2", "away team to lead by 2"], "away_lead_by_2", "Away to lead by 2", "yes");
A(["away to lead by 3", "away lead by 3", "away team to lead by 3"], "away_lead_by_3", "Away to lead by 3", "yes");
A(["both teams to score in both halves", "btts both halves"], "btts_both_halves", "Both teams score in both halves", "yes");
A(["no draw both teams to score", "no draw btts", "no draw gg"], "no_draw_btts", "No draw & both teams to score", "yes");
// ---- Odd/Even ----
A(["odd", "odd goals", "total goals odd"], "odd_even", "Odd total goals", "odd");
A(["even", "even goals", "total goals even"], "odd_even", "Even total goals", "even");
A(["home odd", "home odd goals"], "home_odd_even", "Home odd goals", "odd");
A(["home even", "home even goals"], "home_odd_even", "Home even goals", "even");
A(["away odd", "away odd goals"], "away_odd_even", "Away odd goals", "odd");
A(["away even", "away even goals"], "away_odd_even", "Away even goals", "even");
// ---- Team specials ----
A(["home win to nil", "home wtn"], "home_win_to_nil", "Home win to nil", "home");
A(["away win to nil", "away wtn"], "away_win_to_nil", "Away win to nil", "away");
A(["home clean sheet", "home cs"], "home_clean_sheet", "Home clean sheet", "home");
A(["away clean sheet", "away cs"], "away_clean_sheet", "Away clean sheet", "away");
A(["home win both halves", "home to win both halves", "home both halves"], "home_win_both_halves", "Home win both halves", "home");
A(["away win both halves", "away to win both halves", "away both halves"], "away_win_both_halves", "Away win both halves", "away");
A(["home win either half", "home to win either half"], "home_win_either_half", "Home win either half", "home");
A(["away win either half", "away to win either half"], "away_win_either_half", "Away win either half", "away");
A(["home from behind", "home to win from behind", "home comeback"], "home_from_behind", "Home to win from behind", "home");
A(["away from behind", "away to win from behind", "away comeback"], "away_from_behind", "Away to win from behind", "away");
A(["home to score in both halves", "home both halves score"], "home_score_both_halves", "Home to score in both halves", "home");
A(["away to score in both halves", "away both halves score"], "away_score_both_halves", "Away to score in both halves", "away");
// ---- Score / half ----
A(["home to score first", "home first to score", "first team to score home"], "first_team_to_score", "Home to score first", "home");
A(["away to score first", "away first to score", "first team to score away"], "first_team_to_score", "Away to score first", "away");
A(["no goal first", "neither to score"], "first_team_to_score", "No goal", "none");
A(["home to score last", "home last to score", "last team to score home"], "last_team_to_score", "Home to score last", "home");
A(["away to score last", "away last to score", "last team to score away"], "last_team_to_score", "Away to score last", "away");
A(["highest scoring half 1", "most goals 1st half", "first half more goals", "1st half most goals"], "highest_scoring_half", "Highest scoring half — 1st", "1h");
A(["highest scoring half 2", "most goals 2nd half", "second half more goals", "2nd half most goals"], "highest_scoring_half", "Highest scoring half — 2nd", "2h");
A(["highest scoring half equal", "halves equal goals", "equal goals both halves"], "highest_scoring_half", "Highest scoring half — equal", "equal");
// ---- Special ----
A(["penalty", "penalty yes", "penalty awarded", "penalty in the match"], "penalty_match", "Penalty in the match", "yes");
A(["penalty scored", "penalty goal", "scored penalty", "goal from penalty", "penalty converted"], "penalty_scored", "Penalty scored", "yes");
A(["home to qualify", "home qualify", "home advance", "home to advance", "home progress"], "home_to_qualify", "Home to qualify", "home");
A(["away to qualify", "away qualify", "away advance", "away to advance", "away progress"], "away_to_qualify", "Away to qualify", "away");
// ---- Deferred (recognised, cleaned, still manual until we fetch the data) ----
D(["corners 1x2", "corner 1x2", "most corners"], "Corners 1X2");
D(["shots 1x2", "most shots"], "Shots 1X2");
D(["shots on target 1x2", "sot 1x2", "most shots on target"], "Shots on target 1X2");
D(["fouls 1x2", "most fouls"], "Fouls 1X2");
D(["offsides 1x2", "most offsides"], "Offsides 1X2");
D(["odd corners", "corners odd"], "Odd corners");
D(["even corners", "corners even"], "Even corners");
D(["1st half result or match result", "half or match result"], "1st half result or match result");

const OVER: Record<string, string> = { "0.5": "over_0_5", "1.5": "over_1_5", "2.5": "over_2_5", "3.5": "over_3_5" };
const UNDER: Record<string, string> = { "2.5": "under_2_5", "3.5": "under_3_5" };

// player-market phrases → canonical key + label. Order: most specific first.
const PLAYER_PATTERNS: { re: RegExp; key: string; label: string; gradeable: boolean }[] = [
  { re: /\b(anytime goal ?scorer|to score anytime|anytime to score|anytime scorer)\b/, key: "anytime_goalscorer", label: "Anytime goalscorer", gradeable: true },
  { re: /\b(first goal ?scorer|1st goal ?scorer|first scorer|to open the scoring)\b/, key: "first_goalscorer", label: "First goalscorer", gradeable: true },
  { re: /\b(last goal ?scorer|last scorer)\b/, key: "last_goalscorer", label: "Last goalscorer", gradeable: true },
  { re: /\b(not to score)\b/, key: "player_not_to_score", label: "Player not to score", gradeable: true },
  { re: /\b(to be sent off|to be shown a red|sent off|red card)\b/, key: "player_sent_off", label: "Player to be sent off", gradeable: true },
  { re: /\b(to be booked|to be shown a yellow|yellow card)\b/, key: "player_booked", label: "Player to be booked", gradeable: true },
  { re: /\b(to be carded|to receive a card|to get a card|carded)\b/, key: "player_card", label: "Player to be carded", gradeable: true },
  { re: /\b(to score (?:or|and) assist|score.?assist)\b/, key: "player_score_assist", label: "Player to score or assist", gradeable: true },
  { re: /\b(to assist|anytime assist|assist|assists)\b/, key: "player_assist", label: "Player to assist", gradeable: true },
  { re: /\b(to score a header|header)\b/, key: "custom", label: "Player to score a header", gradeable: false },
  { re: /\b(to score a free[- ]?kick|free[- ]?kick)\b/, key: "custom", label: "Player to score a free-kick", gradeable: false },
  { re: /\b(shots on target|shots on goal)\b/, key: "custom", label: "Player shots on target", gradeable: false },
  { re: /\b(shots)\b/, key: "custom", label: "Player shots", gradeable: false },
  { re: /\b(saves)\b/, key: "custom", label: "Player saves", gradeable: false },
  { re: /\b(fouls won)\b/, key: "custom", label: "Player fouls won", gradeable: false },
  { re: /\b(fouls)\b/, key: "custom", label: "Player fouls", gradeable: false },
  { re: /\b(offsides)\b/, key: "custom", label: "Player offsides", gradeable: false },
  { re: /\b(accurate passes|passes)\b/, key: "custom", label: "Player passes", gradeable: false },
  { re: /\b(to score)\b/, key: "anytime_goalscorer", label: "Anytime goalscorer", gradeable: true },
];

// pull a likely player name out of a player-market phrase (else null)
function playerName(s: string, matched: string): string | null {
  const rest = s
    .replace(matched, " ")
    .replace(/\bincl\.? overtime\b/g, " ")
    .replace(/\(.*?\)/g, " ")
    .replace(/\b(player|the|a|an|to|be|will|in|the match|regular time)\b/g, " ")
    .replace(/\b\d+(?:\.\d+)?\s*\+?\b/g, " ")
    .replace(/[|]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return rest.length >= 2 ? cap(rest) : null;
}

// strip a 1st/2nd-half phrase and report which period it named
function pullPeriod(s: string): { s: string; period: Period } {
  if (/\b(1st half|first half|1h)\b/.test(s))
    return { s: s.replace(/\b(1st half|first half|1h)\b/g, " ").replace(/\s+/g, " ").trim(), period: "1h" };
  if (/\b(2nd half|second half|2h)\b/.test(s))
    return { s: s.replace(/\b(2nd half|second half|2h)\b/g, " ").replace(/\s+/g, " ").trim(), period: "2h" };
  return { s, period: "ft" };
}

// apply the pulled period to a recognised bet (label prefix + period field)
function withPeriod(rec: RecognizedBet, period: Period): RecognizedBet {
  if (period === "ft") return rec;
  const prefix = period === "1h" ? "1st half — " : "2nd half — ";
  return { ...rec, period, label: prefix + rec.label };
}

const statName = (raw: string): string => {
  const s = raw.replace(/s$/, "");
  if (raw.startsWith("shots on target") || raw.startsWith("shots on goal")) return "shots on target";
  if (s === "shot") return "shots";
  if (s === "corner") return "corners";
  if (s === "foul") return "fouls";
  if (s === "offside") return "offsides";
  if (s === "card") return "cards";
  if (s.startsWith("booking point")) return "booking points";
  if (s === "booking") return "bookings";
  return raw;
};

/**
 * Recognise a free-text bet against the glossary dictionary. Returns a completed
 * bet with a canonical `marketKey` (gradeable) or "custom" (manual). `needsValue`
 * flags a value the UI must collect (player, score, range); `value` holds one we
 * already lifted out of the text; `period` carries 1st/2nd-half selection.
 */
/**
 * Fold markets that are the SAME outcome under different names down to one canonical key, so they
 * never double up on the tracker and grade identically. A team scoring "over 0.5 goals" is exactly
 * that team "to score"; the whole-match "over 0.5" is `over_0_5`. Applied to keys that arrive
 * pre-classified (e.g. straight off a parsed slip) without going back through recognizeBet's text.
 */
export function canonicalMarket(
  marketKey: string | null | undefined,
  line: number | string | null | undefined,
  side: string | null | undefined
): { marketKey: string | null | undefined; line: number | null; side: string | null } {
  const ln = line == null || line === "" ? null : Number(line);
  if (ln === 0.5 && side === "over") {
    if (marketKey === "home_goals_ou") return { marketKey: "home_to_score", line: null, side: "home" };
    if (marketKey === "away_goals_ou") return { marketKey: "away_to_score", line: null, side: "away" };
    if (marketKey === "total_goals_ou") return { marketKey: "over_0_5", line: 0.5, side: "over" };
  }
  return { marketKey, line: ln, side: side ?? null };
}

export function recognizeBet(input: string): RecognizedBet | null {
  const raw = norm(input);
  if (!raw) return null;

  // half-time / full-time first (before we strip the half words)
  const htft = raw.replace(/\s/g, "").match(/^([12x])[\/\-]([12x])$/);
  if (htft && (htft[1] === "x" || htft[2] === "x" || raw.includes("/"))) {
    const map: Record<string, string> = { "1": "home", x: "draw", "2": "away" };
    return {
      marketKey: "htft", label: `HT/FT ${htft[1].toUpperCase()}/${htft[2].toUpperCase()}`,
      line: null, side: null, period: "ft", gradeable: true, value: `${map[htft[1]]}/${map[htft[2]]}`,
    };
  }

  // 1UP (early-pay result): pays the moment the team goes one goal ahead — final result then
  // no longer matters. Keyword "1up" (also "1 up" / "1-up" / "one up") plus a side.
  const oneUp = raw.replace(/\b1\s*-?\s*up\b/g, "1up").replace(/\bone\s*up\b/g, "1up");
  if (/\b1up\b/.test(oneUp)) {
    const rest = oneUp.replace(/\b1up\b/g, " ").replace(/\s+/g, " ").trim();
    // Double Chance 1UP first (1X pays early if home leads, X2 if away leads)
    if (/\b1x\b/.test(rest) || /home or draw/.test(rest))
      return { marketKey: "double_chance_1x_1up", label: "Home or draw (1X) 1UP", line: null, side: "1x", period: "ft", gradeable: true, value: null };
    if (/\bx2\b/.test(rest) || /draw or away/.test(rest))
      return { marketKey: "double_chance_x2_1up", label: "Draw or away (X2) 1UP", line: null, side: "x2", period: "ft", gradeable: true, value: null };
    const side = /\b(home|1)\b/.test(rest) ? "home" : /\b(away|2)\b/.test(rest) ? "away" : null;
    if (side) {
      return {
        marketKey: side === "home" ? "home_win_1up" : "away_win_1up",
        label: side === "home" ? "Home 1UP" : "Away 1UP",
        line: null, side, period: "ft", gradeable: true, value: null,
      };
    }
  }

  // 2UP (win with early pay on a two-goal lead): keyword "2up" (also "2 up"/"2-up"/"two up")
  // + a side. Unlike 1UP this has all three selections — Draw 2UP is just a level result at FT.
  const twoUp = raw.replace(/\b2\s*-?\s*up\b/g, "2up").replace(/\btwo\s*up\b/g, "2up");
  if (/\b2up\b/.test(twoUp)) {
    const rest = twoUp.replace(/\b2up\b/g, " ").replace(/\s+/g, " ").trim();
    const side = /\b(home|1)\b/.test(rest) ? "home" : /\b(away|2)\b/.test(rest) ? "away" : /\b(draw|x)\b/.test(rest) ? "draw" : null;
    if (side) {
      const marketKey = side === "home" ? "home_win_2up" : side === "away" ? "away_win_2up" : "draw_2up";
      const label = side === "home" ? "Home 2UP" : side === "away" ? "Away 2UP" : "Draw 2UP";
      return { marketKey, label, line: null, side, period: "ft", gradeable: true, value: null };
    }
  }

  // Never Down: win WITHOUT ever trailing — going a goal behind at any point loses it, even on
  // a comeback. Keyword "never down" (also "neverdown"/"no trail") + a side. Draw = a level FT.
  const nd = raw.replace(/\bnever\s*down\b/g, "neverdown").replace(/\bno\s*trail\b/g, "neverdown");
  if (/\bneverdown\b/.test(nd)) {
    const rest = nd.replace(/\bneverdown\b/g, " ").replace(/\s+/g, " ").trim();
    const side = /\b(home|1)\b/.test(rest) ? "home" : /\b(away|2)\b/.test(rest) ? "away" : /\b(draw|x)\b/.test(rest) ? "draw" : null;
    if (side) {
      const marketKey = side === "home" ? "home_win_never_down" : side === "away" ? "away_win_never_down" : "draw_never_down";
      const label = side === "home" ? "Home Never Down" : side === "away" ? "Away Never Down" : "Draw Never Down";
      return { marketKey, label, line: null, side, period: "ft", gradeable: true, value: null };
    }
  }

  // Over Early Goals: pays an Over immediately if goals come fast (1 by 10' / 2 by 30' / 3 by
  // 50'), else a normal Over. Keyword "early goals" (or "eg") + an over line X.5.
  const egText = raw.replace(/\bearly\s*goals\b/g, "earlygoals");
  if (/\bearlygoals\b/.test(egText) || /\beg\b/.test(egText)) {
    const lm = egText.match(/([123])\s*\.\s*5/);
    if (lm) {
      const x = lm[1];
      return { marketKey: `over_${x}_5_eg`, label: `Over ${x}.5 (Early Goals)`, line: Number(`${x}.5`), side: "over", period: "ft", gradeable: true, value: null };
    }
  }

  // GG/NG 2+ : both teams score 2 or more (yes) / not both (no). "gg 2+", "ng 2+", "both 2+ no".
  if (/2\s*\+/.test(raw) && /\b(gg|ng|both|btts)\b/.test(raw)) {
    const no = /\b(ng|no)\b/.test(raw);
    return { marketKey: "btts_2plus", label: no ? "Not both teams 2+" : "Both teams score 2+", line: null, side: no ? "no" : "yes", period: "ft", gradeable: true, value: null };
  }

  // Goals in a row: a team scores N (2 or 3) consecutive goals with no opponent goal between.
  // "2 or more goals in a row" (any team), "home 3 in a row", "away team 2 goals in a row" (Yes/No).
  // NB: detect the team only by the words home/away — NOT 1/2, since "2 or more" is the count N.
  if (/in\s*a\s*row/.test(raw)) {
    const n = /\b3\b|three/.test(raw) ? "3" : "2";
    const no = /\bno\b/.test(raw);
    const team = /\bhome\b/.test(raw) ? "home" : /\baway\b/.test(raw) ? "away" : null;
    const marketKey = team ? `${team}_goals_in_row_${n}` : `goals_in_row_${n}`;
    const who = team ? cap(team) : "Any team";
    return {
      marketKey,
      label: `${who} ${n} in a row${no ? " — No" : ""}`,
      line: null, side: no ? "no" : "yes", period: "ft", gradeable: true, value: null,
    };
  }

  // Lead by N (1/2/3) goals at any time in regular play (Yes/No) — any team, or home/away
  // specific. Margin from the digit (or one/two/three); default 1. Team ONLY via home/away words
  // (not 1/2, since the digit is the margin). Guarded so it doesn't grab winning-margin phrasing.
  if (/lead by|to lead/.test(raw)) {
    const n = /\b3\b|three/.test(raw) ? "3" : /\b2\b|two/.test(raw) ? "2" : "1";
    const no = /\bno\b/.test(raw);
    const team = /\bhome\b/.test(raw) ? "home" : /\baway\b/.test(raw) ? "away" : null;
    const marketKey = team ? `${team}_lead_by_${n}` : `lead_by_${n}`;
    const who = team ? cap(team) : "Any team";
    return {
      marketKey,
      label: `${who} to lead by ${n}${no ? " — No" : ""}`,
      line: null, side: no ? "no" : "yes", period: "ft", gradeable: true, value: null,
    };
  }

  // Teams to score — which team(s) find the net: both / home only / away only / neither.
  // Guard against "both teams to score" (that's BTTS, handled by the alias map).
  if (/teams?\s+to\s+score/.test(raw) && !/both\s+teams\s+to\s+score/.test(raw)) {
    const side = /\bboth\b/.test(raw) ? "both" : /\bneither\b|\bnone\b|no\s*goal/.test(raw) ? "none"
      : /\bhome\b/.test(raw) ? "home" : /\baway\b/.test(raw) ? "away" : null;
    if (side) return { marketKey: "teams_to_score", label: `Teams to score — ${side}`, line: null, side, period: "ft", gradeable: true, value: null };
  }

  // Home/Away highest scoring half — which half that team scored more in (1st / 2nd / equal)
  const hsh = raw.match(/\b(home|away)\b[^.]*highest\s+scoring\s+half/);
  if (hsh) {
    const team = hsh[1];
    const side = /\b(2nd|second)\b/.test(raw) ? "2h" : /\b(1st|first)\b/.test(raw) ? "1h" : /\b(equal|same)\b/.test(raw) ? "equal" : null;
    if (side) return { marketKey: `${team}_highest_scoring_half`, label: `${cap(team)} highest scoring half — ${side}`, line: null, side, period: "ft", gradeable: true, value: null };
  }

  // HT/FT Correct Score — exact 1st-half score AND exact full-time score, e.g. "0:0 0:1"
  if (/correct\s*score/.test(raw) && /(ht.?ft|half.?time.*full.?time|1st half.*full)/.test(raw)) {
    const m = raw.match(/(\d+)\s*[:\-]\s*(\d+)\D+?(\d+)\s*[:\-]\s*(\d+)/);
    if (m) return { marketKey: "htft_cs", label: `HT/FT correct score ${m[1]}:${m[2]} ${m[3]}:${m[4]}`, line: null, side: null, period: "ft", gradeable: true, value: `${m[1]}:${m[2]} ${m[3]}:${m[4]}` };
  }

  // When will the 1st goal be scored — which minute interval (e.g. 11-20), or None. Must come
  // BEFORE the plain 1st-Goal branch, and only fires when a minute range is present.
  if (/\b(1st|first)\s*goal\b/.test(raw) && !/scorer/.test(raw)) {
    const bucket = raw.match(/(\d{1,2})\s*-\s*(\d{1,2})/);
    if (bucket) return { marketKey: "first_goal_interval", label: `1st goal ${bucket[1]}-${bucket[2]}`, line: null, side: null, period: "ft", gradeable: true, value: `${bucket[1]}-${bucket[2]}` };
  }

  // Total goals over/under up to minute N (goals from kick-off to minute N). Must precede the
  // 1X2-by-minute branch. Needs a goals word + over/under line so it can't steal the 1X2 market.
  if (/\bmin(?:ute)?s?\b/.test(raw) && /\bgoals?\b/.test(raw) && /(over|under|o|u)\s*[0-9]/.test(raw)) {
    const nm = raw.match(/(?:to|from 1 to|1 to)\s*(\d{1,3})\s*min/) || raw.match(/(\d{1,3})\s*min/);
    const om = raw.match(/(over|under)\s*([0-9]+(?:\.5)?)/);
    if (nm && om) {
      const over = om[1] === "over";
      return { marketKey: "goals_ou_by_minute", label: `${over ? "Over" : "Under"} ${om[2]} goals to ${nm[1]}'`, line: Number(om[2]), side: over ? "over" : "under", period: "ft", gradeable: true, value: nm[1] };
    }
  }

  // 1X2 from 1 to N minute — result counting only goals up to minute N. Side by WORD only
  // (home/draw/away), never 1/2, since the digits carry the minute.
  if (/\bmin(?:ute)?s?\b/.test(raw) && (/1\s*x\s*2/.test(raw) || /from\s*1\s*to/.test(raw) || /result/.test(raw))) {
    const nm = raw.match(/(?:to|from 1 to|1 to)\s*(\d{1,3})\s*min/) || raw.match(/(\d{1,3})\s*min/) || raw.match(/from 1 to\s*(\d{1,3})/);
    const side = /\bhome\b/.test(raw) ? "home" : /\baway\b/.test(raw) ? "away" : /\bdraw\b/.test(raw) ? "draw" : null;
    if (nm && side) return { marketKey: "result_by_minute", label: `1X2 to ${nm[1]}' — ${cap(side)}`, line: null, side, period: "ft", gradeable: true, value: nm[1] };
  }

  // 1st Goal: which team scores the first goal (Draw / No Goal = 0-0). Overtime excluded.
  // Guard against the player market "first goalscorer".
  if (/\b(1st|first)\s*goal\b/.test(raw) && !/scorer/.test(raw)) {
    const rest = raw.replace(/\b(1st|first)\s*goal\b/g, " ").replace(/\s+/g, " ").trim();
    const side = /\b(home|1)\b/.test(rest) ? "home" : /\b(away|2)\b/.test(rest) ? "away"
      : /\b(draw|x|no ?goal|neither|none)\b/.test(rest) ? "none" : null;
    if (side)
      return {
        marketKey: "first_team_to_score",
        label: side === "home" ? "Home to score first" : side === "away" ? "Away to score first" : "No goal (1st)",
        line: null, side, period: "ft", gradeable: true, value: null,
      };
  }

  // NB: 1st/Last corner is intentionally NOT recognised — API-Football gives corners only as a
  // per-team TOTAL (no minute/order), so "which team took the 1st/last corner" is ungradeable.
  // Aggregate corner markets (handicap/1X2/O-U/range/odd-even) grade fine from the totals.

  const { s, period } = pullPeriod(raw);
  const wp = (r: RecognizedBet) => withPeriod(r, period);

  // ---- combos: two legs joined by "&"/"and" (1X2 or DC) × (GG/NG or Over/Under). Word-based
  //      legs only (never bare 1/2/x) so an O/U line digit can't be mistaken for a side. ----
  if (/&|\band\b/.test(raw)) {
    const hasBtts = /\bgg\b|\bng\b|both\s*(?:teams?\s*)?to\s*score|btts/.test(raw);
    const bttsNo = /\bng\b/.test(raw) || (/\bno\b/.test(raw) && !/\bng\b/.test(raw));
    const ouM = raw.match(/\b(over|under)\s*([0-9]+(?:\.5)?)/);
    const dc = /\b1x\b|home\s*or\s*draw/.test(raw) ? "1x" : /\bx2\b|draw\s*or\s*away/.test(raw) ? "x2" : /\b12\b|home\s*or\s*away/.test(raw) ? "12" : null;
    const r1 = !dc ? (/\bhome\b/.test(raw) ? "home" : /\bdraw\b/.test(raw) ? "draw" : /\baway\b/.test(raw) ? "away" : null) : null;
    const gg = bttsNo ? "no" : "yes";
    if (r1 && hasBtts) return wp({ marketKey: "result_btts", label: `${cap(r1)} & ${bttsNo ? "NG" : "GG"}`, line: null, side: r1, gradeable: true, period, value: gg });
    if (r1 && ouM) return wp({ marketKey: "result_ou", label: `${cap(r1)} & ${cap(ouM[1])} ${ouM[2]}`, line: Number(ouM[2]), side: r1, gradeable: true, period, value: ouM[1] });
    if (dc && hasBtts) return wp({ marketKey: "dc_btts", label: `${dc.toUpperCase()} & ${bttsNo ? "NG" : "GG"}`, line: null, side: dc, gradeable: true, period, value: gg });
    if (dc && ouM) return wp({ marketKey: "dc_ou", label: `${dc.toUpperCase()} & ${cap(ouM[1])} ${ouM[2]}`, line: Number(ouM[2]), side: dc, gradeable: true, period, value: ouM[1] });
    if (ouM && hasBtts) return wp({ marketKey: "ou_btts", label: `${cap(ouM[1])} ${ouM[2]} & ${bttsNo ? "NG" : "GG"}`, line: Number(ouM[2]), side: ouM[1], gradeable: true, period, value: gg });
  }

  // ---- "result OR condition" combos: Yes wins if EITHER leg happens. Only fires when a result token
  //      is paired with a CONDITION via "or", so plain "home or draw" stays Double Chance. FT only. ----
  if (/\bor\b|\|/.test(raw)) {
    const resTok = /\bhome\b/.test(raw) ? "home" : /\bdraw\b/.test(raw) ? "draw" : /\baway\b/.test(raw) ? "away" : null;
    const ouM = raw.match(/\b(over|under)\s*([0-9]+(?:\.5)?)/);
    const hasNG = /\bng\b/.test(raw);
    const hasGG = /\bgg\b|both\s*(?:teams?\s*)?to\s*score|\bbtts\b/.test(raw);
    const hasCS = /clean\s*sheet/.test(raw);
    if (resTok && hasCS) return { marketKey: "result_or_cs", label: `${cap(resTok)} or clean sheet`, line: null, side: resTok, period: "ft", gradeable: true, value: null };
    if (resTok && (hasGG || hasNG)) return { marketKey: "result_or_btts", label: `${cap(resTok)} or ${hasNG ? "NG" : "GG"}`, line: null, side: resTok, period: "ft", gradeable: true, value: hasNG ? "no" : "yes" };
    if (resTok && ouM) return { marketKey: "result_or_ou", label: `${cap(resTok)} or ${cap(ouM[1])} ${ouM[2]}`, line: Number(ouM[2]), side: resTok, period: "ft", gradeable: true, value: ouM[1] };
  }

  // ---- corners: handicap / 1X2 / odd-even / range (graded from per-team corner totals) ----
  const cHc = s.match(/^(?:corners?)\s*handicap\s*(home|away)\s*([+-]?[0-9]+(?:\.[0-9])?)$/)
    || s.match(/^(home|away)\s*([+-][0-9]+(?:\.[0-9])?)\s*corners?\s*handicap$/);
  if (cHc) return wp({ marketKey: "corner_handicap", label: `${cap(cHc[1])} ${cHc[2].replace(/\s/g, "")} corner handicap`, line: Number(cHc[2].replace(/\s/g, "")), side: cHc[1], gradeable: true, period });
  if (/corners?/.test(s) && /1\s*x\s*2/.test(s)) {
    const side = /\bhome\b/.test(s) ? "home" : /\bdraw\b/.test(s) ? "draw" : /\baway\b/.test(s) ? "away" : null;
    if (side) return wp({ marketKey: "corners_1x2", label: `Corners 1X2 — ${cap(side)}`, line: null, side, gradeable: true, period });
  }
  if (/corners?/.test(s) && /\b(odd|even)\b/.test(s)) {
    const side = /\bodd\b/.test(s) ? "odd" : "even";
    return wp({ marketKey: "corners_odd_even", label: `Corners ${side}`, line: null, side, gradeable: true, period });
  }
  const cRange = s.match(/^(home|away)?\s*corners?\s*(?:range\s*)?([0-9]+\s*-\s*[0-9]+|[0-9]+\s*\+)$/);
  if (cRange) {
    const team = cRange[1] || "";
    const key = team === "home" ? "home_corner_range" : team === "away" ? "away_corner_range" : "corner_range";
    return wp({ marketKey: key, label: `${team ? cap(team) + " " : ""}corners ${cRange[2].replace(/\s/g, "")}`, line: null, side: team || null, gradeable: true, period, value: cRange[2].replace(/\s/g, "") });
  }

  // ---- bookings 1X2: which team gets more cards (period-aware). Corners 1X2 handled above. ----
  if (/\b(cards?|bookings?)\b/.test(s) && /1\s*x\s*2/.test(s)) {
    const side = /\bhome\b/.test(s) ? "home" : /\bdraw\b/.test(s) ? "draw" : /\baway\b/.test(s) ? "away" : null;
    if (side) return wp({ marketKey: "cards_1x2", label: `Bookings 1X2 — ${cap(side)}`, line: null, side, gradeable: true, period });
  }

  // ---- 1st booking: which team gets the first card (home/none/away). Cards are TIMED events,
  //      so this auto-grades (unlike corners). Period-aware. Guard against player-name card markets. ----
  if (/\b(1st|first)\s*(?:card|booking)\b/.test(s) && !/\bplayer\b/.test(s)) {
    const side = /\bhome\b/.test(s) ? "home" : /\baway\b/.test(s) ? "away" : /\bnone\b|neither\b|no\s*(?:card|booking)/.test(s) ? "none" : null;
    if (side) return wp({ marketKey: "first_booking", label: `1st booking — ${cap(side)}`, line: null, side, gradeable: true, period });
  }

  // ---- statistics markets: shots / shots on target / offsides / fouls (per-team totals, FT only) ----
  const STAT_KEY: Record<string, string> = { shots: "shots", "shots on target": "sot", offsides: "offsides", fouls: "fouls" };
  const STAT_LABEL: Record<string, string> = { shots: "Shots", sot: "Shots on target", offsides: "Offsides", fouls: "Fouls" };
  {
    const stKey = /shots?\s*on\s*(?:target|goal)/.test(s) ? "sot" : /\bshots?\b/.test(s) ? "shots" : /\boffside/.test(s) ? "offsides" : /\bfouls?\b/.test(s) ? "fouls" : null;
    if (stKey && /1\s*x\s*2/.test(s) && period === "ft") {
      const side = /\bhome\b/.test(s) ? "home" : /\bdraw\b/.test(s) ? "draw" : /\baway\b/.test(s) ? "away" : null;
      if (side) return { marketKey: `${stKey}_1x2`, label: `${STAT_LABEL[stKey]} 1X2 — ${cap(side)}`, line: null, side, gradeable: true, period: "ft" };
    }
  }

  // ---- stat over/under: corners / cards / bookings / shots / fouls / offsides ----
  const statWord = "(corners?|cards?|bookings?|booking points?|shots on target|shots on goal|shots|fouls|offsides)";
  const teamStat = s.match(new RegExp(`^(home|away)\\s*(over|under|o|u)\\s*([0-9]+(?:\\.[0-9])?)\\s*${statWord}$`));
  if (teamStat) {
    const stat = statName(teamStat[4]);
    const over = teamStat[2] === "over" || teamStat[2] === "o";
    const team = teamStat[1];
    if (stat === "cards" || stat === "bookings")
      return wp({ marketKey: `${team}_cards_ou`, label: `${cap(team)} ${over ? "over" : "under"} ${teamStat[3]} cards`, line: Number(teamStat[3]), side: over ? "over" : "under", gradeable: true, period });
    if (stat === "corners")
      return wp({ marketKey: `${team}_corners_ou`, label: `${cap(team)} ${over ? "over" : "under"} ${teamStat[3]} corners`, line: Number(teamStat[3]), side: over ? "over" : "under", gradeable: true, period });
    if (STAT_KEY[stat] && period === "ft")
      return { marketKey: `${team}_${STAT_KEY[stat]}_ou`, label: `${cap(team)} ${over ? "over" : "under"} ${teamStat[3]} ${stat}`, line: Number(teamStat[3]), side: over ? "over" : "under", gradeable: true, period: "ft" };
    return wp({ marketKey: "custom", label: `${cap(team)} ${over ? "over" : "under"} ${teamStat[3]} ${stat}`, line: Number(teamStat[3]), side: over ? "over" : "under", gradeable: false, period });
  }
  const so =
    s.match(new RegExp(`^(over|under|o|u)\\s*([0-9]+(?:\\.[0-9])?)\\s*${statWord}$`)) ||
    s.match(new RegExp(`^${statWord}\\s*(over|under|o|u)\\s*([0-9]+(?:\\.[0-9])?)$`));
  if (so) {
    const overFirst = /^(over|under|o|u)/.test(so[1]);
    const dir = overFirst ? so[1] : so[2];
    const ln = overFirst ? so[2] : so[3];
    const stat = statName(overFirst ? so[3] : so[1]);
    const over = dir === "over" || dir === "o";
    if (stat === "cards" || stat === "bookings")
      return wp({ marketKey: "cards_ou", label: `${over ? "Over" : "Under"} ${ln} bookings`, line: Number(ln), side: over ? "over" : "under", gradeable: true, period });
    if (stat === "booking points")
      return wp({ marketKey: "booking_points_ou", label: `${over ? "Over" : "Under"} ${ln} booking points`, line: Number(ln), side: over ? "over" : "under", gradeable: true, period });
    if (stat === "corners" && over && period === "ft")
      return { marketKey: "over_8_5_corners", label: `Over ${ln} corners`, line: Number(ln), side: "over", gradeable: true, period: "ft" };
    if (stat === "corners") // FT under, or any 1st/2nd-half total (graded from live/HT-snapshot corner totals)
      return wp({ marketKey: "corners_ou", label: `${over ? "Over" : "Under"} ${ln} corners`, line: Number(ln), side: over ? "over" : "under", gradeable: true, period });
    if (STAT_KEY[stat] && period === "ft")
      return { marketKey: `${STAT_KEY[stat]}_ou`, label: `${over ? "Over" : "Under"} ${ln} ${stat}`, line: Number(ln), side: over ? "over" : "under", gradeable: true, period: "ft" };
    return wp({ marketKey: "custom", label: `${over ? "Over" : "Under"} ${ln} ${stat}`, line: Number(ln), side: over ? "over" : "under", gradeable: false, period });
  }

  // ---- bookings handicap + exact bookings (extends the cards family) ----
  const cardHc = s.match(/^(?:cards?|bookings?)\s*handicap\s*(home|away)\s*([+-]?[0-9]+(?:\.[0-9])?)$/)
    || s.match(/^(home|away)\s*([+-][0-9]+(?:\.[0-9])?)\s*(?:cards?|bookings?)\s*handicap$/);
  if (cardHc) return wp({ marketKey: "cards_handicap", label: `${cap(cardHc[1])} ${cardHc[2].replace(/\s/g, "")} bookings handicap`, line: Number(cardHc[2].replace(/\s/g, "")), side: cardHc[1], gradeable: true, period });
  const exTeamBk = s.match(/^(home|away)(?:\s*team)?\s*exact\s*(?:cards?|bookings?)\s*([0-9]+)$/);
  if (exTeamBk) return wp({ marketKey: `${exTeamBk[1]}_exact_cards`, label: `${cap(exTeamBk[1])} exact ${exTeamBk[2]} bookings`, line: Number(exTeamBk[2]), side: null, gradeable: true, period });
  const exBk = s.match(/^exact\s*(?:cards?|bookings?)\s*([0-9]+)$/);
  if (exBk) return wp({ marketKey: "exact_cards", label: `Exactly ${exBk[1]} bookings`, line: Number(exBk[1]), side: null, gradeable: true, period });

  // ---- team goals over/under, e.g. "home over 1.5", or a bare "home 0.5" (defaults to over).
  //      NB: distinct from the Asian handicap "home +0.5" — that needs a sign, this doesn't. ----
  const teamOu = s.match(/^(home|away)\s*(over|under|o|u)?\s*([0-9]+(?:\.5)?)(?:\s*goals?)?$/);
  if (teamOu && (teamOu[2] || /\.5$/.test(teamOu[3]))) {
    const team = teamOu[1];
    const over = !teamOu[2] || teamOu[2] === "over" || teamOu[2] === "o";
    // "Home over 0.5" is exactly "home to score" — fold to the canonical to-score key so the two
    // never show up as separate bets on the tracker and grade identically.
    if (over && teamOu[3] === "0.5") return wp({ marketKey: `${team}_to_score`, label: `${cap(team)} team to score`, line: null, side: team, gradeable: true, period });
    return wp({ marketKey: `${team}_goals_ou`, label: `${cap(team)} ${over ? "over" : "under"} ${teamOu[3]}`, line: Number(teamOu[3]), side: over ? "over" : "under", gradeable: true, period });
  }

  // ---- total goals over/under ----
  const ou = s.match(/^(over|under|o|u)\s*([0-9]+(?:\.5)?)(?:\s*goals?)?$/);
  if (ou) {
    const ln = ou[2];
    const over = ou[1] === "over" || ou[1] === "o";
    if (period === "ft") {
      const core = over ? OVER[ln] : UNDER[ln];
      if (core) return { marketKey: core, label: `${over ? "Over" : "Under"} ${ln} goals`, line: Number(ln), side: over ? "over" : "under", gradeable: true, period: "ft" };
    }
    return wp({ marketKey: "total_goals_ou", label: `${over ? "Over" : "Under"} ${ln} goals`, line: Number(ln), side: over ? "over" : "under", gradeable: true, period });
  }

  // ---- Excluded Number of Goals — bet AGAINST a count/range (wins if the count is NOT it) ----
  if (/exclud/.test(s)) {
    const team = /\bhome\b/.test(s) ? "home" : /\baway\b/.test(s) ? "away" : null;
    const m = s.match(/([0-9]\s*\+|[0-9]\s*(?:-|to)\s*[0-9]|[0-9])/);
    if (m) {
      const val = m[1].replace(/\s+/g, "").replace("to", "-");
      // "Excluded … 0" = the goal count won't be 0 = at least one goal, i.e. that team (or the
      // match) TO SCORE. Grade it as the well-supported to-score / over 0.5 market so it settles
      // from the scoreline the moment a goal goes in — not the exotic excluded-count path.
      if (val === "0") {
        if (team) return wp({ marketKey: team === "home" ? "home_to_score" : "away_to_score", label: `${cap(team)} team to score`, line: null, side: team, gradeable: true, period });
        return wp({ marketKey: "over_0_5", label: "Over 0.5 goals", line: 0.5, side: "over", gradeable: true, period });
      }
      const key = team === "home" ? "excluded_home_goals" : team === "away" ? "excluded_away_goals" : "excluded_goals";
      return wp({ marketKey: key, label: `Excluded ${team ? cap(team) + " " : ""}${val} goals`, line: null, side: null, gradeable: true, period, value: val });
    }
  }

  // ---- exact goals ----
  const exact = s.match(/^(?:exactly\s*)?([0-9])\s*goals?(?:\s*exactly)?$/);
  if (exact && !s.includes("+") && !s.includes("-")) return wp({ marketKey: "exact_goals", label: `Exactly ${exact[1]} goals`, line: Number(exact[1]), side: null, gradeable: true, period });

  // ---- goal range / multigoals, e.g. "2-3 goals", "4+ goals", "no goal" ----
  const range = s.match(/^(home |away )?([0-9])\s*(?:-|to)\s*([0-9])\s*goals?$/);
  if (range) {
    const team = (range[1] || "").trim();
    const key = team === "home" ? "home_goal_range" : team === "away" ? "custom" : "goal_range";
    const val = `${range[2]}-${range[3]}`;
    return wp({ marketKey: team === "away" ? "goal_range" : key, label: `${team ? cap(team) + " " : ""}goals ${val}`, line: null, side: team || null, gradeable: true, period, value: val });
  }
  const plus = s.match(/^([0-9])\s*\+\s*goals?$/);
  if (plus) return wp({ marketKey: "goal_range", label: `${plus[1]}+ goals`, line: null, side: null, gradeable: true, period, value: `${plus[1]}+` });
  if (/^no goal$/.test(s)) return wp({ marketKey: "goal_range", label: "No goal", line: null, side: null, gradeable: true, period, value: "0" });

  // keyword-first Goal Bounds / Goal Range / Multigoals — the way books label it ("Goal Bounds -
  // Home 2-3") and people type it ("goals 2-3", "multigoals 2-4", "home goals 4+"). The team can
  // sit before or after the keyword; away grades as goal_range with side=away.
  const kwRange = s.match(/^(?:(home|away)\s+)?(?:goals?\s*(?:range|bounds?)|multi\s*goals?|goals?)\s*(?:(home|away)\s+)?([0-9]\s*(?:-|to)\s*[0-9]|[0-9]\s*\+)$/);
  if (kwRange) {
    const team = kwRange[1] ?? kwRange[2] ?? null;
    const val = kwRange[3].replace(/\s+/g, "").replace("to", "-");
    const key = team === "home" ? "home_goal_range" : "goal_range";
    return wp({ marketKey: key, label: `${team ? cap(team) + " " : ""}goals ${val}`, line: null, side: team, gradeable: true, period, value: val });
  }

  // ---- correct score, e.g. "2-1", "2:1" ----
  const cs = s.match(/^([0-9]{1,2})\s*[-:]\s*([0-9]{1,2})$/);
  if (cs) return wp({ marketKey: "correct_score", label: `Correct score ${cs[1]}-${cs[2]}`, line: null, side: null, gradeable: true, period, value: `${cs[1]}-${cs[2]}` });
  if (/^correct score$/.test(s)) return wp({ marketKey: "correct_score", label: "Correct score", line: null, side: null, gradeable: true, period, needsValue: SCORE });

  // ---- Asian handicap (2-way, signed line): "home +0.5", "away -0.5", "home -1.5",
  //      "home (+0.5)", "home ah -1". Requires a sign or an AH/handicap keyword. ----
  const ah = s.match(/^(?:asian\s*)?(?:handicap\s*)?(home|away|1|2)\s*\(?\s*([+\-]?[0-9]+(?:\.[0-9]+)?)\s*\)?\s*(?:ah|asian|handicap)?$/);
  if (ah && (/[+\-]/.test(ah[2]) || /\b(ah|asian|handicap)\b/.test(s))) {
    const team = ah[1] === "1" || ah[1] === "home" ? "home" : "away";
    const line = Number(ah[2]);
    const signed = line >= 0 ? `+${line}` : `${line}`;
    return wp({ marketKey: "handicap", label: `${cap(team)} (${signed})`, line, side: team, gradeable: true, period, value: `${team} ${signed}` });
  }

  // ---- Handicap (European 3-way): pick Home/Draw/Away with a scoreline head-start "N:M",
  //      e.g. "home 1:0", "0:2 away", "draw 0:1", "handicap (0:1)". A bare "N:M" stays a
  //      correct-score (handled above); a side/keyword makes it a handicap. Overtime excluded. ----
  const euNum = s.match(/(\d+)\s*:\s*(\d+)/);
  if (euNum) {
    const rest = s.replace(/\d+\s*:\s*\d+/, " ").replace(/[()]|handicap|hcap|hcp/g, " ").replace(/\s+/g, " ").trim();
    const picked = /\b(home|1)\b/.test(rest) ? "home" : /\b(away|2)\b/.test(rest) ? "away" : /\b(draw|x)\b/.test(rest) ? "draw" : null;
    if (picked || /handicap|hcap|hcp/.test(s) || s.includes("(")) {
      const hy = euNum[1], ay = euNum[2];
      if (picked) return wp({ marketKey: "handicap_eu", label: `${cap(picked)} (${hy}:${ay})`, line: null, side: picked, gradeable: true, period, value: `${hy}:${ay}` });
      return wp({
        marketKey: "handicap_eu", label: `Handicap ${hy}:${ay}`, line: null, side: null, gradeable: true, period,
        value: `${hy}:${ay}`, needsValue: { kind: "text", label: "Home, Draw or Away?", placeholder: "home / draw / away" }, valueTarget: "side",
      });
    }
  }

  // ---- winning margin, e.g. "home by 2", "winning margin 2" ----
  const margin = s.match(/^(?:winning margin|margin)\s*(home|away)?\s*([0-9])$/) || s.match(/^(home|away)\s*by\s*([0-9])$/);
  if (margin) {
    const team = margin[1] || "";
    return wp({ marketKey: "winning_margin", label: `Winning margin ${team ? cap(team) + " " : ""}${margin[2]}`, line: null, side: team || null, gradeable: true, period, value: `${team} ${margin[2]}`.trim() });
  }

  // ---- bare market names that REQUIRE a value → recognise + show the input box.
  // (the value is stored on the ticket and the engine grades against it) ----
  const bare: Record<string, { key: string; label: string; side?: string; spec: BetValueSpec }> = {
    "goal range": { key: "goal_range", label: "Goal range", spec: RANGE },
    "goals range": { key: "goal_range", label: "Goal range", spec: RANGE },
    "goal bounds": { key: "goal_range", label: "Goal range", spec: RANGE },
    "multigoals": { key: "goal_range", label: "Multigoals", spec: RANGE },
    "multi goals": { key: "goal_range", label: "Multigoals", spec: RANGE },
    "home goal range": { key: "home_goal_range", label: "Home goal range", side: "home", spec: RANGE },
    "home goals range": { key: "home_goal_range", label: "Home goal range", side: "home", spec: RANGE },
    "home multigoals": { key: "home_goal_range", label: "Home multigoals", side: "home", spec: RANGE },
    "away goal range": { key: "goal_range", label: "Away goal range", side: "away", spec: RANGE },
    "away goals range": { key: "goal_range", label: "Away goal range", side: "away", spec: RANGE },
    "away multigoals": { key: "goal_range", label: "Away multigoals", side: "away", spec: RANGE },
    "correct score": { key: "correct_score", label: "Correct score", spec: SCORE },
    "winning margin": { key: "winning_margin", label: "Winning margin", spec: { kind: "text", label: "Which margin?", placeholder: "e.g. Home 2, Away 1, or 2" } },
    "margin": { key: "winning_margin", label: "Winning margin", spec: { kind: "text", label: "Which margin?", placeholder: "e.g. Home 2, Away 1, or 2" } },
  };
  if (bare[s]) {
    const b = bare[s];
    return wp({ marketKey: b.key, label: b.label, line: null, side: b.side ?? null, period, gradeable: true, needsValue: b.spec });
  }

  // ---- exact-phrase alias ----
  if (ALIASES[s]) return wp({ ...ALIASES[s] });

  // ---- player markets — capture the name, else prompt for it ----
  for (const p of PLAYER_PATTERNS) {
    const hit = s.match(p.re);
    if (hit) {
      const name = playerName(s, hit[0]);
      const bareStat = !name && /^(shots on target|shots on goal|shots|saves|fouls|offsides|passes|assists?)$/.test(s);
      if (bareStat) break; // a bare stat word with no name is a MATCH market, handled above
      const label = name ? `${p.label} — ${name}` : p.label;
      return wp({ marketKey: p.key, label, line: null, side: null, gradeable: p.gradeable, period, value: name, needsValue: PLAYER });
    }
  }

  return null;
}

// the value a gradeable market still needs from the user (null = self-contained)
export function valueSpecFor(key: string): BetValueSpec | null {
  if (key.startsWith("player_") || key.endsWith("goalscorer")) return PLAYER;
  if (key === "correct_score") return SCORE;
  if (key === "goal_range" || key === "home_goal_range") return RANGE;
  if (key === "winning_margin") return { kind: "text", label: "Which margin?", placeholder: "e.g. Home 2, Away 1, or 2" };
  if (key === "handicap_eu") return { kind: "text", label: "Home, Draw or Away?", placeholder: "home / draw / away" };
  return null;
}

// what the Haiku classifier (classify-bet edge fn) returns
export type Classification = {
  market_key: string;
  side?: string | null;
  line?: number | null;
  period?: Period;
  value?: string | null;
};

// turn a classification into the same shape recognizeBet produces, so the AI
// fallback flows through exactly the same add/track/grade path as typed bets
export function recognizedFromClassification(text: string, c: Classification): RecognizedBet {
  const gradeable = c.market_key !== "custom";
  const spec = gradeable ? valueSpecFor(c.market_key) : null;
  // handicap_eu needs the Home/Draw/Away pick (its "side"); the rest need bet_value
  const filled = c.market_key === "handicap_eu" ? !!c.side : !!(c.value && c.value.trim());
  return {
    marketKey: c.market_key,
    label: cap(text.trim()),
    line: c.line ?? null,
    side: c.side ?? null,
    period: c.period ?? "ft",
    gradeable,
    value: c.value ?? null,
    needsValue: spec && !filled ? spec : null,
    valueTarget: c.market_key === "handicap_eu" ? "side" : "bet_value",
  };
}
