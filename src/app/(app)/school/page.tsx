import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { SchoolFunnel, SchoolMember, type SchoolRecord, type SchoolLeg } from "@/components/SchoolBoard";
import SchoolEnroll from "@/components/SchoolEnroll";
import SchoolAdmin from "@/components/SchoolAdmin";
import SchoolPickBuilder, { type TodayPick } from "@/components/SchoolPickBuilder";
import RealtimeRefresh from "@/components/RealtimeRefresh";
import { SCHOOL_OPEN, SCHOOL_PRICE, SCHOOL_BANK } from "@/lib/school";

// Onside School — the VVIP daily banker. The admin hand-builds each day's slip in the pick card
// (match + outcome + odds → school_picks); every leg auto-grades hit/miss from the fixture score and
// rolls into the monthly record. Non-members get the induction funnel + join flow; admitted members
// (and admins) get today's slip + the full record browsable by month. The settled stats seed the funnel.
export const dynamic = "force-dynamic"; // the record grows daily

const FINISHED = ["FT", "AET", "PEN"];
const LIVE = ["1H", "HT", "2H", "ET", "BT", "P", "LIVE", "INT", "SUSP"];

// Auto-grade a School pick from the match score. Over / BTTS-Yes / to-score win the instant the
// condition is met (monotonic); Under (.5 lines) / BTTS-No lose the instant they're busted; result &
// double-chance settle at full-time. Asian whole-number unders (Under 4/5/6) PUSH — stake back — when
// the total lands exactly on the line. "pending" = not decided yet.
type PickResult = "won" | "lost" | "push" | "pending";
function gradePick(market: string, h: number | null, a: number | null, finished: boolean): PickResult {
  if (h == null || a == null) return "pending";
  const tot = h + a;
  const over = (need: number): PickResult => (tot >= need ? "won" : finished ? "lost" : "pending");
  const under = (bust: number): PickResult => (tot >= bust ? "lost" : finished ? "won" : "pending"); // .5 line
  // Asian whole line: over the line loses (even live); exactly the line at FT pushes; under it at FT wins.
  const asianUnder = (line: number): PickResult => (tot > line ? "lost" : finished ? (tot === line ? "push" : "won") : "pending");
  switch (market) {
    case "over_0_5": return over(1);
    case "over_1_5": return over(2);
    case "over_2_5": return over(3);
    case "over_3_5": return over(4);
    case "over_4_5": return over(5);
    case "under_1_5": return under(2);
    case "under_2_5": return under(3);
    case "under_3_5": return under(4);
    case "under_4_5": return under(5);
    case "under_4": return asianUnder(4);
    case "under_5": return asianUnder(5);
    case "under_6": return asianUnder(6);
    case "btts_yes": return h > 0 && a > 0 ? "won" : finished ? "lost" : "pending";
    case "btts_no": return h > 0 && a > 0 ? "lost" : finished ? "won" : "pending";
    case "home_ts": return h > 0 ? "won" : finished ? "lost" : "pending";
    case "away_ts": return a > 0 ? "won" : finished ? "lost" : "pending";
    case "home": return finished ? (h > a ? "won" : "lost") : "pending";
    case "draw": return finished ? (h === a ? "won" : "lost") : "pending";
    case "away": return finished ? (a > h ? "won" : "lost") : "pending";
    case "dc_1x": return finished ? (h >= a ? "won" : "lost") : "pending";
    case "dc_12": return finished ? (h !== a ? "won" : "lost") : "pending";
    case "dc_x2": return finished ? (a >= h ? "won" : "lost") : "pending";
    default: return "pending";
  }
}

type PickRow = { id: string; set_date: string; fixture_id: number; market: string; label: string; odds: number };
type FxRow = {
  id: number; home_team: string; away_team: string;
  ft_home: number | null; ft_away: number | null; home_goals: number | null; away_goals: number | null;
  status: string | null; elapsed: number | null; updated_at: string | null; kickoff_utc: string | null;
  leagues: { name: string | null; flag_url: string | null; tier: string | null } | null;
};

