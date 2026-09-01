import { redirect, notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import StickyHeader from "@/components/StickyHeader";
import MobileLogo from "@/components/MobileLogo";
import AdminAnalytics, { type AdminStats, type DailyActivity, type RecentPick, type LlmUsageRow } from "@/components/AdminAnalytics";
import { getAnthropicCredit } from "@/lib/anthropicCost";

// Platform analytics — admin-only. Gated on profiles.is_admin here and again inside the
// admin_analytics RPC (defence in depth). Non-admins get a 404, not a redirect.
export default async function AnalyticsPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: prof } = await supabase.from("profiles").select("is_admin").eq("id", user.id).maybeSingle();
  if (!prof?.is_admin) notFound();

  const [{ data }, { data: daily }, { data: picks }, { data: llm }, anthropic] = await Promise.all([
    supabase.rpc("admin_analytics"),
    supabase.rpc("admin_daily_activity"),
    supabase.rpc("admin_recent_picks"),
    supabase.rpc("admin_llm_usage"),
    getAnthropicCredit(),
  ]);
  const stats = data as AdminStats | null;

  return (
    <div className="pb-24">
      <StickyHeader>
        <div className="mx-auto max-w-5xl px-5 pb-3 pt-6 md:px-8">
          <MobileLogo />
          <p className="font-mono text-[11px] uppercase tracking-[0.25em] text-flood">Staff · platform</p>
          <h1 className="mt-2 font-disp text-3xl font-bold tracking-tight text-chalk sm:text-4xl">Analytics.</h1>
        </div>
      </StickyHeader>

      <div className="mx-auto max-w-5xl px-5 pt-2 md:px-8">
        {stats ? (
          <AdminAnalytics s={stats} daily={daily as DailyActivity | null} picks={picks as RecentPick[] | null} anthropic={anthropic} llm={llm as LlmUsageRow[] | null} />
        ) : (
          <p className="mt-6 rounded-2xl border border-white/10 bg-pitch-2 p-6 text-center text-[13.5px] text-onpitch-mute">
            Couldn&apos;t load analytics.
          </p>
        )}
      </div>
    </div>
  );
}
