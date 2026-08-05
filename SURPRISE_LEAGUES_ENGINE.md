# Surprise-me leagues — engine spec

How the `run-strategies` edge function must handle agents whose leagues are set to
**Surprise** mode. Surprise is a *mode*, not a frozen pick: the league pool re-rolls
every run; everything else (market, outcome, selectivity, cap, schedule) stays constant.

Builder side is done (see `src/components/StrategyBuilder.tsx`). This doc covers the two
pieces that live outside the repo: the **schema** and the **edge function**.

---

## 1. Schema

Add one column to `strategies` (also staged as `supabase/migrations/20260804120000_add_league_mode.sql`):

```sql
alter table public.strategies
  add column if not exists league_mode text not null default 'fixed'
    check (league_mode in ('fixed', 'surprise', 'all'));

-- backfill existing rows: empty league_ids historically meant "all" (pro_max), else "fixed"
update public.strategies
  set league_mode = case
    when league_ids is null or array_length(league_ids, 1) is null then 'all'
    else 'fixed'
  end
  where league_mode = 'fixed';  -- only touch the default-filled rows
```

Semantics of the three modes:

| `league_mode` | `league_ids`        | engine behaviour                                    |
|---------------|---------------------|-----------------------------------------------------|
| `fixed`       | non-empty           | hunt exactly these leagues (today's behaviour)      |
| `all`         | `[]`                | scan every competition (Pro Max only)               |
| `surprise`    | `[]` (not persisted)| **re-roll a random in-window subset every run**     |

The builder never writes frozen `league_ids` for surprise agents, so the engine must
treat an empty array under `surprise` as "sample now", NOT "scan all".

---

## 2. Edge function — `run-strategies`

This is a server-side port of `surpriseLeagues()` in `StrategyBuilder.tsx` (the client
already proves the algorithm). Insert it into the per-strategy run loop, immediately
**after** you know the target day but **before** you query fixtures/prices.

### 2a. Resolve the league set for the run

```ts
// pseudo-code inside the per-strategy loop
async function resolveLeagueIds(strategy, targetDay): Promise<number[] | "all"> {
  if (strategy.league_mode === "all") return "all";
  if (strategy.league_mode === "fixed") return strategy.league_ids ?? [];

  // ---- surprise: re-roll from leagues that actually play in the target window ----
  const window = targetWindow(strategy.target_day, strategy.timezone); // {from, to}

  // leagues with at least one fixture in the window (same source the builder's
  // activeLeagueIds query uses: fixtures scoped to [from, to])
  const active: number[] = await distinctLeagueIdsWithFixtures(window);
  if (!active.length) return []; // no games -> run yields nothing, log & skip

  // cap by the owner's plan, mirror the builder's "surprising 4–8"
  const maxLeagues = await planMaxLeagues(strategy.user_id);
  const count = Math.min(maxLeagues, 4 + Math.floor(Math.random() * 5));

  return sampleWithoutReplacement(active, count); // Fisher–Yates, take `count`
}
```

Notes / must-match-the-client details:

- **Sample from day-eligible leagues only.** The pool is leagues with a fixture in the
  same target window the builder shows — never a static list of all leagues. This is what
  prevents empty/thin surprise runs.
- **Count = `min(maxLeagues, 4 + rand(0..4))`** → 4–8, capped by plan. Identical to the
  client so surprise and manual runs feel equivalent. `plan_limits.max_leagues` is the cap.
- The client prefers *preloaded/visible* leagues when rolling its preview; the engine has
  no such notion — sample straight from the full active set. (The visible-preference is
  purely a UI nicety and should NOT be reproduced server-side, or surprise picks would
  skew toward the handful of preloaded leagues.)
- **Fresh RNG per run.** Do not seed from `strategy.id` or you defeat the re-roll — two
  runs of the same agent must be able to produce different leagues.

### 2b. Apply the rest of the config unchanged

Once `resolveLeagueIds` returns, feed the result into the existing fixture/price query
exactly as a `fixed` list would be — `"all"` means "no league filter". Market, side, line,
period, `bet_value`, `selectivity` / `min_edge`, `max_per_prediction` are untouched. Only
the `WHERE league_id IN (...)` clause differs between runs.

### 2c. Record the roll (transparency)

Because the leagues change every run, persist which ones were rolled **per prediction**, so
the app + Telegram delivery can show "🎲 rolled: EPL, Eredivisie, Primeira…". Options:

- add `rolled_league_ids int[]` to whatever per-run/prediction row the engine already
  writes (predictions/tickets table), or
- store it on the run record keyed by `strategy_id + run_at`.

The delivery templates should surface it whenever `league_mode = 'surprise'`; for `fixed`
and `all` it's redundant (the leagues are known up front) and can be omitted.

---

## 3. Checklist

- [ ] `alter table` + backfill applied (section 1)
- [ ] `run-strategies` reads `league_mode`, branches on `surprise`
- [ ] surprise samples from **target-window** active leagues, count `min(maxLeagues, 4–8)`
- [ ] fresh RNG each run (no strategy-id seeding)
- [ ] rolled leagues recorded per prediction + surfaced in app/Telegram delivery
- [ ] verify a capped-plan surprise agent (empty `league_ids`) no longer trips the
      "scan every competition is a Pro Max perk" path anywhere server-side
