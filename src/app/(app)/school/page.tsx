import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { SchoolFunnel, SchoolMember, type SchoolRecord } from "@/components/SchoolBoard";
import SchoolEnroll from "@/components/SchoolEnroll";
import SchoolAdmin from "@/components/SchoolAdmin";
import RealtimeRefresh from "@/components/RealtimeRefresh";
import { SCHOOL_OPEN, SCHOOL_PRICE, SCHOOL_BANK } from "@/lib/school";

// Onside School — the VVIP daily banker: the Onside Double, played as its two Over 2.5 legs (a line an
// admin can swap per game). The record is REAL: each row is an actual Onside Double, regraded against
// each leg's line. Non-members get the induction funnel + join flow; admitted members (and admins) get
// today's pick + the full record browsable by month. The settled stats seed the funnel's proof.
export const dynamic = "force-dynamic"; // the record grows daily

const FINISHED = ["FT", "AET", "PEN"];
const LIVE = ["1H", "HT", "2H", "ET", "BT", "P", "LIVE", "INT", "SUSP"];
// over-lines only: goals needed to clear each line (Over 2.5 -> 3, Over 3.5 -> 4, …)
const NEED: Record<string, number> = { over_0_5: 1, over_1_5: 2, over_2_5: 3, over_3_5: 4, over_4_5: 5 };

