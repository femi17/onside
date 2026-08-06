import { redirect } from "next/navigation";
import { Suspense } from "react";
import { createClient } from "@/lib/supabase/server";
import PerformanceBoard from "@/components/PerformanceBoard";
import StickyHeader from "@/components/StickyHeader";
import MobileLogo from "@/components/MobileLogo";

// Performance = "is it actually working?" — reads your agents' delivered picks and grades them
// against the market. The header (LCP element) renders immediately; the heavy deliveries query
// (up to 3000 rows) + the board stream in behind Suspense so first paint no longer waits on it.
export default async function PerformancePage() {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  return (
    <div className="pb-24">
      <StickyHeader>
        <div className="mx-auto max-w-5xl px-5 pb-3 pt-6 md:px-8">
          <MobileLogo />
          <p className="font-mono text-[11px] uppercase tracking-[0.25em] text-flood">Is it actually working?</p>
          <h1 className="mt-2 font-disp text-3xl font-bold tracking-tight text-chalk sm:text-4xl">Performance.</h1>
        </div>
      </StickyHeader>

      <Suspense fallback={<PerfFallback />}>
        <PerfData />
      </Suspense>
    </div>
  );
}

async function PerfData() {
  const supabase = createClient();
  const [{ data }, { data: events }, { data: learners }] = await Promise.all([
    supabase
      .from("deliveries")
      .select(
        "id, strategy_id, result, model_prob, market_prob, edge, tier, clv, market_key, market_label, delivered_at, strategies(name), fixtures(leagues(name, flag_url, tier))"
      )
      .order("delivered_at", { ascending: false })
      .limit(3000),
    // learning-change log (Pro Max self-tuning); powers the "what your agent learned" timeline
    supabase
      .from("strategy_learning_events")
      .select("id, strategy_id, prev_min_edge, new_min_edge, avg_roi, avg_clv, basis, sample_size, created_at, strategies(name)")
      .order("created_at", { ascending: false })
      .limit(200),
    // which agents have Learning ON — so an empty tuning log reads as "collecting samples",
    // never as "you haven't turned learning on"
    supabase.from("strategies").select("name").eq("learning", true).eq("status", "running"),
  ]);
  return (
    <PerformanceBoard
      picks={(data ?? []) as never}
      events={(events ?? []) as never}
      learningAgents={(learners ?? []).map((s) => s.name as string).filter(Boolean)}
      hideHeader
    />
  );
}

// KPI + panel skeleton so the streamed board doesn't shift layout
function PerfFallback() {
  return (
    <div className="mx-auto max-w-5xl px-5 pt-2 md:px-8" aria-hidden>
      <div className="flex gap-2"><div className="h-9 w-24 animate-pulse rounded-full bg-white/5" /><div className="h-9 w-24 animate-pulse rounded-full bg-white/5" /></div>
      <div className="mt-4 grid grid-cols-2 gap-3.5 md:grid-cols-3 lg:grid-cols-5">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="h-[104px] animate-pulse rounded-2xl bg-white/5" />
        ))}
      </div>
      <div className="mt-4 grid gap-4 lg:grid-cols-[1.4fr_1fr]">
        <div className="h-[260px] animate-pulse rounded-2xl bg-white/5" />
        <div className="h-[260px] animate-pulse rounded-2xl bg-white/5" />
      </div>
    </div>
  );
}
