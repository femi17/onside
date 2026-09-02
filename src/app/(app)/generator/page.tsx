import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import GeneratorBoard, { type GenPick } from "@/components/GeneratorBoard";
import { lagosTodayStartISO } from "@/lib/ticket";

// Acca Generator — assembles accumulator slips ONLY from the signed-in user's OWN agents'
// deliveries (Onside never presents platform-picked bets; the pool is what THEIR agents found).
// Pool = today's pending deliveries whose game is still upcoming and which carry a price from
// the per-pick odds waterfall (criteria.odds / odds_src). Selection + assembly is client-side;
// the free-plan slip/leg limits are enforced server-side by a DB trigger on insert.
export default async function GeneratorPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const todayIso = lagosTodayStartISO();
  const [{ data: prof }, { count: agentCount }, { data: dels }, { count: genToday }] = await Promise.all([
    supabase.from("profiles").select("plan").eq("id", user.id).maybeSingle(),
    // any agent at all (running or paused) — the "no agents" empty state is about setup, not scheduling
    supabase.from("strategies").select("id", { count: "exact", head: true }).eq("user_id", user.id),
    supabase
      .from("deliveries")
      .select(
        "id, strategy_id, market_key, market_label, line, side, period, bet_value, model_prob, criteria, strategies(name), fixtures(id, home_team, away_team, kickoff_utc, status, leagues(name, flag_url, tier))"
      )
      .eq("user_id", user.id)
      .eq("result", "pending")
      .gte("delivered_at", todayIso)
      // a deleted agent's surviving picks have strategy_id nulled — not assemblable
      .not("strategy_id", "is", null)
      .order("delivered_at", { ascending: false })
      .limit(400),
    // client-side mirror of the free-plan daily count (the trigger is the real gate). Lagos-day
    // here vs profile-timezone in the trigger — close enough for a display mirror.
    supabase
      .from("accumulators")
      .select("id", { count: "exact", head: true })
      .eq("user_id", user.id)
      .eq("source", "generated")
      .gte("created_at", todayIso),
  ]);

  const cutoff = Date.now() + 10 * 60 * 1000;
  const picks: GenPick[] = [];
  for (const r of (dels ?? []) as Record<string, unknown>[]) {
    const f = r.fixtures as {
      id: number;
      home_team: string;
      away_team: string;
      kickoff_utc: string;
      status: string | null;
      leagues: { name: string; flag_url: string | null; tier: string | null } | null;
    } | null;
    if (!f?.kickoff_utc || Date.parse(f.kickoff_utc) < cutoff) continue;
    // only priced picks are eligible — without an odd the combined product would be a lie
    const crit = r.criteria as { odds?: number; odds_src?: string } | null;
    const odds = typeof crit?.odds === "number" && crit.odds > 1 ? crit.odds : null;
    if (odds == null) continue;
    picks.push({
      id: r.id as string,
      strategy_id: (r.strategy_id as string) ?? null,
      agent_name: ((r.strategies as { name?: string } | null)?.name) ?? "Agent",
      market_key: (r.market_key as string) ?? null,
      market_label: (r.market_label as string) ?? null,
      line: (r.line as number) ?? null,
      side: (r.side as string) ?? null,
      period: (r.period as string) ?? null,
      bet_value: (r.bet_value as string) ?? null,
      model_prob: r.model_prob != null ? Number(r.model_prob) : null,
      odds,
      odds_src: crit?.odds_src === "quoted" || crit?.odds_src === "derived" ? crit.odds_src : "model",
      fixture: {
        id: f.id,
        home_team: f.home_team,
        away_team: f.away_team,
        kickoff_utc: f.kickoff_utc,
        league: f.leagues ?? null,
      },
    });
  }

  return (
    <GeneratorBoard
      picks={picks}
      plan={prof?.plan ?? "free"}
      userId={user.id}
      agentCount={agentCount ?? 0}
      generatedToday={genToday ?? 0}
    />
  );
}
