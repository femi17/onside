# Glossary march — coverage worklist

Marching `Complete_Betting_Markets_Glossary.md` top-to-bottom, wiring every market end-to-end
(recognition → markets row → tracker display → poll grade), one at a time, verified before moving on.

**4 touchpoints per market:** `src/lib/betCatalog.ts` (recognizeBet + BET_CATALOG), `markets` table row,
`src/components/TrackerBoard.tsx` (+ `src/lib/ticket.ts` betSignal/liveTrack/readouts), poll `grade()`.
Poll deploys are batched per cluster. See [[glossary-market-coverage]], [[onside-settlement-engine]].

Legend: ✓ done · → todo (this pass) · ✗ manual-only (data not available to auto-grade)

## Frontier
**✓ sub_to_score — NEW (2026-08-24, poll v59).** "Substitute to score" yes/no (owner request).
All 4 touchpoints: recogniser ("sub(stitute)s to score" + no-variants, matched BEFORE the player
patterns), catalog row (Player group), markets row (kind=player), poll grade case. Grading: subst
events collected fresh at settlement keeping BOTH names per pair (provider in/out mapping
untrusted) — scorer matching either name at goal-min >= sub-min = the entering player; own goals
excluded. Zero subst events on a finished game -> null (pending/manual, thin feeds omit subs);
fromStore sweep passes subs=null (stored timeline has no subs, can never mis-grade). NOT on the
agent shelf — engine can't price player markets.

**✓ 1st/2nd-HALF TWIN sweep — DONE (2026-08-03).** Verified end-to-end, no meaningful gaps:
- RECOGNITION: `pullPeriod` (betCatalog.ts:265) strips "1st half"/"first half"/"1h" → period 1h,
  "2nd half"/"second half"/"2h" → 2h. `const wp = withPeriod(r, period)` (l.464) prepends a
  "1st/2nd half — " label + sets `period`. Every gradeable branch after l.463 wraps in `wp(...)`, incl.
  the exact-phrase alias path (l.648 `wp({...ALIASES[s]})`). So the common twins all inherit the half:
  1X2, DC (all), DNB, home/away-no-bet, O/U (total + team), GG/NG, correct score, both handicaps
  (AH + EU), odd/even (total + team), exact goals, goal range/multigoals, winning margin.
- ENGINE: `grade()` reads `const [h,a]=pg(f,period)` (poll.ts:244) so `h/a/tot/res` are the picked
  period; `needsEv` forces the events fetch for any period bet so h1h/h2h are populated. Every twin
  case above grades off h/a/tot/res. Fixed `winning_margin` to use h/a (was f.hg/f.ag) — STAGED, ships
  with next poll deploy (niche; not worth a standalone deploy).
- Known niche exceptions (accepted, documented): a handful of pre-l.463 FT-special branches
  (btts_2plus, teams_to_score) match on `raw` and would return ft for a half-prefixed input; these
  half-twins are rare and not offered by SportyBet per-half. htft/first-goal-interval/result-by-minute/
  highest-scoring-half/htft_cs are inherently whole-match — no half twin exists.

**Surveyed glossary lines 471–968 (2026-08-03).** Findings:
- 471–535 player shots/saves/fouls/headers/free-kicks → ✗ MANUAL (no per-player stat feed). Documented.
- 545–705 "1X2 from 1 to N minute" (every N: 5,10,15…85) → ✓ already covered by `result_by_minute`
  (value=N); recogniser matches the "from 1 to N minute" phrasing. Goal-interval 10/15-min → ✓ first_goal_interval.
- 747–839 bookings family: O/U, 1X2, points, home/away totals, handicap, exact, + all their 1st-half
  twins → ✓ (cards are timed → cardCount/bookingPoints are period-aware). Two NEW markets wired this batch.
- 841–859 player sent-off / to-be-carded → ✓ already (player_sent_off / player_card).
- 861–949 corners aggregate (O/U, 1X2, handicap, home total, range, home range, odd/even) → ✓ (per-team totals).
- 951–968 **1st/2nd-Half corner markets → ✓ NOW GRADEABLE (poll v40)** — see corner-period section below.

**✓ NEW this batch (poll v39):**
- `first_booking` (side home/none/away) — which team gets the FIRST card. Cards ARE timed (min in events),
  so fully auto-grades incl. 1st/2nd-half twins via `firstBookingSide(cards, period)`. All 4 touchpoints done
  (recogniser "1st booking home/none/away", catalog, markets row kind=cards, grade case).
- `cards_1x2` recogniser ADDED — grade case + market row already existed; recognition was the missing link
  ("bookings 1X2 home", period-aware). Corners-1X2 stays matched first so it never steals a cards input.

