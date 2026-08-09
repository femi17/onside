import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import StrategiesBoard, { type StrategyCard } from "@/components/StrategiesBoard";

export default async function StrategiesPage() {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const [{ data: strategies }, { data: deliveries }, { data: profile }] = await Promise.all([
    supabase
      .from("strategies")
      .select("id, name, market_label, league_ids, status, rule_text, deliver_at, target_day, last_run_at")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false }),
    supabase
      .from("deliveries")
      .select("strategy_id, result, edge, delivered_at")
      .eq("user_id", user.id)
      .order("delivered_at", { ascending: false })
      .limit(1000),
    supabase.from("profiles").select("plan, is_admin").eq("id", user.id).single(),
  ]);

  const cutoff = Date.now() - 14 * 86400000;
  const byStrategy = new Map<string, { result: string; edge: number | null; delivered_at: string | null }[]>();
  for (const d of deliveries ?? []) {
    const arr = byStrategy.get(d.strategy_id as string) ?? [];
    arr.push({ result: d.result as string, edge: (d.edge as number) ?? null, delivered_at: (d.delivered_at as string) ?? null });
    byStrategy.set(d.strategy_id as string, arr);
  }

  const cards: StrategyCard[] = (strategies ?? []).map((s: Record<string, unknown>) => {
    const ds = byStrategy.get(s.id as string) ?? [];
    const last14 = ds.filter((d) => (d.result === "won" || d.result === "lost") && d.delivered_at && new Date(d.delivered_at).getTime() >= cutoff);
    const edges = ds.map((d) => d.edge).filter((e): e is number => e != null);
    const spark = ds.slice(0, 8).reverse().map((d) => (d.result === "won" ? "won" : d.result === "lost" ? "lost" : "pending") as "won" | "lost" | "pending");
    // did the LATEST run come up empty? A run's deliveries are stamped seconds before
    // last_run_at, so "newest delivery well before the last run" = that run sent nothing.
    // Timezone-free on purpose — it compares the agent's own timestamps, not calendar days.
    const lastRun = (s.last_run_at as string | null) ?? null;
    const newestDelivery = ds[0]?.delivered_at ?? null;
    const ranEmpty = !!lastRun && (!newestDelivery || Date.parse(lastRun) - Date.parse(newestDelivery) > 5 * 60 * 1000);
    return {
      id: s.id as string,
      name: (s.name as string) ?? "Agent",
      market_label: (s.market_label as string) ?? null,
      league_count: Array.isArray(s.league_ids) ? (s.league_ids as number[]).length : 0,
      status: (s.status as string) ?? "draft",
      has_rule: !!(s.rule_text as string | null),
      deliver_at: s.deliver_at ? String(s.deliver_at).slice(0, 5) : null,
      target_day: (s.target_day as string) ?? "same_day",
      delivered: ds.length,
      last14: { won: last14.filter((d) => d.result === "won").length, total: last14.length },
      vs_market: edges.length ? (edges.reduce((a, b) => a + b, 0) / edges.length) * 100 : null,
      spark,
      last_run_at: lastRun,
      ran_empty: ranEmpty,
    };
  });

  const plan = profile?.plan ?? "free";
  const { data: limits } = await supabase.from("plan_limits").select("max_agents").eq("plan", plan).maybeSingle();

  return <StrategiesBoard cards={cards} maxAgents={profile?.is_admin ? 999 : limits?.max_agents ?? 3} />;
}
