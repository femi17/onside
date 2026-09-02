import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import StrategyBuilder, { type LeagueOpt } from "@/components/StrategyBuilder";

export default async function NewStrategyPage({ searchParams }: { searchParams: Promise<{ name?: string; market?: string; rule?: string }> }) {
  const sp = await searchParams;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const [{ data: profile }, { data: leaguesRaw }, { count: existingCount }] = await Promise.all([
    supabase.from("profiles").select("plan, is_admin").eq("id", user.id).single(),
    // curated (tiered) leagues first so the big competitions are in the default list; the search
    // box queries the full table for everything else
    supabase.from("leagues").select("id, name, country, flag_url, tier").order("tier", { ascending: true, nullsFirst: false }).order("name", { ascending: true }).limit(400),
    // generator "⚡ Quick acca" drafts must never count toward the plan's agent cap
    supabase.from("strategies").select("id", { count: "exact", head: true }).eq("user_id", user.id).not("name", "like", "⚡ Quick acca%"),
  ]);

  const plan = profile?.plan ?? "free";
  const { data: limits } = await supabase
    .from("plan_limits")
    .select("max_leagues, max_games_per_prediction, max_agents, learning")
    .eq("plan", plan)
    .maybeSingle();

  const TIER = ["uefa", "top", "sa_top", "as_top", "mid", "lower"];
  const leagues = ((leaguesRaw ?? []) as LeagueOpt[]).sort(
    (a, b) => TIER.indexOf(a.tier ?? "lower") - TIER.indexOf(b.tier ?? "lower") || a.name.localeCompare(b.name)
  );

  return (
    <StrategyBuilder
      userId={user.id}
      plan={plan}
      maxLeagues={limits?.max_leagues ?? 5}
      maxPicks={limits?.max_games_per_prediction ?? 3}
      // admins run the platform's own agents — no slot cap (plan caps stay untouched for everyone else)
      maxAgents={profile?.is_admin ? 999 : limits?.max_agents ?? 3}
      canLearn={limits?.learning ?? false}
      existingCount={existingCount ?? 0}
      leagues={leagues}
      // prefill from a /performance discovery card ("Build agent →") — name, market and rule
      prefill={sp.name || sp.market || sp.rule ? { name: sp.name, marketKey: sp.market, ruleText: sp.rule } : undefined}
    />
  );
}