**✓ CORNER PERIODS + total O/U (poll v40, 2026-08-03).** User insight (verified live: a game at HT
returned corners 1–1, a mid-2H game 3–2): the `statistics` corner totals are LIVE + CUMULATIVE, so the
value AT half-time = the 1st-half corners. Implementation:
- `fixture_stats.corners_home_ht/away_ht` (new cols). Poll snapshots them in the corner-stats loop when
  `status === "HT"` (only for fixtures that HAVE a corner bet; stats poll runs every 20s so HT is always caught).
- `pcorners(f, period)`: 1h → HT snapshot; 2h → (FT total − HT snapshot); ft → full totals. Returns
  [null,null] if the HT snapshot is missing (bet placed after HT) → market stays pending (manual).
- ALL corner grade cases now period-aware via `pcorners` (handicap/1X2/home+away O/U/range/odd-even).
- NEW `corners_ou` market: total corners over/under a line, period-aware. Also fixes a pre-existing gap —
  "under N corners" wasn't gradeable even at FT (only `over_8_5_corners` = over-only). FT "over" still
  routes to `over_8_5_corners` (keeps its live-settle path); FT under + any half → `corners_ou`.
- Corner markets excluded from the `needsEv` events guard (they need stats, not the events feed).
**✓ HALF-TIME SETTLEMENT (poll v41, 2026-08-03).** Any bet with `period === "1h"` is fully decided once
the half ends, so it now settles AT half-time (not FT) — applies to ALL 1st-half markets (1X2, O/U, GG/NG,
corners, bookings, correct score, etc.), shown as won/lost in the tracker at HT.
- `settleHalfTime(fixtureId)`: grades only period=1h pending/live rows (tickets/agent_picks/deliveries)
  via the same buildFacts+grade path. Idempotent — settled rows drop out of the query, so re-running each
  HT poll is a no-op (≈1 buildFacts per fixture, then nothing).
- Runs in `poll()` AFTER the corner-stats loop (so the HT corner snapshot is fresh this poll), for each
  fixture at status HT that has active bets. Response gained `htSettled` counter.
- At HT: hg/ag = the 1st-half score (ft_home still null), h1h/h1a from events, corners from the HT snapshot.
  2nd-half / full-match bets keep waiting for FT as before.

**✓ STATISTICS TEAM MARKETS (poll v42, 2026-08-03).** shots / shots-on-target / offsides / fouls, as
1X2 + total O/U + home/away O/U (16 markets). Graded from per-team `fixtures/statistics` totals, same as
corners. VERIFIED the exact API type strings on a real game (LA Galaxy: Total Shots 18-18, Shots on Goal
9-4, Offsides 1-2, Fouls 11-13).
- `parseTeamStats()` -> name->[home,away] map for shots/sot/offsides/fouls (NOT stored in fixture_stats,
  so no new columns; buildFacts fetches fresh at settlement). `Facts.teamStats`.
- `STAT_MARKETS` set (16 keys). grade() handles them generically via one regex
  `^(?:(home|away)_)?(shots|sot|offsides|fouls)_(1x2|ou)$` BEFORE the switch: 1X2 = outcome(h,a); O/U =
  total (or single team for home_/away_); null when the stat isn't reported (-> pending/manual).
- FT ONLY this batch (no HT snapshot for these stats yet). Recognition (betCatalog): stat 1X2 branch +
  routed the teamStat/`so` O/U branches to `{stat}_ou`/`{team}_{stat}_ou` when period==="ft"; STAT_KEY maps
  "shots on target"->sot etc. Catalog "Stats" group + 16 markets rows.
- Data availability is spotty (many lower leagues report no statistics) -> those stay pending, like corners.

**Survey gaps still TODO (next batches):**
- Home/Away Corner Range (`home_corner_range`/`away_corner_range`) — FT line 931 + 1st-half "Home Exact
  Corners" (range values) line 1009. Small: gradeRange on pcorners per-team, period-aware.
- Match Penalty Scored (penalty GOAL, not just awarded) — `goals.some(kind==="pen")`.
- Team Assists (home/away assist count from events), Match Shots Outside Box ("Shots outsidebox" stat),
  2nd-half shots on target (needs per-stat HT snapshot like corners) — lower priority.
- 1st Goal & 1X2 combo (first_team_to_score & result) — niche 2-leg.
- HT/FT & O/U and HT/FT & 1st-half O/U and HT/FT & Exact Goals — 3-leg combos, still DEFERRED.

**✓ GLOSSARY SURVEY COMPLETE — reached line 2248 (the end), 2026-08-03.**

