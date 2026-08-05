import { createClient } from "@/lib/supabase/server";
import RealtimeRefresh from "@/components/RealtimeRefresh";
import AccumulatorsBoard, { type Acca } from "@/components/AccumulatorsBoard";

export default async function AccumulatorsPage() {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // history is capped per plan (free 3 · pro 10 · pro_max unlimited); a DB trigger prunes
  // the oldest on new inserts, and we bound the read here so the view matches immediately
  const { data: prof } = await supabase.from("profiles").select("plan").eq("id", user?.id ?? "").maybeSingle();
  const plan = prof?.plan ?? "free";
  const { data: lim } = await supabase.from("plan_limits").select("max_accas_history").eq("plan", plan).maybeSingle();
  const cap = (lim?.max_accas_history ?? null) as number | null;

  let query = supabase
    .from("accumulators")
    .select(
      "id, title, bookmaker, stake, potential_return, currency, leg_count, status, created_at, tickets(id, market_key, market_label, custom_market, line, side, status, current_value, fixtures(id, home_team, away_team, kickoff_utc, status, elapsed, home_goals, away_goals, extra, updated_at, leagues(name, flag_url, tier), fixture_stats(momentum, corners_home, corners_away)))"
    )
    .order("created_at", { ascending: false });
  if (cap != null) query = query.limit(cap);
  const { data } = await query;

  const accas = (data ?? []) as unknown as Acca[];

  // scope the live feed to just the games on these slips (see RealtimeRefresh)
  const fixtureIds = Array.from(
    new Set(
      accas
        .flatMap((a) => ((a.tickets ?? []) as unknown as { fixtures?: { id?: number } }[]).map((t) => t.fixtures?.id))
        .filter((v): v is number => v != null)
    )
  );

  return (
    <>
      <RealtimeRefresh fixtureIds={fixtureIds} />
      <AccumulatorsBoard accas={accas} plan={plan} cap={cap} />
    </>
  );
}
