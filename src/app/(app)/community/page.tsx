import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import StickyHeader from "@/components/StickyHeader";
import MobileLogo from "@/components/MobileLogo";
import CommunityFeed, { type CommunityPost, type ShareItem, type AccaShare, type DoubleShare } from "@/components/CommunityFeed";
import LeaderboardOptIn from "@/components/LeaderboardOptIn";

// Community — built to design-reference/community.html. Real feed (Phase A+B): join with a handle,
// post notes / attach results, like + report. Leaderboard = your own agents' value vs market.
export default async function CommunityPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const [{ data: prof }, { data: rawPosts }, { data: myReacts }, { data: myBlocks }, { data: lb }, { data: recent }] = await Promise.all([
    supabase.from("profiles").select("handle, avatar_color, community_opt_in, leaderboard_opt_in, is_admin").eq("id", user.id).maybeSingle(),
    // first page only — the feed cursor-paginates older posts on demand (see CommunityFeed)
    supabase
      .from("community_posts")
      .select("id, author_handle, author_color, body, kind, attachment, like_count, comment_count, created_at")
      .eq("hidden", false)
      .order("created_at", { ascending: false })
      .limit(20),
    supabase.from("community_reactions").select("post_id").eq("user_id", user.id),
    supabase.from("community_blocks").select("blocked_handle").eq("blocker_id", user.id),
    // cross-member leaderboard (only opted-in members appear; aggregate only)
    supabase.rpc("community_daily_leaderboard"),
    // recent settled picks — attachable results for the composer
    supabase
      .from("deliveries")
      // strategies(status) rides along so draft (quick-acca pool) picks can be dropped below
      // WITHOUT losing deleted-agents' picks (null strategy = real history, stays attachable)
      .select("id, result, market_label, market_key, delivered_at, strategies(status), fixtures(home_team, away_team, leagues(name))")
      .in("result", ["won", "lost"])
      .order("delivered_at", { ascending: false })
      .limit(30),
  ]);

  type Row = {
    id: string; result: string; market_label: string | null; market_key: string | null;
    strategies: { status: string | null } | null;
    fixtures: { home_team: string; away_team: string; leagues: { name: string | null } | null } | null;
  };
  const board = (lb ?? []) as { user_id: string; handle: string; agent_name: string; landed: number; settled: number }[];
  const myHandle = prof?.handle ?? null;

  const blockedHandles = (myBlocks ?? []).map((b) => b.blocked_handle as string);
  const blockedSet = new Set(blockedHandles);
  const posts = ((rawPosts ?? []) as CommunityPost[]).filter((p) => !blockedSet.has(p.author_handle));

  // attachable results (most recent settled picks) for the composer. Draft picks (quick-acca
  // pool rows) are not agent results (owner-ruled); deleted agents' picks (null strategy) stay.
  const shareable: ShareItem[] = ((recent ?? []) as unknown as Row[])
    .filter((r) => r.strategies?.status !== "draft")
    .slice(0, 20)
    .map((r) => ({
    key: r.id,
    match: r.fixtures ? `${r.fixtures.home_team} v ${r.fixtures.away_team}` : "Match",
    league: r.fixtures?.leagues?.name ?? null,
    market: r.market_label ?? r.market_key ?? "Bet",
    result: r.result,
  }));

  // admin-only sharing sources: recent landed accas across the community (anonymised, via a
  // security-definer RPC — RLS blocks a direct cross-member read) + today's Onside Double
  let adminShare: { accas: AccaShare[]; double: DoubleShare | null } | null = null;
  if (prof?.is_admin) {
    const [{ data: accas }, { data: dbl }] = await Promise.all([
      supabase.rpc("admin_recent_won_accas"),
      supabase.from("onside_double").select("set_date, legs, summary").eq("user_id", user.id).order("set_date", { ascending: false }).limit(1).maybeSingle(),
    ]);
    type RawLeg = { game?: string; market?: string; prob?: number; agent?: string; fixture_id?: number; delivery_id?: string };
    const accaList: AccaShare[] = Array.isArray(accas)
      ? (accas as AccaShare[]).map((a) => ({ id: a.id, stake: a.stake ?? null, potential: a.potential ?? null, currency: a.currency ?? null, legs: a.legs ?? [] }))
      : [];
    let double: DoubleShare | null = null;
    if (dbl) {
      const rawLegs = (dbl.legs ?? []) as RawLeg[];
      // enrich legs with their market keys (from the admin's own deliveries) so the posted card
      // can grade each leg client-side as the games finish — "follow it live" made literal
      const dIds = rawLegs.map((l) => l.delivery_id).filter((v): v is string => !!v);
      const { data: dels } = dIds.length
        ? await supabase.from("deliveries").select("id, market_key, side, line, period, bet_value").in("id", dIds)
        : { data: [] as { id: string; market_key: string | null; side: string | null; line: number | null; period: string | null; bet_value: string | null }[] };
      const byId = new Map((dels ?? []).map((d) => [d.id as string, d]));
      double = {
        date: String(dbl.set_date),
        summary: (dbl.summary as string | null) ?? null,
        legs: rawLegs.map((l) => {
          const d = l.delivery_id ? byId.get(l.delivery_id) : undefined;
          return {
            game: l.game ?? "Match",
            market: l.market ?? "Pick",
            prob: l.prob ?? null,
            agent: l.agent ?? null,
            fixture_id: l.fixture_id ?? null,
            market_key: (d?.market_key as string | null) ?? null,
            side: (d?.side as string | null) ?? null,
            line: d?.line != null ? Number(d.line) : null,
            period: (d?.period as string | null) ?? null,
            bet_value: (d?.bet_value as string | null) ?? null,
          };
        }),
      };
    }
    adminShare = { accas: accaList, double };
  }

  // the banner invites people to join the public channel (@onsideai), not to DM the bot
  const tgUrl = process.env.NEXT_PUBLIC_TELEGRAM_CHANNEL_URL ?? "https://t.me/onsideai";

  return (
    <div className="pb-24">
      <StickyHeader>
        <div className="mx-auto max-w-4xl px-5 pb-3 pt-6 md:px-8">
          <MobileLogo />
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="font-mono text-[11px] uppercase tracking-[0.25em] text-flood">The Onside squad</p>
              <h1 className="mt-2 font-disp text-3xl font-bold tracking-tight text-chalk sm:text-4xl">Community.</h1>
            </div>
            {/* staff-only moderation entry — lives here instead of the nav */}
            {prof?.is_admin && (
              <Link
                href="/moderation"
                aria-label="Moderation"
                title="Moderation"
                className="mt-1 flex flex-none items-center gap-1.5 rounded-lg border border-white/15 px-3 py-2 font-mono text-[11px] font-bold uppercase tracking-wide text-onpitch-mute transition-colors hover:border-white/30 hover:text-chalk"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4" aria-hidden="true">
                  <path d="M12 3l7 3v6c0 4.4-3 7.4-7 9-4-1.6-7-4.6-7-9V6z" />
                </svg>
                <span className="hidden sm:inline">Moderation</span>
              </Link>
            )}
          </div>
        </div>
      </StickyHeader>

      <div className="mx-auto max-w-4xl px-5 pt-2 md:px-8">
        {/* Telegram join banner */}
        <div className="flex flex-wrap items-center gap-4 rounded-2xl bg-gradient-to-br from-[#229ED9] to-[#1c7fb0] p-5 text-white shadow-xl md:p-6">
          <div className="grid h-12 w-12 flex-none place-items-center rounded-2xl bg-white/15 text-2xl">✈</div>
          <div className="min-w-0">
            <div className="font-disp text-xl font-extrabold">Join the Telegram channel</div>
            <div className="mt-1 max-w-[46ch] text-[13.5px] leading-relaxed text-white/90">
              Follow @onsideai for daily value picks, results recaps and what&apos;s landing this week — straight to your phone.
            </div>
          </div>
          <a href={tgUrl} target="_blank" rel="noopener noreferrer" className="ml-auto flex-none rounded-xl bg-white px-4 py-3 font-bold text-[#12435c] transition-transform hover:-translate-y-0.5">
            Join channel
          </a>
        </div>

        {/* min-w-0 on both columns: a grid child's min-width defaults to its CONTENT, so one wide
            mono row (a picks post) would silently stretch the whole column past the viewport */}
        <div className="mt-6 grid gap-6 lg:grid-cols-[1.5fr_1fr]">
          {/* shared feed */}
          <div className="min-w-0">
            <SectionLabel>Shared this week</SectionLabel>
            <CommunityFeed
              userId={user.id}
              me={{ handle: prof?.handle ?? null, opt_in: prof?.community_opt_in ?? false, avatar_color: prof?.avatar_color ?? null }}
              initialPosts={posts}
              myLikes={(myReacts ?? []).map((r) => r.post_id as string)}
              blockedHandles={blockedHandles}
              shareable={shareable}
              adminShare={adminShare}
            />
          </div>

          {/* this week's edge — cross-member leaderboard (opted-in members only) */}
          <div className="min-w-0">
            <SectionLabel>Today&apos;s best</SectionLabel>
            <div className="rounded-2xl border border-white/10 bg-pitch-2 p-5">
              <div className="font-disp text-base font-bold text-chalk">Best agents today</div>
              <div className="mt-0.5 font-mono text-[11px] text-onpitch-mute">Most of today&apos;s picks landed</div>
              <div className="mt-3">
                {board.length ? (
                  board.map((r, i) => {
                    const mine = myHandle != null && r.handle === myHandle;
                    return (
                      <div key={`${r.user_id}:${r.agent_name}`} className="flex items-center gap-3 border-b border-white/10 py-2.5 last:border-0">
                        <span className="w-6 flex-none font-mono font-bold text-flood">{i + 1}</span>
                        <span className="min-w-0 flex-1 truncate text-sm font-semibold text-chalk">
                          <span className={mine ? "text-flood" : ""}>{mine ? "You" : r.handle}</span> · {r.agent_name}
                        </span>
                        <span className="flex-none rounded-md bg-grass/15 px-2 py-0.5 font-mono text-[12.5px] font-bold text-grass" title={`${r.landed} of ${r.settled} of today's settled picks landed`}>
                          {r.landed}/{r.settled}
                        </span>
                      </div>
                    );
                  })
                ) : (
                  <p className="mt-2 font-mono text-[12px] leading-relaxed text-onpitch-mute">
                    No landed picks on the board yet today — opt in below and your agents&apos; results will show here as today&apos;s games finish.
                  </p>
                )}
              </div>
              <LeaderboardOptIn on={prof?.leaderboard_opt_in ?? false} canOptIn={prof?.community_opt_in ?? false} />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="mb-2.5 flex items-center gap-3">
      <span className="font-mono text-[11px] font-bold uppercase tracking-[0.15em] text-onpitch-mute">{children}</span>
      <div className="h-px flex-1 bg-white/10" />
    </div>
  );
}
