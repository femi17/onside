import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import StickyHeader from "@/components/StickyHeader";
import MobileLogo from "@/components/MobileLogo";
import SchoolBoard, { type SchoolRecord } from "@/components/SchoolBoard";

// Onside School — the VVIP daily banker: the Onside Double, played as its two Over 2.5 legs.
// The record here is REAL: each row is an actual Onside Double, regraded as an Over 2.5 double
// (wins only if BOTH games go 3+ goals). Per-leg odds are the model's Over 2.5 price (1/prob).
export const dynamic = "force-dynamic"; // the record grows daily

const FINISHED = ["FT", "AET", "PEN"];

export default async function SchoolPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  // Owner-only pilot until the record has 20 settled games. Gate the route (the menu link is
  // likewise is_admin-gated in the app layout) so it isn't reachable by URL either.
  const { data: profile } = await supabase.from("profiles").select("is_admin").eq("id", user.id).single();
  if (!profile?.is_admin) redirect("/tracker");

  // 1. recent Onside Doubles (both-legs-Over-0.5 variant), newest first
  const { data: doubles } = await supabase
    .from("onside_double")
    .select("set_date, legs")
    .order("set_date", { ascending: false })
    .limit(40);

  // keep only doubles whose EVERY leg is Over 0.5; dedupe regenerations by the fixture pair
  const seen = new Set<string>();
  const picked = (doubles ?? []).filter((d) => {
    const legs = (d.legs as Array<Record<string, unknown>>) ?? [];
    if (legs.length < 2) return false;
    if (!legs.every((l) => /over 0\.5/i.test(String(l.market ?? "")))) return false;
    const key = legs
      .map((l) => l.fixture_id)
      .sort()
      .join("-");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const fixtureIds = [...new Set(picked.flatMap((d) => (d.legs as Array<Record<string, unknown>>).map((l) => Number(l.fixture_id))))];
  const deliveryIds = [
    ...new Set(
      picked.flatMap((d) => (d.legs as Array<Record<string, unknown>>).map((l) => l.delivery_id).filter(Boolean) as string[])
    ),
  ];

  const [{ data: fixtures }, { data: deliveries }] = await Promise.all([
    fixtureIds.length
      ? supabase.from("fixtures").select("id, ft_home, ft_away, home_goals, away_goals, status").in("id", fixtureIds)
      : Promise.resolve({ data: [] as never[] }),
    deliveryIds.length
      ? supabase.from("deliveries").select("id, criteria").in("id", deliveryIds)
      : Promise.resolve({ data: [] as never[] }),
  ]);

  const fx = new Map((fixtures ?? []).map((f) => [Number((f as { id: number }).id), f as Record<string, number | string | null>]));
  const dv = new Map((deliveries ?? []).map((d) => [(d as { id: string }).id, d as { criteria: Record<string, unknown> }]));

  const records: SchoolRecord[] = picked
    .map((d) => {
      const legs = (d.legs as Array<Record<string, unknown>>).map((l) => {
        const f = fx.get(Number(l.fixture_id));
        const del = dv.get(String(l.delivery_id));
        const model = (del?.criteria as { reasons?: { model?: { over25?: number } } } | undefined)?.reasons?.model;
        const over25 = model?.over25 ?? null;
        const odds = over25 && over25 > 0 ? Math.round((1 / over25) * 100) / 100 : null;
        const settled = f && FINISHED.includes(String(f.status));
        const h = f ? ((f.ft_home ?? f.home_goals) as number | null) : null;
        const a = f ? ((f.ft_away ?? f.away_goals) as number | null) : null;
        const tot = settled && h != null && a != null ? h + a : null;
        return {
          game: String(l.game ?? ""),
          odds,
          score: tot != null ? `${h}-${a}` : null,
          hit: tot != null ? tot >= 3 : null,
        };
      });
      const combined = Math.round(legs.reduce((p, l) => p * (l.odds ?? 1), 1) * 100) / 100;
      const graded = legs.every((l) => l.hit != null && l.odds != null);
      const result: "won" | "lost" | "pending" = !graded
        ? "pending"
        : legs.every((l) => l.hit)
          ? "won"
          : "lost";
      return { date: String(d.set_date), legs, combined, result };
    })
    // record = graded days only, oldest → newest so cumulative P/L reads left to right
    .filter((r) => r.result !== "pending")
    .reverse();

  return (
    <div className="pb-24">
      <StickyHeader>
        <div className="mx-auto max-w-5xl px-5 pb-3 pt-6 md:px-8">
          <MobileLogo />
          <p className="font-mono text-[11px] uppercase tracking-[0.25em] text-flood">VVIP</p>
          <h1 className="mt-2 font-disp text-3xl font-bold tracking-tight text-chalk sm:text-4xl">Onside School.</h1>
        </div>
      </StickyHeader>

      <SchoolBoard records={records} />
    </div>
  );
}