export default async function SchoolPage({ searchParams }: { searchParams: Promise<{ preview?: string }> }) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: profile } = await supabase.from("profiles").select("is_admin").eq("id", user.id).single();
  const realAdmin = !!profile?.is_admin;

  // While the pilot is closed, keep the whole page owner-only (the nav link is gated the same way in
  // the app layout). Flip SCHOOL_OPEN in src/lib/school.ts to open it to every signed-in user.
  if (!SCHOOL_OPEN && !realAdmin) redirect("/tracker");

  // Owner-only preview: ?preview=guest renders the exact non-member experience (the induction funnel)
  // so we can eyeball it without opening the pilot or changing admin status.
  const previewGuest = realAdmin && (await searchParams)?.preview === "guest";
  const isAdmin = realAdmin && !previewGuest;

  // Membership: an active admitted enrollment (or admin) unlocks the member dashboard. Wrapped
  // defensively so the page still renders for the owner if the enrollment migration isn't applied yet.
  const { data: enr } = await supabase
    .from("school_enrollments")
    .select("status, admitted_until")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false });
  const nowMs = Date.now();
  const admitted =
    isAdmin || (enr ?? []).some((e) => e.status === "admitted" && e.admitted_until && new Date(e.admitted_until).getTime() > nowMs);
  const hasPending = (enr ?? []).some((e) => e.status === "pending");
  const enrollStatus: "none" | "pending" | "rejected" = hasPending
    ? "pending"
    : (enr ?? [])[0]?.status === "rejected"
      ? "rejected"
      : "none";

  // recent Onside Doubles (both-legs-Over-0.5 variant), newest first
  const { data: doubles } = await supabase
    .from("onside_double")
    .select("set_date, legs")
    .order("set_date", { ascending: false })
    .limit(80);

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

  const [{ data: fixtures }, { data: deliveries }, { data: legPicks }] = await Promise.all([
    fixtureIds.length
      ? supabase
          .from("fixtures")
          .select("id, ft_home, ft_away, home_goals, away_goals, status, elapsed, updated_at, kickoff_utc, leagues(name, flag_url, tier)")
          .in("id", fixtureIds)
      : Promise.resolve({ data: [] as never[] }),
    deliveryIds.length
      ? supabase.from("deliveries").select("id, criteria").in("id", deliveryIds)
      : Promise.resolve({ data: [] as never[] }),
    // per-leg line + real odds an admin has set (over_2_5 default when absent)
    fixtureIds.length
      ? supabase.from("school_leg_odds").select("fixture_id, odds, market").in("fixture_id", fixtureIds)
      : Promise.resolve({ data: [] as never[] }),
  ]);
  const pickOf = new Map(
    ((legPicks ?? []) as Array<{ fixture_id: number; odds: number | null; market: string | null }>).map((r) => [
      Number(r.fixture_id),
      { odds: r.odds == null ? null : Number(r.odds), market: r.market ?? "over_2_5" },
    ])
  );

  const fx = new Map((fixtures ?? []).map((f) => [Number((f as { id: number }).id), f as Record<string, unknown>]));
  type Lg = { name?: string; flag_url?: string | null; tier?: string | null };
  const leagueOf = (f: Record<string, unknown> | undefined): Lg | undefined => {
    const lg = f?.leagues as Lg | Lg[] | undefined;
    return Array.isArray(lg) ? lg[0] : lg;
  };
  const dv = new Map((deliveries ?? []).map((d) => [(d as { id: string }).id, d as { criteria: Record<string, unknown> }]));

  // SportyBet booking codes per day. RLS returns codes only to admins + active admitted members, so
  // non-members get none. Keyed by the card's set_date; the owner uploads them from /analytics.
  const codeDates = [...new Set(picked.map((d) => String(d.set_date)))];
  const { data: codeRows } = codeDates.length
    ? await supabase.from("school_codes").select("set_date, code").in("set_date", codeDates)
    : { data: [] as { set_date: string; code: string }[] };
  const codeByDate = new Map((codeRows ?? []).map((c) => [String(c.set_date), String(c.code)]));

  const mapped: SchoolRecord[] = picked.map((d) => {
    const legs = (d.legs as Array<Record<string, unknown>>).map((l) => {
      const fid = Number(l.fixture_id);
      const f = fx.get(fid);
      const del = dv.get(String(l.delivery_id));
      const model = (del?.criteria as { reasons?: { model?: { over25?: number } } } | undefined)?.reasons?.model;
      const over25 = model?.over25 ?? null;
      // the leg's line: admin override, else the default Over 2.5
      const pick = pickOf.get(fid);
      const market = pick?.market ?? "over_2_5";
      const need = NEED[market] ?? 3;
      // odds: real (admin-entered) wins; else the model estimate — which only prices Over 2.5
      const estOdds = market === "over_2_5" && over25 && over25 > 0 ? Math.round((1 / over25) * 100) / 100 : null;
      const real = pick?.odds ?? null;
      const odds = real ?? estOdds;
      const oddsReal = real != null;
      const statusStr = f ? String(f.status ?? "") : "";
      const finished = FINISHED.includes(statusStr);
      const inPlay = LIVE.includes(statusStr);
      const h = f ? ((f.ft_home ?? f.home_goals) as number | null) : null;
      const a = f ? ((f.ft_away ?? f.away_goals) as number | null) : null;
      const curTot = h != null && a != null ? h + a : null;
      // over lines are monotonic — WON the instant the line is cleared (live OR FT); LOST only at FT under.
      const hit = curTot != null && curTot >= need ? true : finished ? false : null;
      const lg = leagueOf(f);
      return {
        game: String(l.game ?? ""),
        fixtureId: fid,
        market,
        odds,
        oddsReal,
        score: (finished || inPlay) && h != null && a != null ? `${h}-${a}` : null,
        hit,
        elapsed: inPlay ? ((f?.elapsed as number | null) ?? null) : null,
        // raw status + updated_at let the client tick the live minute up between 60s refreshes
        status: statusStr || null,
        updatedAt: (f?.updated_at as string | null) ?? null,
        finished,
        kickoff: (f?.kickoff_utc as string | null) ?? null,
        league: lg?.name ?? null,
        flag: lg?.flag_url ?? null,
        tier: lg?.tier ?? null,
      };
    });
    const combined = Math.round(legs.reduce((p, l) => p * (l.odds ?? 1), 1) * 100) / 100;
    const graded = legs.every((l) => l.hit != null && l.odds != null);
    const result: "won" | "lost" | "pending" = !graded ? "pending" : legs.every((l) => l.hit) ? "won" : "lost";
    return { date: String(d.set_date), legs, combined, result, code: codeByDate.get(String(d.set_date)) ?? null };
  });

  // record = graded days only, oldest → newest so cumulative P/L reads left to right
  const records = mapped.filter((r) => r.result !== "pending").reverse();
  // today's double stays pinned as "today" whether it's not-started, live, or already settled — it only
  // falls back to the newest pending day (or nothing) when there's no double for today's date.
  const todayLagos = new Date().toLocaleDateString("en-CA", { timeZone: "Africa/Lagos" });
  const upcoming = mapped.find((r) => r.date === todayLagos) ?? mapped.find((r) => r.result === "pending") ?? null;

  // live game(s) in today's card → poll for fresh scores/minute (RealtimeRefresh runs a 60s render)
  const liveIds = upcoming ? upcoming.legs.filter((l) => l.elapsed != null && !l.finished).map((l) => l.fixtureId) : [];

  // today's card is a draft only the owner sees until "Post now" flips it live for members
  let todayPosted = false;
  if (upcoming) {
    const { data: postRow } = await supabase.from("school_posts").select("set_date").eq("set_date", upcoming.date).maybeSingle();
    todayPosted = !!postRow;
  }

  // sell stats — stake-independent, so they read the same at any stake (for the funnel proof)
  const wins = records.filter((r) => r.result === "won").length;
  const losses = records.length - wins;
  const profitUnits = records.reduce((a, r) => a + (r.result === "won" ? r.combined - 1 : -1), 0);
  const roi = records.length ? Math.round((profitUnits / records.length) * 100) : 0;

  // Members (and admins) get the dashboard; everyone else gets the induction funnel.
  if (admitted) {
    return (
      <div className="pb-24">
        {isAdmin && (
          <div className="mx-auto mt-6 max-w-[960px] px-5 md:px-8">
            <SchoolAdmin />
          </div>
        )}
        <SchoolMember records={records} upcoming={upcoming} admin={isAdmin} todayPosted={todayPosted} />
        {liveIds.length > 0 && <RealtimeRefresh fixtureIds={liveIds} />}
      </div>
    );
  }

  return (
    <div className="pb-24">
      {previewGuest && (
        <div className="mx-auto mt-6 flex max-w-[520px] items-center justify-between gap-3 px-5">
          <span className="rounded-full border border-flood/40 bg-flood/10 px-3 py-1 font-mono text-[10.5px] uppercase tracking-wide text-flood">
            Previewing as a non-member
          </span>
          <a href="/school" className="font-mono text-[10.5px] text-onpitch-mute underline hover:text-chalk">
            Exit preview
          </a>
        </div>
      )}
      <SchoolFunnel
        wins={wins}
        losses={losses}
        roi={roi}
        days={records.length}
        records={records}
        price={SCHOOL_PRICE}
        bank={SCHOOL_BANK}
        enroll={<SchoolEnroll userId={user.id} price={SCHOOL_PRICE} bank={SCHOOL_BANK} initialStatus={enrollStatus} />}
      />
    </div>
  );
}
