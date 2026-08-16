import type { SupabaseClient } from "@supabase/supabase-js";
import { SCORE_GRADABLE, scoreGrade, type GoalEvent } from "@/lib/ticket";

// "Settle once, everywhere": settle EVERY bet the caller holds on one fixture from a single final
// score — both tickets (tracker singles + acca legs) and deliveries (agent picks) — each graded by
// its OWN market. Score-gradable markets grade to won/lost (a push → void). Markets a goal score
// can't grade (corners/cards/players/custom) are left as-is for a manual Landed/Missed. RLS scopes
// tickets to the caller; deliveries go through the settle_delivery RPC (also caller-scoped).
//
// PERIOD-AWARE: 1st/2nd-half goal legs grade from the stored goal timeline (fixtures.events) —
// 1h = goals with minute ≤ 45, 2h = final − 1h — but ONLY when the timeline reconciles with the
// final score (per-side event goals == the score); an incomplete timeline leaves the leg alone
// rather than guessing (the Seoul lesson: feeds mis-sequence and drop goal events).
type Bet = { id: string; market_key: string | null; side: string | null; line: number | null; bet_value: string | null; period: string | null };

// half-time score from the event timeline, or null when the timeline can't be trusted
function halfScore(events: GoalEvent[] | null | undefined, h: number, a: number): { h1h: number; h1a: number } | null {
  const goals = (events ?? []).filter((e) => e.kind === "goal" || e.kind === "pen" || e.kind === "og");
  const eh = goals.filter((g) => g.side === "home").length;
  const ea = goals.filter((g) => g.side === "away").length;
  if (eh !== h || ea !== a) return null; // timeline incomplete or mis-sided — don't guess
  const h1h = goals.filter((g) => g.side === "home" && (g.min ?? 99) <= 45).length;
  const h1a = goals.filter((g) => g.side === "away" && (g.min ?? 99) <= 45).length;
  return { h1h, h1a };
}

export async function settleFixtureByScore(supabase: SupabaseClient, fixtureId: number, home: number, away: number) {
  const score = `${home}-${away}`;
  const now = new Date().toISOString();

  // the goal timeline powers 1st/2nd-half legs; fetched once, trusted only when complete
  const { data: fx } = await supabase.from("fixtures").select("events").eq("id", fixtureId).maybeSingle();
  const halves = halfScore((fx?.events as GoalEvent[] | null) ?? null, home, away);

  // returns the grade for a bet in ITS period, or undefined when this call can't judge it
  const gradeBet = (b: Bet): "won" | "lost" | "void" | undefined => {
    if (!SCORE_GRADABLE.has(b.market_key ?? "")) return undefined;
    const period = b.period ?? "ft";
    if (period === "ft") return scoreGrade(b.market_key ?? null, b.side ?? null, b.line ?? null, home, away, b.bet_value ?? null) ?? "void";
    if (!halves) return undefined; // half leg without a trustworthy timeline — leave it alone
    const [ph, pa] = period === "1h" ? [halves.h1h, halves.h1a] : [home - halves.h1h, away - halves.h1a];
    return scoreGrade(b.market_key ?? null, b.side ?? null, b.line ?? null, ph, pa, b.bet_value ?? null) ?? "void";
  };

  const { data: tks } = await supabase
    .from("tickets")
    .select("id, market_key, side, line, bet_value, period")
    .eq("fixture_id", fixtureId)
    .in("status", ["pending", "live", "void"]);
  for (const t of (tks ?? []) as Bet[]) {
    const r = gradeBet(t);
    if (!r) continue;
    await supabase.from("tickets").update({ status: r, settled_at: now }).eq("id", t.id);
  }

  const { data: dls } = await supabase
    .from("deliveries")
    .select("id, market_key, side, line, bet_value, period")
    .eq("fixture_id", fixtureId)
    .in("result", ["pending", "void"]);
  for (const d of (dls ?? []) as Bet[]) {
    const r = gradeBet(d);
    if (!r) continue;
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
