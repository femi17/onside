import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import StrategyBuilder, { type LeagueOpt, type ExistingStrategy } from "@/components/StrategyBuilder";

// Edit an existing agent in the builder. Same shell as /strategies/new, but pre-filled and saving
// in place (no new slot, no immediate run — see StrategyBuilder.save).
export default async function EditStrategyPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const [{ data: profile }, { data: leaguesRaw }, { count: existingCount }, { data: strategy }] = await Promise.all([
    supabase.from("profiles").select("plan, is_admin").eq("id", user.id).single(),
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
        "id, name, status, market_key, market_label, custom_market, side, line, period, bet_value, rule_text, rule_parsed, kickoff_at, kickoff_until, league_ids, league_mode, selectivity, max_per_prediction, deliver_at, target_day, channels, learning, markets"
      )
      .eq("id", id)
      .eq("user_id", user.id)
      .maybeSingle(),
  ]);

  if (!strategy) redirect("/strategies");

  const plan = profile?.plan ?? "free";

  // owner-ruled: free agents are locked as built — the editor is a Pro surface (a DB trigger
  // enforces the same lock underneath; this page just says it kindly). Admins pass.
  if (plan === "free" && !profile?.is_admin) {
    return (
      <div className="mx-auto w-full max-w-md flex-1 px-5 py-16">
        <div className="rounded-2xl border border-dashed border-ink/15 bg-chalk p-8 text-center text-ink shadow-xl">
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-flood/15 font-mono text-xl text-flood-deep">🔒</div>
          <h1 className="font-disp text-xl font-extrabold text-ink">Tuning your agent is a Pro feature.</h1>
          <p className="mx-auto mt-2 max-w-sm text-[13.5px] leading-relaxed text-ink-mute">
            Your agent keeps hunting every day exactly as you built it. Pro (₦500/mo) lets you
            tune the rule, change the market and leagues, and run up to 3 agents at once.
          </p>
          <div className="mt-5 flex justify-center gap-2.5">
            <a href="/checkout?plan=pro" className="rounded-xl bg-flood px-5 py-2.5 text-[14px] font-bold text-ink">Upgrade to Pro</a>
            <a href="/strategies" className="rounded-xl border border-ink/20 px-5 py-2.5 text-[14px] font-bold text-ink">Back to agents</a>
          </div>
        </div>
      </div>
    );
  }
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
      maxAgents={profile?.is_admin ? 999 : limits?.max_agents ?? 3}
      canLearn={limits?.learning ?? false}
      existingCount={existingCount ?? 0}
      leagues={leagues}
      existing={strategy as ExistingStrategy}
    />
  );
}
