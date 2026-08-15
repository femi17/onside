import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import RealtimeRefresh from "@/components/RealtimeRefresh";
import AgentBoard, { type AgentPick } from "@/components/AgentBoard";
import { type OnsideDouble, type LegDelivery } from "@/components/OnsideDoubleTracker";
import { canonicalMarket } from "@/lib/betCatalog";
import { lagosTodayStartISO } from "@/lib/ticket";

export default async function AgentPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  // Load by TIME WINDOW (start of yesterday, Lagos), not a blind row limit: at the Pro Max cap
  // (50 picks × up to 14 agents) a single midday batch used to push the overnight batches past a
  // fixed limit(200) — picks looked "wiped" from the feed although nothing was deleted. The high
  // limit stays only as a safety ceiling for the payload.
  const sinceIso = new Date(Date.parse(lagosTodayStartISO()) - 24 * 3600 * 1000).toISOString();
  const { data } = await supabase
    .from("deliveries")
    .select(
      "id, strategy_id, market_key, market_label, line, side, period, bet_value, result, settle_score, current_value, delivered_at, edge, model_prob, market_prob, tier, criteria, strategies(name), fixtures(id, home_team, away_team, kickoff_utc, status, elapsed, home_goals, away_goals, extra, updated_at, leagues(name, flag_url, tier), fixture_stats(momentum, corners_home, corners_away, corners_home_ht, corners_away_ht))"
    )
    .gte("delivered_at", sinceIso)
    .order("delivered_at", { ascending: false })
    .limit(1000);

  // Onside score — the SAME ranking build_onside_double uses, computed per pick at read time:
  // bookies' de-vigged % (+2 scoring market / −5 result market) + the agent's track-record nudge.
  // Odds-less picks (market_prob null) can't be scored on this axis and show unscored.
  const { data: aqRows } = await supabase.from("my_agent_quality").select("strategy_id, shrunk_rate");
  const shrunkBy = new Map((aqRows ?? []).map((r) => [r.strategy_id as string, Number(r.shrunk_rate ?? 0.5)]));
  const RESULT_MARKETS = new Set(["home_win", "away_win", "draw", "double_chance_1x", "double_chance_x2", "double_chance_12"]);
  const onsideScore = (r: Record<string, unknown>): number | null => {
    if (r.market_prob == null) return null;
    const adj = RESULT_MARKETS.has((r.market_key as string) ?? "") ? -0.05 : 0.02;
    const nudge = ((shrunkBy.get(r.strategy_id as string) ?? 0.5) - 0.5) * 0.2;
    return Math.round((Number(r.market_prob) + adj + nudge) * 1000) / 10;
  };

  // ---- 🛡️ Onside Guide — verify each pick against its agent's parsed rule using the SAME
  // last-5 form numbers the pick displays (criteria.reasons). The engine evaluates rules on its
  // own DB form window, which can disagree with the displayed API last-5 — so a pick can pass
  // the engine yet contradict the rule the user typed. The Guide re-checks the form-verifiable
  // conditions (goal averages / blends / wins / ppg — engine formulas mirrored exactly) and
  // fizzles out UNSETTLED picks that fail. Settled picks are never hidden (honest history).
  type GuideCond = { op: string; field: string; value: number; value2?: number };
  type Form5 = { w: number; d: number; l: number; gf: number; ga: number; n: number };
  const { data: ruleRows } = await supabase
    .from("strategies")
    .select("id, rule_parsed")
    .eq("status", "running")
    .not("rule_parsed", "is", null);
  const guideFilters = new Map<string, GuideCond[]>();
  for (const r of ruleRows ?? []) {
    const f = ((r.rule_parsed as { filters?: GuideCond[] } | null)?.filters ?? []).filter((c) => c?.field && c?.op);
    if (f.length) guideFilters.set(r.id as string, f);
  }
  const per = (f: Form5 | null) => (f && f.n ? (f.gf + f.ga) / f.n : null); // team blend (engine formula)
  const gfAvg = (f: Form5 | null) => (f && f.n ? f.gf / f.n : null);
  const ppg = (f: Form5 | null) => (f && f.n ? (3 * f.w + f.d) / f.n : null);
  const guideValue = (field: string, hf: Form5 | null, af: Form5 | null): number | null => {
    switch (field) {
      case "home_goals_avg": return gfAvg(hf);
      case "away_goals_avg": return gfAvg(af);
      case "home_goals_blend": return per(hf);
      case "away_goals_blend": return per(af);
      case "goals_blend": { const h = per(hf), a = per(af); return h != null && a != null ? (h + a) / 2 : null; }
      case "min_goals_blend": { const h = per(hf), a = per(af); return h != null && a != null ? Math.min(h, a) : null; }
      case "home_wins_last5": return hf?.w ?? null;
      case "away_wins_last5": return af?.w ?? null;
      case "home_form_ppg": return ppg(hf);
      case "away_form_ppg": return ppg(af);
      default: return null; // odds/model fields aren't displayed per-pick — not Guide-verifiable
    }
  };
  const holds = (op: string, x: number, v: number, v2?: number): boolean =>
    op === "gte" ? x >= v : op === "lte" ? x <= v : op === "gt" ? x > v : op === "lt" ? x < v :
    op === "eq" ? x === v : op === "between" ? x >= v && x <= (v2 ?? v) : true;
  // a pick fails the Guide only when a verifiable condition is MEASURABLY broken; missing form
  // data never hides a pick (unverifiable ≠ failed)
  const guideFails = (r: Record<string, unknown>): boolean => {
    if ((r.result as string) !== "pending") return false; // never rewrite history
    const filters = guideFilters.get(r.strategy_id as string);
    if (!filters) return false;
    const reasons = (r.criteria as { reasons?: { home_form?: Form5 | null; away_form?: Form5 | null } } | null)?.reasons;
    const hf = reasons?.home_form ?? null, af = reasons?.away_form ?? null;
    for (const c of filters) {
      const x = guideValue(c.field, hf, af);
      if (x != null && !holds(c.op, x, c.value, c.value2)) return true;
    }
    return false;
  };
  const kept: Record<string, unknown>[] = (data ?? []).filter((r: Record<string, unknown>) => !guideFails(r));

  const picks: AgentPick[] = kept.map((r: Record<string, unknown>) => ({
    id: r.id as string,
    market_key: (r.market_key as string) ?? null,
    market_label: (r.market_label as string) ?? null,
    custom_market: null,
    line: (r.line as number) ?? null,
    side: (r.side as string) ?? null,
    period: (r.period as string) ?? null,
    bet_value: (r.bet_value as string) ?? null,
    // deliveries grade into `result` (pending/won/lost/void) — map to the feed's `status`
    status: (r.result as string) ?? "pending",
    settle_score: (r.settle_score as string) ?? null,
    current_value: (r.current_value as number) ?? null,
    fixtures: (r.fixtures as AgentPick["fixtures"]) ?? null,
    agent_name: ((r.strategies as { name?: string } | null)?.name) ?? "Agent",
    // edge is stored as a fraction (0.05) — show it as a percentage (+5.0)
    edge: r.edge != null ? Math.round(Number(r.edge) * 1000) / 10 : null,
    model_prob: r.model_prob != null ? Number(r.model_prob) : null,
    market_prob: r.market_prob != null ? Number(r.market_prob) : null,
    tier: (r.tier as string) ?? null,
    reasons: ((r.criteria as { reasons?: unknown } | null)?.reasons as AgentPick["reasons"]) ?? null,
    delivered_at: (r.delivered_at as string) ?? null,
    onside_score: onsideScore(r),
  }));

  // scope the live feed to just the games in the feed (see RealtimeRefresh)
  const fixtureIds = Array.from(
    new Set(
      (data ?? [])
        .map((r: Record<string, unknown>) => (r.fixtures as { id?: number } | null)?.id)
        .filter((v): v is number => v != null)
    )
  );

  // which of these picks are already on the user's tracker (so their button shows "On tracker"
  // instead of prompting to add again) — matched by fixture + market + side, CANONICALISED so the
  // same outcome under a different name (e.g. "home over 0.5" vs "home to score") still counts as
  // already tracked and the user isn't invited to add a duplicate.
  const { data: myTickets } = await supabase
    .from("tickets")
    .select("fixture_id, market_key, line, side")
    .eq("user_id", user.id)
    .in("fixture_id", fixtureIds.length ? fixtureIds : [-1]);
  const takenKey = (fx: number, mk: string | null | undefined, line: number | null | undefined, side: string | null | undefined) => {
    const c = canonicalMarket(mk, line, side);
    return `${fx}:${c.marketKey ?? ""}:${c.side ?? ""}`;
  };
  const taken = new Set((myTickets ?? []).map((t) => takenKey(t.fixture_id as number, t.market_key, t.line as number | null, t.side)));
  const initialTracked = picks
    .filter((p) => {
      const fx = (p.fixtures as { id?: number } | null)?.id;
      return fx != null && taken.has(takenKey(fx, p.market_key, p.line, p.side));
    })
    .map((p) => p.id);

  // in-app "no games" note: running agents that ran today (WAT) but delivered nothing today —
  // mirrors the Telegram note so an empty run reads as "ran, nothing cleared", not silence.
  // IMPORTANT: "delivered today" is answered by the DATABASE, not by the rows the feed happened to
  // load — deriving it from the feed's own (limited) query falsely flagged agents whose batch had
  // been pushed out of the load window as "no games cleared" while their picks sat in the DB.
  const watDay = (iso: string) => new Date(iso).toLocaleDateString("en-CA", { timeZone: "Africa/Lagos" });
  const todayWat = new Date().toLocaleDateString("en-CA", { timeZone: "Africa/Lagos" });
  const { data: todayDelivered } = await supabase
    .from("deliveries")
    .select("strategy_id")
    .gte("delivered_at", lagosTodayStartISO());
  const deliveredTodayIds = new Set((todayDelivered ?? []).map((r) => r.strategy_id as string));
  const { data: runningStrategies } = await supabase
    .from("strategies")
    .select("id, name, last_run_at")
    .eq("status", "running");
  const emptyRuns = (runningStrategies ?? [])
    .filter((s) => s.last_run_at && watDay(s.last_run_at as string) === todayWat && !deliveredTodayIds.has(s.id as string))
    .map((s) => ({ id: s.id as string, agent_name: (s.name as string) ?? "Agent", ran_at: s.last_run_at as string }));

  // no banker double is built on a day with no fixtures — surface that in the tracker instead of
  // leaving an older day's card at the top. "No games today" = agents ran today (WAT) yet delivered
  // nothing today, so no game could feed the double.
  const anyRanToday = (runningStrategies ?? []).some((s) => s.last_run_at && watDay(s.last_run_at as string) === todayWat);
  const noGamesToday = anyRanToday && deliveredTodayIds.size === 0;

  // 🎯 Onside Double — the daily 2-leg banker, tracked day by day in the feed's sidebar
  const { data: dblRows } = await supabase
    .from("onside_double")
    .select("id, set_date, summary, legs, created_at")
    .eq("user_id", user.id)
    .order("set_date", { ascending: false })
    .limit(14);
  const doubles = (dblRows ?? []) as unknown as OnsideDouble[];

  // legs point at deliveries — pull them (past-day legs won't be in the 200-pick feed) so the
  // banker card can resolve live tick/cross/score
  const dblLegIds = Array.from(
    new Set(doubles.flatMap((d) => (d.legs ?? []).map((l) => l.delivery_id)).filter(Boolean))
  );
  const doubleDeliveries: Record<string, LegDelivery> = {};
  if (dblLegIds.length) {
    const { data: dblDels } = await supabase
      .from("deliveries")
      .select(
        "id, market_key, market_label, line, side, period, bet_value, result, settle_score, current_value, fixtures(id, home_team, away_team, kickoff_utc, status, elapsed, home_goals, away_goals, extra, updated_at, leagues(name, flag_url, tier), fixture_stats(momentum, corners_home, corners_away, corners_home_ht, corners_away_ht))"
      )
      .in("id", dblLegIds);
    for (const r of (dblDels ?? []) as Record<string, unknown>[]) {
      doubleDeliveries[r.id as string] = {
        id: r.id as string,
        market_key: (r.market_key as string) ?? null,
        market_label: (r.market_label as string) ?? null,
        custom_market: null,
        line: (r.line as number) ?? null,
        side: (r.side as string) ?? null,
        period: (r.period as string) ?? null,
        bet_value: (r.bet_value as string) ?? null,
        status: (r.result as string) ?? "pending",
        settle_score: (r.settle_score as string) ?? null,
        current_value: (r.current_value as number) ?? null,
        fixtures: (r.fixtures as LegDelivery["fixtures"]) ?? null,
      };
    }
  }

  // realtime covers the feed's games AND the double's legs (past-day legs may be off-feed)
  const liveFixtureIds = Array.from(
    new Set([
      ...fixtureIds,
      ...Object.values(doubleDeliveries)
        .map((d) => (d.fixtures as { id?: number } | null)?.id)
        .filter((v): v is number => v != null),
    ])
  );

  return (
    <>
      <RealtimeRefresh fixtureIds={liveFixtureIds} />
      <AgentBoard picks={picks} userId={user.id} initialTracked={initialTracked} emptyRuns={emptyRuns} doubles={doubles} doubleDeliveries={doubleDeliveries} noGamesToday={noGamesToday} />
    </>
  );
}
