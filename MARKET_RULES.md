# Market rules & farming-integration practice

**Standing practice (read this on a fresh session before touching predictions).**
Onside gates every bet outcome with **owner-ruled, backtested rules** enforced in the engine
(`supabase/functions/run-strategies/index.ts`, `scoreAndRank`). Rules are added as **independent
OR paths** ("the way we add them independently"): a pick ships if it passes **any one** rule for its
market. A game flagged by more than one rule collapses to a single pick via the per-agent
`UNIQUE(strategy_id, fixture_id)` delivery guard. A user's own rule only ADDS selectivity — it never
lowers a mandatory floor.

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

## Roadmap: automate it (the cron the owner asked for)
Today this is a manual practice (sweep + wire each time). The end state is a **Supabase cron** that keeps
a `market_rules` table of validated independent rules per outcome (refreshed nightly from the labs with
a strict bar: min n, min holdout hit, Wilson LB, calibration-vs-live check), and the engine READS that
table at scoring time instead of hardcoded `*Ok` gates. Then **new and existing agents/accas auto-
inherit the best rules and auto-update** as farming improves — no per-agent editing. This is a real
refactor of the hardcoded gates into a data-driven system; it touches live selection, so it needs a
replay + owner sign-off before shipping. Until then, follow the manual practice above.

_Last integration sweep: 2026-09-10 (DC 1X + home-to-score cross-signals). Keep this file updated when
rules change._