// Group the manual pick rows into one SchoolRecord per day (a day = one slip), grade each leg off its
// fixture, and pick out today's slip. Odds are the admin-typed real prices (oddsReal = true).
function buildFromPicks(picks: PickRow[], fxById: Map<number, FxRow>, todayLagos: string): { records: SchoolRecord[]; upcoming: SchoolRecord | null } {
  const byDay = new Map<string, PickRow[]>();
  for (const p of picks) {
    const arr = byDay.get(p.set_date);
    if (arr) arr.push(p);
    else byDay.set(p.set_date, [p]);
  }
  const mapped: SchoolRecord[] = [];
  for (const [dt, dayPicks] of byDay) {
    const legs: SchoolLeg[] = dayPicks.map((p) => {
      const f = fxById.get(Number(p.fixture_id));
      const statusStr = f?.status ?? "";
      const finished = FINISHED.includes(statusStr);
      const inPlay = LIVE.includes(statusStr);
      const h = f ? (f.ft_home ?? f.home_goals) : null;
      const a = f ? (f.ft_away ?? f.away_goals) : null;
      // an Asian-line push voids the leg: odds → 1.0 (stake back), counts as "safe" so the slip settles on the rest
      const res = gradePick(p.market, h, a, finished);
      const push = res === "push";
      return {
        game: f ? `${f.home_team} v ${f.away_team}` : "—",
        fixtureId: Number(p.fixture_id),
        market: p.market,
        odds: push ? 1 : Number(p.odds),
        oddsReal: true, // admin typed the real price
        score: (finished || inPlay) && h != null && a != null ? `${h}-${a}` : null,
        hit: push ? true : res === "won" ? true : res === "lost" ? false : null,
        elapsed: inPlay ? f?.elapsed ?? null : null,
        status: statusStr || null,
        updatedAt: f?.updated_at ?? null,
        finished,
        kickoff: f?.kickoff_utc ?? null,
        league: f?.leagues?.name ?? null,
        flag: f?.leagues?.flag_url ?? null,
        tier: f?.leagues?.tier ?? null,
      };
    });
    const combined = Math.round(legs.reduce((pr, l) => pr * (l.odds ?? 1), 1) * 100) / 100;
    const result: "won" | "lost" | "pending" =
      legs.some((l) => l.hit === false) ? "lost" : legs.length > 0 && legs.every((l) => l.hit === true) ? "won" : "pending";
    mapped.push({ date: dt, legs, combined, result });
  }
  mapped.sort((x, y) => (x.date < y.date ? 1 : -1)); // newest first
  const records = mapped.filter((r) => r.result !== "pending").reverse(); // oldest → newest for cumulative P/L
  const upcoming = mapped.find((r) => r.date === todayLagos) ?? mapped.find((r) => r.result === "pending") ?? null;
  return { records, upcoming };
}

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

  // Owner-only preview: ?preview=guest renders the exact non-member experience (the induction funnel).
  const previewGuest = realAdmin && (await searchParams)?.preview === "guest";
  const isAdmin = realAdmin && !previewGuest;

  // Membership: an active admitted enrollment (or admin) unlocks the member dashboard.
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

  // The record + today's slip come from the manual pick book (school_picks): the admin's hand-picked
  // legs per day, auto-graded off each fixture's score.
  const todayLagos = new Date().toLocaleDateString("en-CA", { timeZone: "Africa/Lagos" });
  const { data: pickRows } = await supabase
    .from("school_picks")
    .select("id, set_date, fixture_id, market, label, odds")
    .order("set_date", { ascending: false });
  const picks = (pickRows ?? []) as PickRow[];
  const pickFxIds = [...new Set(picks.map((p) => Number(p.fixture_id)))];
  const { data: fxRows } = pickFxIds.length
    ? await supabase
        .from("fixtures")
        .select("id, home_team, away_team, ft_home, ft_away, home_goals, away_goals, status, elapsed, updated_at, kickoff_utc, leagues(name, flag_url, tier)")
        .in("id", pickFxIds)
    : { data: [] as never[] };
  const fxById = new Map<number, FxRow>();
  for (const f of (fxRows ?? []) as unknown as FxRow[]) fxById.set(Number(f.id), f);

  const built = buildFromPicks(picks, fxById, todayLagos);

  // SportyBet booking codes per day (RLS returns codes only to admins + admitted members)
  const codeDates = [...new Set([...built.records.map((r) => r.date), ...(built.upcoming ? [built.upcoming.date] : [])])];
  const { data: codeRows } = codeDates.length
    ? await supabase.from("school_codes").select("set_date, code").in("set_date", codeDates)
    : { data: [] as { set_date: string; code: string }[] };
  const codeByDate = new Map((codeRows ?? []).map((c) => [String(c.set_date), String(c.code)]));
  const withCode = (r: SchoolRecord): SchoolRecord => ({ ...r, code: codeByDate.get(r.date) ?? null });
  const records = built.records.map(withCode);
  const upcoming = built.upcoming ? withCode(built.upcoming) : null;

  // today's picks feed the admin builder's "today's slip" list
  const todayPicksForBuilder: TodayPick[] = picks
    .filter((p) => p.set_date === todayLagos)
    .map((p) => {
      const f = fxById.get(Number(p.fixture_id));
      return { id: p.id, fixture_id: Number(p.fixture_id), game: f ? `${f.home_team} v ${f.away_team}` : "—", label: p.label, odds: Number(p.odds) };
    });

  // live game(s) in today's slip → poll for fresh scores/minute (RealtimeRefresh runs a 60s render)
  const liveIds = upcoming ? upcoming.legs.filter((l) => l.elapsed != null && !l.finished).map((l) => l.fixtureId) : [];

  // sell stats — stake-independent, for the funnel proof
  const wins = records.filter((r) => r.result === "won").length;
  const losses = records.length - wins;
  const profitUnits = records.reduce((a, r) => a + (r.result === "won" ? r.combined - 1 : -1), 0);
  const roi = records.length ? Math.round((profitUnits / records.length) * 100) : 0;

  // Members (and admins) get the dashboard; everyone else gets the induction funnel. Admins also get the
  // pick-builder card above the record to hand-build today's slip.
  if (admitted) {
    return (
      <div className="pb-24">
        {isAdmin && (
          <div className="mx-auto mt-6 flex max-w-[960px] flex-col gap-4 px-5 md:px-8">
            <SchoolAdmin />
            <SchoolPickBuilder setDate={todayLagos} picks={todayPicksForBuilder} />
          </div>
        )}
        <div className={isAdmin ? "mx-auto mt-2 max-w-[960px] px-5 md:px-8" : ""}>
          <SchoolMember
            records={records}
            upcoming={upcoming}
            admin={false}
            todayPosted={true}
            userId={user.id}
            todayTracked={false}
            hideTrack
            heading="Onside School"
            noun="slip"
            canPost={false}
          />
        </div>
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
