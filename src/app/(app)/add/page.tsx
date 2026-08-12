import Link from "next/link";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { createClient } from "@/lib/supabase/server";
import AddGamesClient from "@/components/AddGamesClient";
import ImportSlip from "@/components/ImportSlip";
import MobileLogo from "@/components/MobileLogo";
import StickyHeader from "@/components/StickyHeader";

// The header (the LCP element) renders immediately off a fast auth+quota check; the heavy fixture /
// market / coverage queries stream in behind Suspense, so first paint no longer waits on them.
export default async function AddPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  // fast, per-user — kept on the critical path so the upload button knows the daily quota
  const { data: q } = await supabase.rpc("slip_upload_quota", { uid: user.id });
  const quota = (Array.isArray(q) ? q[0] : q) as { plan: string; quota: number; used: number } | null;
  const plan = quota?.plan ?? "free";
  const uploadQuota = Number(quota?.quota ?? 1);
  const uploadsLeft = Math.max(0, uploadQuota - Number(quota?.used ?? 0));

  return (
    <div className="flex flex-col lg:h-full">
      {/* same borderless header as every other page: transparent at rest, frosts on scroll.
          The search block below measures #add-header height and stacks beneath it. */}
      <StickyHeader>
        <div id="add-header" className="mx-auto max-w-4xl px-5 pb-3 pt-6 md:px-8">
          <MobileLogo />
          <div className="flex items-center justify-between">
            <div>
              <p className="font-mono text-[11px] uppercase tracking-[0.25em] text-flood">
                Add to tracker
              </p>
              <h1 className="mt-2 font-disp text-3xl font-bold tracking-tight text-chalk">
                Find your game.
              </h1>
              <p className="mt-1.5 max-w-[22rem] text-[12.5px] leading-relaxed text-onpitch-mute">
                Search below to add a game by hand — or upload your betslip to add a whole accumulator at once.
              </p>
            </div>
            <div className="flex flex-col items-end gap-2">
              <Link href="/tracker" className="font-mono text-xs text-onpitch-mute hover:text-chalk">
                ← Back
              </Link>
              <ImportSlip userId={user.id} plan={plan} uploadsLeft={uploadsLeft} uploadQuota={uploadQuota} />
            </div>
          </div>
        </div>
      </StickyHeader>

      <div className="mx-auto flex w-full max-w-4xl flex-col px-5 md:px-8 lg:min-h-0 lg:flex-1">
        <Suspense fallback={<AddGamesFallback />}>
          <AddGames userId={user.id} />
        </Suspense>
      </div>
    </div>
  );
}

// Heavy data lives here so it streams in AFTER the header has painted.
async function AddGames({ userId }: { userId: string }) {
  const supabase = await createClient();
  const now = new Date().toISOString();
  // no match is live more than ~4h after kickoff; guards against any fixture stranded in a
  // live status (feed dropped it) still showing here as "live 73'"
  const liveFloor = new Date(Date.now() - 4 * 3600 * 1000).toISOString();

  const [{ data: games }, { data: markets }, { data: cov }] = await Promise.all([
    supabase
      .from("fixtures")
      .select(
        "id, kickoff_utc, home_team, away_team, status, elapsed, home_goals, away_goals, extra, updated_at, leagues(name, flag_url, tier)"
      )
      // only genuinely upcoming games, or ones live right now — never finished or stranded
      .gte("kickoff_utc", liveFloor)
      .or(`kickoff_utc.gte.${now},status.in.(1H,2H,HT,ET,BT,P,LIVE)`)
      .order("kickoff_utc", { ascending: true })
      .limit(300),
    supabase.from("markets").select("key, label, kind"),
    // leagues with games today (WAT) out of all leagues we cover — accurate over every fixture
    supabase.rpc("add_league_coverage"),
  ]);

  const coverage = (Array.isArray(cov) ? cov[0] : cov) as { active: number; total: number } | null;

  return (
    <AddGamesClient
      games={(games ?? []) as never}
      markets={(markets ?? []) as never}
      userId={userId}
      leaguesActive={coverage?.active ?? 0}
      leaguesTotal={coverage?.total ?? 0}
    />
  );
}

// lightweight placeholder that reserves the search-bar + a few rows so streaming in the real list
// doesn't shift layout
function AddGamesFallback() {
  return (
    <div className="mt-3 flex flex-col gap-2" aria-hidden>
      <div className="h-11 w-full animate-pulse rounded-xl bg-white/5" />
      <div className="mt-2 flex flex-col gap-2">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="h-[62px] w-full animate-pulse rounded-xl bg-white/5" />
        ))}
      </div>
    </div>
  );
}
