import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import RealtimeRefresh from "@/components/RealtimeRefresh";
import AgentBoard, { type AgentPick, type OnsideDoubleLeg as AgentBoardDoubleLeg } from "@/components/AgentBoard";

export default async function AgentPage() {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data } = await supabase
    .from("deliveries")
    .select(
      "id, market_key, market_label, line, side, period, bet_value, result, settle_score, current_value, delivered_at, edge, model_prob, market_prob, tier, criteria, strategies(name), fixtures(id, home_team, away_team, kickoff_utc, status, elapsed, home_goals, away_goals, extra, updated_at, leagues(name, flag_url, tier), fixture_stats(momentum, corners_home, corners_away, corners_home_ht, corners_away_ht))"
    )
    .order("delivered_at", { ascending: false })
    .limit(200);

  const picks: AgentPick[] = (data ?? []).map((r: Record<string, unknown>) => ({
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
  // instead of prompting to add again on reload) — matched by fixture + market + side
  const { data: myTickets } = await supabase
    .from("tickets")
    .select("fixture_id, market_key, side")
    .eq("user_id", user.id)
    .in("fixture_id", fixtureIds.length ? fixtureIds : [-1]);
  const taken = new Set((myTickets ?? []).map((t) => `${t.fixture_id}:${t.market_key ?? ""}:${t.side ?? ""}`));
  const initialTracked = picks
    .filter((p) => {
      const fx = (p.fixtures as { id?: number } | null)?.id;
      return fx != null && taken.has(`${fx}:${p.market_key ?? ""}:${p.side ?? ""}`);
    })
    .map((p) => p.id);

  // in-app "no games" note: running agents that ran today (WAT) but delivered nothing today —
  // mirrors the Telegram note so an empty run reads as "ran, nothing cleared", not silence.
  const watDay = (iso: string) => new Date(iso).toLocaleDateString("en-CA", { timeZone: "Africa/Lagos" });
  const todayWat = new Date().toLocaleDateString("en-CA", { timeZone: "Africa/Lagos" });
  const deliveredTodayNames = new Set(
    (data ?? [])
      .filter((r: Record<string, unknown>) => r.delivered_at && watDay(r.delivered_at as string) === todayWat)
      .map((r: Record<string, unknown>) => ((r.strategies as { name?: string } | null)?.name) ?? "Agent")
  );
  const { data: runningStrategies } = await supabase
    .from("strategies")
    .select("id, name, last_run_at")
    .eq("status", "running");
  const emptyRuns = (runningStrategies ?? [])
    .filter((s) => s.last_run_at && watDay(s.last_run_at as string) === todayWat && !deliveredTodayNames.has(s.name as string))
    .map((s) => ({ id: s.id as string, agent_name: (s.name as string) ?? "Agent", ran_at: s.last_run_at as string }));

  // 🎯 today's Onside Double — the 2-leg banker slip
  const { data: dblRow } = await supabase
    .from("onside_double")
    .select("set_date, summary, legs")
    .eq("user_id", user.id)
    .order("set_date", { ascending: false })
    .limit(1)
    .maybeSingle();
  const dbl = dblRow && String(dblRow.set_date) === todayWat
    ? { summary: (dblRow.summary as string) ?? null, legs: (dblRow.legs as AgentBoardDoubleLeg[]) ?? [] }
    : null;

  return (
    <>
      <RealtimeRefresh fixtureIds={fixtureIds} />
      <AgentBoard picks={picks} userId={user.id} initialTracked={initialTracked} emptyRuns={emptyRuns} double={dbl} />
    </>
  );
}
