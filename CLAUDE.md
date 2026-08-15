# Onside — working rules for AI sessions

## Change-safety protocol (the code-breaker guard)

The #1 failure mode here: a "fix" to one thing silently changes behaviour that was working.
Settlement and money paths are live — users see every flip. Follow this before editing:

1. **Bug vs rule change — decide which it is first.**
   - *Bug* = the code contradicts its own stated intent (a comment, a market rule, a dupe write).
     Fix directly, ship, verify.
   - *Rule change* = the code does what it was designed to do, but the domain semantics are being
     re-ruled (e.g. how own goals count, what a traffic-light colour means). These are the owner's
     calls: propose the rule as 2–3 concrete examples WITH outcomes and get a yes BEFORE editing.
     Never generalise a rule from a single match/incident.

2. **State the blast radius before touching shared logic.** Settlement helpers are consumed from
   multiple places (DB trigger + row guard + poll FT grading + tracker display + manual settle).
   List the consumers and how each one's behaviour changes. If you can't list them, grep first.

3. **Regression-replay settlement changes.** Before deploying a grading/semantics change, run
   old-vs-new over historical settled bets (SQL over `deliveries`/`tickets` + `fixtures.events`)
   and report how many past results WOULD flip. Ship only after that diff is acknowledged.

4. **Data repair ≠ logic change.** One bad game (broken feed, mis-sequenced events) → repair the
   rows for that game. Only change logic when the rule is confirmed wrong in general.

5. **One change per commit/deploy, verified.** Edge functions: deploy from the repo copy via
   `supabase functions deploy <fn> --project-ref mbrtpetpgsggnlcazhqd --use-api`, then verify
   (download round-trip byte-check + logs all-200). Never paste large files through MCP deploy.

6. **Every ticket's `current_value` has exactly ONE writer per poll cycle.** A second writer
   causes value-flapping, and the build-up push trigger turns any flap into notification spam.

7. **The provider's event feed is not the truth.** Event side/minute/score strings for goals
   (especially own goals) are unreliable; the `fixtures` scoreboard totals are the arbiter, and
   the owner watching the game outranks both.

## Domain rules already ruled by the owner (do not re-litigate)

- Standard markets settle on the 90' score; ET only affects to-qualify markets.
- Own goals: credited to the opponent of the scorer on the scoreboard (all goal-count markets).
  For "N in a row" streaks: an og BREAKS the opponent's streak, never EXTENDS the credited team's.
- "Team total" ≠ "match total": a named-team over/under grades on that team's goals only.
- Agent pick confidence dots are green/amber/orange, never red.
- The same bet MAY be a leg in multiple different accumulators.
- Naira (₦) is the default currency; slip-parse currency guesses can be wrong.
- Notifications: tracking a pick = opting into its game alerts; agent toggles govern ONLY
  un-tracked agent games. Landed/missed push: tracked pick → results, untracked → agent_games.
- Deleting an agent sweeps its deliveries AND its standalone tracker tickets
  (tickets.strategy_id); acca legs survive with the agent link nulled.

## Infra pointers

- Full infra map: `ONSIDE_INFRA.md` (edge functions, cron, secrets, tables).
- The backend engine lives in Supabase edge functions (`poll`, `run-strategies`), NOT in `src/`.
  Synced copies: `supabase/functions/poll/index.ts`, `supabase/functions/run-strategies/index.ts`.
- Migrations mirror to `supabase/migrations/` whenever applied remotely.
