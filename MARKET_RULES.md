# Market rules & farming-integration practice

**Standing practice (read this on a fresh session before touching predictions).**
Onside gates every bet outcome with **owner-ruled, backtested rules** enforced in the engine
(`supabase/functions/run-strategies/index.ts`, `scoreAndRank`). Rules are added as **independent
OR paths** ("the way we add them independently"): a pick ships if it passes **any one** rule for its
market. A game flagged by more than one rule collapses to a single pick via the per-agent
`UNIQUE(strategy_id, fixture_id)` delivery guard. A user's own rule only ADDS selectivity — it never
lowers a mandatory floor.

## COMPULSORY shown-% floors (owner-ruled — never let a % slip below the gate)
`MIN_SHOWN` in scoreAndRank is the authoritative floor, checked LAST in all three paths (priced,
mix/set, no-odds) after every selection rule — signals/autoPass/OR-paths can SELECT a game but can
NEVER ship it below its gate: **DC 1X/X2/12 ≥0.80 · 1UP home/away ≥0.85 · Under 3.5 ≥0.73 ·
Away-to-score ≥0.75** (Over 0.5 is per-agent confidence_floor = 0.99). Any new %-gated market MUST be
added to MIN_SHOWN. This overrides farmed signals — e.g. away-score→1X (78%) only ships when the DC 1X
shown % is also ≥0.80.

## The practice: farm → find strong un-integrated signals → integrate
1. Sweep the farming tables (below) for cells that perform well but aren't wired into the engine yet.
2. Bar to integrate: **hit ≥ ~78%** on a **meaningful sample** (n ≥ ~300 for signals, holdout ≥ 200
   for labs), Wilson LB healthy, and it must **add value** (not duplicate an existing rule or bypass a
   floor the owner set).
3. Add it as an independent OR path on the outcome it predicts (a `*Ok` helper or an inline check in
   both the single-market path and the mix/set path). Deploy from disk (`supabase functions deploy
   run-strategies --project-ref mbrtpetpgsggnlcazhqd --use-api`), verify logs 200, commit to main.
4. Never overclaim: display the bet's own probability; when the engine can't price a market, stamp a
   calibrated flat value (never the signal's %).

## Farming sources
- `rule_lab` — nightly grid of goal-market conditions over fixtures history (60-day holdout).
- `model_signal_lab` — cross-market model-signal farming. BOTH directions: `<sig>` = signal ≥ threshold,
  `<sig>_lte` = signal ≤ threshold (added 2026-09-10). `mine_model_signals()` nightly.
- `corner_lab` — nightly corner over/under backtest (caps ~mid-60s; nothing promoted yet).
- `proven_rules` — auto-refreshed best rule per market (picks + fixtures), shown as builder captions.
- Model-band learning + implicit screens (h2h veto, form veto, Guide, Shield) run on every pick always.

Quick sweep query (strong, non-native signal cells):
```sql
select signal_key, threshold, market_key, n, hit, wilson_lb
from public.model_signal_lab where n >= 300 and hit >= 80 order by wilson_lb desc limit 40;
```

## Integrated rules per outcome (current)
- **Over 0.5** — proven rule (blend ≥4.0, ~96%) as builder suggestion; owner's agent floored at shown ≥0.98. No mandatory engine gate (niche; only the owner bets it).
- **Over 1.5** (`over15Ok`) — blend ≥4.5 · OR (model Over 1.5 ≥0.85 AND blend ≥3.0) · OR BTTS New GG band 0.64–0.66.
- **Over 2.5** (`over25Ok`) — Over 0.5 model ≥0.98 · OR BTTS New GG band · OR blend ≥4.5.
- **Under 3.5** (`under35Ok`) — both teams' Over 1.5 odds ≥2.00 AND shown ≥0.73 (mandatory floor).
- **Home to score** (`homeScoreOk`) — (model home-score ≥0.85 AND home avg ≥1.5) · OR (blend ≥4.0 AND home avg ≥1.8) · OR home avg ≥2.0 · OR home-win ≥0.60 · OR away-score ≤0.70.
- **Away to score** (`awayScoreOk`) — [model away-score ≥0.85 OR blend ≥4.5 OR away wins ≥4] AND shown ≥0.75 (mandatory floor; do NOT add bypassing OR paths).
- **DC 1X** — model 1X shown ≥0.80 · OR away-score ≤0.70 · OR home-score ≥0.90.
- **DC X2** — model X2 shown ≥0.80.
- **DC 12** (`dc12Ok`) — home-win ≥0.70 · OR away-win ≥0.70 · OR blend ≥4.2.
- **BTTS** (`bttsOk`) — model BTTS in New GG band 0.64–0.65 (bets BTTS).
- **1UP home/away** — shown ≥0.85.
- **1st-half Under 1.5** — full-match Under 3.5 model ≥0.76.
- **1st-half Over 0.5** — full-match Over 1.5 model ≥0.85.
- **Goals-in-row 2 (yes)** — Over 0.5 model ≥0.99 → flat 0.85 (engine can't price it per-game).
- **Goals-in-row 3 (no)** — Under 3.5 model ≥0.76 → flat 0.80.
- **Home win / Away win** — farming only (~52% structural; no gate). **Corners** — farming only.

## Auto-integration (LIVE — owner-directed 2026-09-10, no manual prompting)
Qualifying farmed signals now integrate **themselves**:
- **`market_rules` table** holds validated cross-market rules per outcome (field/op/value + n/hit/wilson).
- **`refresh_market_rules()`** cron (`refresh-market-rules`, 03:45 UTC, after the farm refreshes) rebuilds
  it from `model_signal_lab` (both directions) with a STRICT bar: **hit ≥80, n ≥300, Wilson LB ≥0.75**,
  native/self pairs dropped, top 4 per market. WHITELIST of eligible markets only:
  over_1_5, over_2_5, home_to_score, double_chance_1x/x2/12, btts. Hard-floor markets (under_3_5,
  away_to_score) and weak ones (home_win, away_win, corners, under_2_5, over_3_5) are **excluded** so an
  auto-rule can never bypass a floor or ship a coin-flip.
- **Engine** loads `market_rules` (module-cached) and applies each as an EXTRA independent OR path via
  `autoPass(mk, cell)` inside `over25Ok/over15Ok/homeScoreOk/dc12Ok/bttsOk` and the DC 1X/X2 gates.
  **Additive-only / safe-by-construction**: it can only ADD qualifying paths, never remove a hardcoded
  floor. New strong signals appear automatically each night — no code change, no prompt.

To add a market to the auto-system: add it to the whitelist in `refresh_market_rules()` and add
`autoPass("<market>", cell)` to that market's gate. To change the bar, edit the thresholds in
`refresh_market_rules()`. `autoPass` only supports agg-derived signal fields (home/away win/score/draw,
btts, over25) — blend/form-based rules stay hardcoded.

_Last integration sweep: 2026-09-10 (DC 1X + home-to-score cross-signals). Keep this file updated when
rules change._
