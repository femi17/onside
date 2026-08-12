import { createClient } from "@/lib/supabase/server";
import { lagosTodayStartISO } from "@/lib/ticket";
import RealtimeRefresh from "@/components/RealtimeRefresh";
import TrackerBoard, { type Ticket } from "@/components/TrackerBoard";

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

  return (
    <>
      <RealtimeRefresh fixtureIds={fixtureIds} />
      {/* only today's slate lives here; older settled games move to History */}
      <TrackerBoard tickets={list} since={lagosTodayStartISO()} />
    </>
  );
}
