import type { SupabaseClient } from "@supabase/supabase-js";
import { SCORE_GRADABLE, scoreGrade } from "@/lib/ticket";

// "Settle once, everywhere": settle EVERY bet the caller holds on one fixture from a single final
// score — both tickets (tracker singles + acca legs) and deliveries (agent picks) — each graded by
// its OWN market. Score-gradable markets grade to won/lost (a push → void). Markets a goal score
// can't grade (corners/cards/players/custom) are left as-is for a manual Landed/Missed. RLS scopes
// tickets to the caller; deliveries go through the settle_delivery RPC (also caller-scoped).
type Bet = { id: string; market_key: string | null; side: string | null; line: number | null; bet_value: string | null };

export async function settleFixtureByScore(supabase: SupabaseClient, fixtureId: number, home: number, away: number) {
  const score = `${home}-${away}`;
  const now = new Date().toISOString();

  const { data: tks } = await supabase
    .from("tickets")
    .select("id, market_key, side, line, bet_value")
    .eq("fixture_id", fixtureId)
    .in("status", ["pending", "live", "void"]);
  for (const t of (tks ?? []) as Bet[]) {
    if (!SCORE_GRADABLE.has(t.market_key ?? "")) continue;
    const r = scoreGrade(t.market_key ?? null, t.side ?? null, t.line ?? null, home, away, t.bet_value ?? null) ?? "void";
    await supabase.from("tickets").update({ status: r, settled_at: now }).eq("id", t.id);
  }

  const { data: dls } = await supabase
    .from("deliveries")
    .select("id, market_key, side, line, bet_value")
    .eq("fixture_id", fixtureId)
    .in("result", ["pending", "void"]);
  for (const d of (dls ?? []) as Bet[]) {
    if (!SCORE_GRADABLE.has(d.market_key ?? "")) continue;
    const r = scoreGrade(d.market_key ?? null, d.side ?? null, d.line ?? null, home, away, d.bet_value ?? null) ?? "void";
    await supabase.rpc("settle_delivery", { p_id: d.id, p_result: r, p_score: score });
  }
}

// Void EVERY still-open bet on a fixture (game off / postponed / abandoned) — tickets + deliveries.
export async function voidFixture(supabase: SupabaseClient, fixtureId: number) {
  const now = new Date().toISOString();
  await supabase
    .from("tickets")
    .update({ status: "void", settled_at: now })
    .eq("fixture_id", fixtureId)
    .in("status", ["pending", "live"]);
  const { data: dls } = await supabase
    .from("deliveries")
    .select("id")
    .eq("fixture_id", fixtureId)
    .in("result", ["pending"]);
  for (const d of (dls ?? []) as { id: string }[]) {
    await supabase.rpc("settle_delivery", { p_id: d.id, p_result: "void" });
  }
}