**✓ NEW (poll v43):**
- `goals_ou_by_minute` — Total Goals O/U up to minute N. THIS COVERS THE ENTIRE GLOSSARY TAIL
  (~lines 1689-2248: "Total Goals O/U from 1 to N minute", N=5..85, lines 0.5-4.5). Graded via
  `goalsBy(f.goals, N) vs line` (helper already existed). value=N, side over/under. FT-settled
  (result known once elapsed>N; early-at-minute settlement is a possible future nicety).
- `home_corner_range` / `away_corner_range` — per-team corner range (FT line 931 + 1st-half "Home
  Exact Corners" 1009). Period-aware via pcorners + gradeRange. Extends the corner family.
- `penalty_scored` — a goal from a penalty (`goals.some(kind==="pen")`), distinct from `penalty_match`
  (awarded). Split the aliases so "penalty scored/goal" -> penalty_scored, "penalty (awarded)" -> penalty_match.

**Survey 1327-2248 — mostly already covered:**
- Half-specific combos (2nd-half 1X2&O/U, 1X2&GG, DC&GG, DC&Total; HT DC&Total; 1st-half DC&GG) all grade
  through the existing period-combo mechanism (result_ou/result_btts/dc_ou/dc_btts thread `period`). ✓
- Multigoals / Home Multigoals = goal_range / home_goal_range ✓. Correct Score [0:0] = correct_score ✓.
- Team/Match Cards incl. 1st/2nd half = cards_ou/home_cards_ou with period ✓.

**Remaining NOT wired (documented; gradeable-but-deferred or manual):**
- "result OR condition" family (Home/Draw OR O/U, OR GG, OR Any Clean Sheet — 1417-1485): gradeable
  (all legs from goals) but needs a new "or"-combo recogniser carefully disambiguated from Double Chance
  ("home or draw"). NEXT concrete batch if continuing.
- Multiscores (grouped scorelines, 1521+), 1st-Goal&1X2, HT/FT 3-leg combos, 1st-Half-Result-OR-Match-Result:
  niche combos, deferred (need multi-value encoding).
- "Most X" player head-to-head (goals/shots/assists/fouls/saves), player passes/fouls-won, 2nd-half
  shots-on-target, shots-outside-box, team assists: ✗ mostly MANUAL (no per-player feed) or need per-stat
  HT snapshots. Lower priority.

**✓ OR-COMBO FAMILY (poll v44) — glossary march COMPLETE.**
- `result_or_ou` / `result_or_btts` / `result_or_cs` — "1X2 (or DC) OR condition", Yes wins if EITHER leg
  hits (side = result leg, home/draw/away or 1x/x2/12). `resultLeg()` helper + 3 grade cases (goals-based,
  no events). Recogniser fires on "or" ONLY when a result token is paired with a CONDITION (over/under,
  GG/NG, clean sheet) — so plain "home or draw" stays Double Chance. FT only.

**GLOSSARY MARCH DONE (2026-08-03).** Whole SportyBet glossary surveyed top-to-bottom (lines 1-2248) and
every auto-gradeable market is wired end-to-end (recognition + markets row + tracker + poll grade).
Poll deployed through: **v44** (staged == deployed).

Genuinely-not-auto items (documented, need external data or multi-field encoding, low priority):
- Player head-to-head "Most X" (goals/shots/assists/fouls/saves), per-player shots/saves/fouls/passes,
  to-score-a-header/free-kick → MANUAL (no per-player stat feed from API-Football).
- Multiscores (grouped scorelines), HT/FT 3-leg combos, 1st-Goal&1X2, 1st-Half-Result-OR-Match-Result,
  DC & specific-half-GG (mixed-period legs) → niche combos needing multi-value encoding; deferred.
- 2nd-half shots-on-target, shots-outside-box, team assists → need per-stat HT snapshots / extra parsing.

NEXT FOCUS: the AGENT (3rd core feature). See [[agent-strategy-vision]] and [[resume-agent-deepening]].

- ✗ 1st Corner / Last Corner — DROPPED (user decision 2026-08-03). Untimed: API-Football (verified across
  Chile + MLS Portland + MLS LA Galaxy) returns corners ONLY as a cumulative per-team TOTAL — the events
  feed carries Card/Goal/subst/VAR, never Corner, and `?type=corner` is empty even for MLS. No minute/order
  → "which team took 1st/last" is ungradeable, so it's NOT offered. Recognition + catalog + market rows
  removed; the dormant poll grade cases (v38) never fire without the key. Aggregate corner markets below
  stay fully automatic (they need only totals).

- ✓ COMBOS: `result_btts` (1X2 & GG/NG), `result_ou` (1X2 & O/U), `dc_btts`, `dc_ou`, `ou_btts` — grade =
  W(legA && legB), word-based "&/and" recogniser (never bare 1/2/x so O/U digits aren't misread), period twins
  via `period`. poll v37.

- ✓ CORNERS family: `corner_handicap` (like goal handicap on corner counts), `corners_1x2`,
  `home/away_corners_ou`, `corner_range`, `corners_odd_even` — all graded from per-team corner totals
  (poll v36). Engine change: `Facts.corners_home/away`, `CORNER_MARKETS` triggers the live stats fetch
  for ALL corner markets (not just over_8_5) + a fresh statistics fetch in `buildFacts` at settlement.

- ✗ Player shots / shots on goal / on target / left-foot / saves / offsides / fouls / header / free-kick
  → MANUAL (API-Football events have no per-player shot/save/foul/goal-type detail). Fall to custom.
- ✓ To Score and Assist (player_score_assist), Player Sent Off (player_sent_off), Player Carded (player_card) — already done.

## Status (glossary order)
- ✓ 1X2, 1X2-1UP, 1X2-2UP, 1X2-Never Down
- ✓ Over/Under, Over/Under-Early Goals
- ✓ Double Chance, Double Chance-1UP
- ✓ Handicap 0:1 (handicap_eu), Asian Handicap 0.5 (handicap)
- ✓ Home Over/Under, Away Over/Under (home/away_goals_ou)
- ✓ GG/NG (btts), GG/NG 2+ (btts_2plus)
- ✓ Any/Home/Away Team To Score 2/3 in a Row (goals_in_row family, 6)
- ✓ Any/Home/Away to lead by 1/2/3 (lead_by family, 9)
- ✓ Goal Bounds / -Home / -Away (= goal_range / home_goal_range / goal_range side=away)
- ✓ Excluded Number of Goals / -Home / -Away (excluded_goals family — poll v32)
- ✓ Draw No Bet (dnb), Correct Score, Half Time/Full Time (htft)
- → Half Time/Full Time Correct Score (htft_cs — NEW)
- ✓ Both Halves Over/Under 1.5 (both_halves_ou)
- ✓ Home/Away Team to Score In Both Halves
- ✓ Odd/Even, Home/Away Team Odd/Even
- → Goal Bounds - 1st Half, Excluded Number of Goals - First Half (period twins)
- ✓ Home/Away Team To Win From Behind
- → Half-time Home/Away Total Goals Odd/Even (period twins of odd/even)
- ✓ Last Goal (last_team_to_score), Home/Away No Bet, Winning Margin, Exact Goals, Goal Range
- → Home Team Goals (exact home goals? — verify vs home_goal_range)
- → Teams to Score (how many teams score: 0/1/2 — NEW)
- ✓ Home Team Clean Sheet, Home Win Both/Either Half, Win to Nil, Highest Scoring Half
- ✓ Home/Away Team Highest Scoring Half (home/away_highest_scoring_half — poll v33)
- ✓ Half Time/Full Time Correct Score (htft_cs — poll v33)
- ✓ Teams to Score (teams_to_score — user types the value: Both/Home/Away/None; recognizer maps each — poll v33)
- ✓ Home Team Goals (= home_goal_range exact) · Half-time Home/Away Odd/Even (= odd_even period=1h)
- ✓ Excluded Number of Goals / -Home / -Away (excluded_goals family — poll v32)
- ✓ Bookings Handicap · Home/Away Exact Bookings (cards_handicap, home/away_exact_cards — poll v34)
- ✓ When will the 1st goal be scored (first_goal_interval, 10 & 15-min buckets — poll v35)
- ✓ 1X2 from 1 to N minute / 10-minutes 1X2 (result_by_minute, value=N — poll v35)
- ✓ BTTS Both Halves, No Draw BTTS
- ✓ Last/Anytime Goalscorer, Player Not to Score, Player assists, Player goals
- ✗ Player shots / shots on goal / saves / passes / fouls / offsides (no per-player stat feed)

## Below line ~471 — not yet surveyed
Continue reading the glossary from line 471 downward and extend this list as each section is reached.
Big remaining families to expect: corners (1st/last/range/handicap/1X2/O-U/odd-even), bookings/cards
(1X2/O-U/points/exact/1st booking), minute-interval 1X2 (1–5', 1–10'…, likely ✗ manual), combos
(1X2 & GG/NG, 1X2 & O/U 1.5, DC & GG/NG…), and the full 1st-half / 2nd-half twin sets.
