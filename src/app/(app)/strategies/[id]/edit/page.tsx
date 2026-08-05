import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import StrategyBuilder, { type LeagueOpt, type ExistingStrategy } from "@/components/StrategyBuilder";

// Edit an existing agent in the builder. Same shell as /strategies/new, but pre-filled and saving
// in place (no new slot, no immediate run — see StrategyBuilder.save).
export default async function EditStrategyPage({ params }: { params: { id: string } }) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const [{ data: profile }, { data: leaguesRaw }, { count: existingCount }, { data: strategy }] = await Promise.all([
    supabase.from("profiles").select("plan").eq("id", user.id).single(),
    supabase
      .from("leagues")
      .select("id, name, country, flag_url, tier")
      .order("tier", { ascending: true, nullsFirst: false })
      .order("name", { ascending: true })
      .limit(400),
    supabase.from("strategies").select("id", { count: "exact", head: true }).eq("user_id", user.id),
    supabase
      .from("strategies")
      .select(
        "id, name, status, market_key, market_label, custom_market, side, line, period, bet_value, rule_text, league_ids, league_mode, selectivity, max_per_prediction, deliver_at, target_day, channels, learning"
      )
      .eq("id", params.id)
      .eq("user_id", user.id)
      .maybeSingle(),
  ]);

  if (!strategy) redirect("/strategies");

  const plan = profile?.plan ?? "free";
  const { data: limits } = await supabase
    .from("plan_limits")
    .select("max_leagues, max_games_per_prediction, max_agents, learning")
    .eq("plan", plan)
    .maybeSingle();

  const TIER = ["uefa", "top", "mid", "lower"];
  const leagues = ((leaguesRaw ?? []) as LeagueOpt[]).sort(
    (a, b) => TIER.indexOf(a.tier ?? "lower") - TIER.indexOf(b.tier ?? "lower") || a.name.localeCompare(b.name)
  );

  return (
    <StrategyBuilder
      userId={user.id}
      plan={plan}
      maxLeagues={limits?.max_leagues ?? 5}
      maxPicks={limits?.max_games_per_prediction ?? 3}
      maxAgents={limits?.max_agents ?? 3}
      canLearn={limits?.learning ?? false}
      existingCount={existingCount ?? 0}
      leagues={leagues}
      existing={strategy as ExistingStrategy}
    />
  );
}
