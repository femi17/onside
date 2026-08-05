import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import PerformanceBoard from "@/components/PerformanceBoard";

// Performance = "is it actually working?" — reads your agents' delivered picks and grades them
// against the market. Matches design-reference/performance.html. All computed from `deliveries`.
export default async function PerformancePage() {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const [{ data }, { data: events }] = await Promise.all([
    supabase
      .from("deliveries")
      .select(
        "id, strategy_id, result, model_prob, market_prob, edge, tier, market_key, market_label, delivered_at, strategies(name), fixtures(leagues(name, flag_url, tier))"
      )
      .order("delivered_at", { ascending: false })
      .limit(3000),
    // learning-change log (Pro Max self-tuning); powers the "what your agent learned" timeline
    supabase
      .from("strategy_learning_events")
      .select("id, strategy_id, prev_min_edge, new_min_edge, avg_roi, sample_size, created_at, strategies(name)")
      .order("created_at", { ascending: false })
      .limit(200),
  ]);

  return <PerformanceBoard picks={(data ?? []) as never} events={(events ?? []) as never} />;
}
