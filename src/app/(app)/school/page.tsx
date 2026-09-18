import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import StickyHeader from "@/components/StickyHeader";
import MobileLogo from "@/components/MobileLogo";
import SchoolBoard, { type SchoolRecord } from "@/components/SchoolBoard";
import SchoolStory from "@/components/SchoolStory";
import SchoolEnroll from "@/components/SchoolEnroll";
import SchoolAdmin from "@/components/SchoolAdmin";
import { SCHOOL_OPEN, SCHOOL_PRICE, SCHOOL_BANK } from "@/lib/school";

// Onside School — the VVIP daily banker: the Onside Double, played as its two Over 2.5 legs.
// The record here is REAL: each row is an actual Onside Double, regraded as an Over 2.5 double
// (wins only if BOTH games go 3+ goals). Per-leg odds are the model's Over 2.5 price (1/prob).
//
// Tiers: the settled record + story are visible to everyone (the motivation to join); today's
// upcoming pick is unlocked only for admitted (paying) members. Non-members get a blurred teaser
// + the bank-transfer join flow, and admins review receipts in the panel at the top.
export const dynamic = "force-dynamic"; // the record grows daily

const FINISHED = ["FT", "AET", "PEN"];
const LIVE = ["1H", "HT", "2H", "ET", "BT", "P", "LIVE", "INT", "SUSP"];

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

  // Owner-only preview: ?preview=guest renders the exact non-member experience (story + locked pick +
  // join screen) so we can eyeball it without opening the pilot or changing admin status.
  const previewGuest = realAdmin && (await searchParams)?.preview === "guest";
  const isAdmin = realAdmin && !previewGuest;

  // Membership: an active admitted enrollment (or admin) unlocks the upcoming pick. Wrapped defensively
  // so the page still renders for the owner if the enrollment migration hasn't been applied yet.
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
      ? supabase
          .from("fixtures")
          .select("id, ft_home, ft_away, home_goals, away_goals, status, elapsed, kickoff_utc, leagues(name, flag_url, tier)")
          .in("id", fixtureIds)
      : Promise.resolve({ data: [] as never[] }),
    deliveryIds.length
      ? supabase.from("deliveries").select("id, criteria").in("id", deliveryIds)
      : Promise.resolve({ data: [] as never[] }),
  ]);

  const fx = new Map((fixtures ?? []).map((f) => [Number((f as { id: number }).id), f as Record<string, unknown>]));
  type Lg = { name?: string; flag_url?: string | null; tier?: string | null };
  const leagueOf = (f: Record<string, unknown> | undefined): Lg | undefined => {
    const lg = f?.leagues as Lg | Lg[] | undefined;
    return Array.isArray(lg) ? lg[0] : lg;
  };
  const dv = new Map((deliveries ?? []).map((d) => [(d as { id: string }).id, d as { criteria: Record<string, unknown> }]));

  const mapped: SchoolRecord[] = picked.map((d) => {
    const legs = (d.legs as Array<Record<string, unknown>>).map((l) => {
      const f = fx.get(Number(l.fixture_id));
      const del = dv.get(String(l.delivery_id));
      const model = (del?.criteria as { reasons?: { model?: { over25?: number } } } | undefined)?.reasons?.model;
      const over25 = model?.over25 ?? null;
      const odds = over25 && over25 > 0 ? Math.round((1 / over25) * 100) / 100 : null;
      const statusStr = f ? String(f.status ?? "") : "";
      const finished = FINISHED.includes(statusStr);
      const inPlay = LIVE.includes(statusStr);
      const h = f ? ((f.ft_home ?? f.home_goals) as number | null) : null;
      const a = f ? ((f.ft_away ?? f.away_goals) as number | null) : null;
      const curTot = h != null && a != null ? h + a : null;
      // Over 2.5 is monotonic — WON the instant 3 goals are on the board (live OR full time); LOST only
      // at full time under 3. So a leg settles early when it meets target instead of waiting for FT.
      const hit = curTot != null && curTot >= 3 ? true : finished ? false : null;
      const lg = leagueOf(f);
      return {
        game: String(l.game ?? ""),
        odds,
        score: (finished || inPlay) && h != null && a != null ? `${h}-${a}` : null,
        hit,
        elapsed: inPlay ? ((f?.elapsed as number | null) ?? null) : null,
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
    return { date: String(d.set_date), legs, combined, result };
  });

  // record = graded days only, oldest → newest so cumulative P/L reads left to right
  const records = mapped.filter((r) => r.result !== "pending").reverse();
  // upcoming = the newest not-yet-graded double (today's pick, before it plays)
  const upcoming = mapped.find((r) => r.result === "pending") ?? null;

  // sell stats — stake-independent (per-unit ROI), so they read the same at any stake
  const wins = records.filter((r) => r.result === "won").length;
  const losses = records.length - wins;
  const profitUnits = records.reduce((a, r) => a + (r.result === "won" ? r.combined - 1 : -1), 0);
  const roi = records.length ? Math.round((profitUnits / records.length) * 100) : 0;

  return (
    <div className="pb-24">
      <StickyHeader>
        <div className="mx-auto max-w-5xl px-5 pb-3 pt-6 md:px-8">
          <MobileLogo />
          <p className="font-mono text-[11px] uppercase tracking-[0.25em] text-flood">VVIP</p>
          <h1 className="mt-2 font-disp text-3xl font-bold tracking-tight text-chalk sm:text-4xl">Onside School.</h1>
        </div>
      </StickyHeader>

      {previewGuest && (
        <div className="mx-auto mb-6 flex max-w-4xl items-center justify-between gap-3 px-5 md:px-8">
          <span className="rounded-full border border-flood/40 bg-flood/10 px-3 py-1 font-mono text-[10.5px] uppercase tracking-wide text-flood">
            Previewing as a non-member
          </span>
          <a href="/school" className="font-mono text-[10.5px] text-onpitch-mute underline hover:text-chalk">
            Exit preview
          </a>
        </div>
      )}

      {(isAdmin || !admitted) && (
        <div className="mx-auto mb-8 flex max-w-4xl flex-col gap-6 px-5 md:px-8">
          {isAdmin && <SchoolAdmin />}
          {/* hook + the sell stats (Won / Lost / ROI) live on the same card */}
          {!admitted && <SchoolStory wins={wins} losses={losses} roi={roi} days={records.length} />}
        </div>
      )}

      {/* the record — everyone; today's pick leads the deck (locked for non-members). Non-members get
          the join card in the sidebar, right under the profit summary. */}
      <SchoolBoard
        records={records}
        upcoming={upcoming}
        locked={!admitted}
        joinSlot={
          !admitted ? (
            <SchoolEnroll userId={user.id} price={SCHOOL_PRICE} bank={SCHOOL_BANK} initialStatus={enrollStatus} />
          ) : null
        }
      />
    </div>
  );
}
