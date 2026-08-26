import { createClient } from "@/lib/supabase/server";
import { lagosTodayStartISO } from "@/lib/ticket";
import RealtimeRefresh from "@/components/RealtimeRefresh";
import TrackerBoard, { type Ticket } from "@/components/TrackerBoard";
import ActivationNudge from "@/components/ActivationNudge";
import CommunityNudge from "@/components/CommunityNudge";
import PushNudge from "@/components/PushNudge";

export default async function TrackerPage() {
  const supabase = await createClient();
  const { data: tickets } = await supabase
    .from("tickets")
    .select(
      "id, accumulator_id, market_key, market_label, custom_market, line, side, period, bet_value, status, current_value, created_at, settled_at, tracker_hidden, fixtures(id, home_team, away_team, kickoff_utc, status, elapsed, home_goals, away_goals, extra, events, updated_at, leagues(name, flag_url, tier), fixture_stats(momentum, corners_home, corners_away, corners_home_ht, corners_away_ht))"
    )
    // a leg the user removed from the tracker stays in its acca but is hidden here
    .eq("tracker_hidden", false)
    .order("created_at", { ascending: false });

  const list = (tickets ?? []) as unknown as Ticket[];
  const fixtureIds = Array.from(
    new Set(list.map((t) => (t.fixtures as unknown as { id?: number })?.id).filter((v): v is number => v != null))
  );

  // first-run nudge: an empty tracker AND no agents = un-activated — show directed next
  // steps instead of a bare empty state (RLS scopes both counts to this user). The card
  // vanishes the moment they track a bet or build an agent.
  let showNudge = false;
  let recipes: import("@/components/ActivationNudge").RecipeStats | null = null;
  if (list.length === 0) {
    const { count: agentCount } = await supabase
      .from("strategies")
      .select("id", { count: "exact", head: true });
    showNudge = (agentCount ?? 0) === 0;
    if (showNudge) {
      // live receipts for the starter recipes — the card's proof line
      const { data } = await supabase.rpc("starter_recipes");
      recipes = (data as typeof recipes) ?? null;
    }
  }

  // post-activation nudges: push first (a tracking user with no push is watching blind),
  // then the community/Telegram strip — ONE nudge per lifecycle stage, never stacked.
  // PushNudge decides client-side (support/permission/dismissal) and falls back to the
  // community card itself, so the ladder still shows exactly one card.
  let commFlags: { optedIn: boolean; telegramLinked: boolean } | null = null;
  let userId: string | null = null;
  let hasPush = true; // assume covered until we know otherwise — avoids a flash for admins etc.
  if (!showNudge) {
    const [{ data: prof }, { data: auth }, { count: pushCount }] = await Promise.all([
      supabase.from("profiles").select("community_opt_in, telegram_linked_at").maybeSingle(),
      supabase.auth.getUser(),
      supabase.from("push_subscriptions").select("endpoint", { count: "exact", head: true }),
    ]);
    commFlags = { optedIn: !!prof?.community_opt_in, telegramLinked: !!prof?.telegram_linked_at };
    userId = auth?.user?.id ?? null;
    hasPush = (pushCount ?? 0) > 0;
  }

  return (
    <>
      <RealtimeRefresh fixtureIds={fixtureIds} />
      {showNudge && <ActivationNudge recipes={recipes} />}
      {commFlags && userId && (
        <PushNudge
          userId={userId}
          hasPush={hasPush}
          fallback={<CommunityNudge optedIn={commFlags.optedIn} telegramLinked={commFlags.telegramLinked} />}
        />
      )}
      {commFlags && !userId && <CommunityNudge optedIn={commFlags.optedIn} telegramLinked={commFlags.telegramLinked} />}
      {/* only today's slate lives here; older settled games move to History */}
      <TrackerBoard tickets={list} since={lagosTodayStartISO()} />
    </>
  );
}
