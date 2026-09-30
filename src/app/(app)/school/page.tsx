import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { SchoolFunnel, SchoolMember, type SchoolRecord, type SchoolLeg } from "@/components/SchoolBoard";
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
// never-played statuses — a leg in one of these is VOIDED from a slip (opt-in per strategy)
const VOID = ["PST", "CANC", "ABD"];
// over-lines only: goals needed to clear each line (Over 2.5 -> 3, Over 3.5 -> 4, …)
const NEED: Record<string, number> = { over_0_5: 1, over_1_5: 2, over_2_5: 3, over_3_5: 4, over_4_5: 5 };

// The model outputs FAIR (no-vig) probabilities; a naive 1/prob therefore reads too long vs a real
// book, which prices with an overround (our DC 1X on a mid favourite showed ~1.28 where the book had
// ~1.21). Nudge the implied prob up by a typical ~6% margin (capped so a heavy favourite can't imply
// an unquotable sub-1.03 price) so model estimates sit closer to the truth. Real admin-entered odds
// (school_leg_odds) are never routed through this — only model estimates.
const ODDS_MARGIN = 1.06;
const modelOdds = (prob: number | null | undefined): number | null =>
  prob != null && prob > 0 ? Math.round((1 / Math.min(0.97, prob * ODDS_MARGIN)) * 100) / 100 : null;

// Estimate the Over 3.5 chance from the model's Over 2.5 chance by inverting Poisson: solve for the
// goal rate λ that reproduces P(3+ goals) = pO25, then read off P(4+ goals). Used only to PRICE an
// Over 3.5 upgrade on games the bookmaker doesn't quote (no real Over 3.5 to show) — shown as a "~"
// estimate. Principled (a single scoring rate), not a made-up multiplier.
const over35FromOver25 = (pO25: number | null | undefined): number | null => {
  if (pO25 == null || pO25 <= 0) return null;
  if (pO25 >= 0.999) return 0.97; // essentially certain — cap
  let lo = 0, hi = 25;
  for (let i = 0; i < 50; i++) {
    const l = (lo + hi) / 2;
    const pge3 = 1 - Math.exp(-l) * (1 + l + (l * l) / 2); // P(X>=3)
    if (pge3 < pO25) lo = l; else hi = l;
  }
  const l = (lo + hi) / 2;
  const pge4 = 1 - Math.exp(-l) * (1 + l + (l * l) / 2 + (l * l * l) / 6); // P(X>=4)
  return Math.max(0.01, Math.min(0.97, pge4));
};

// Displayed price waterfall: (1) an admin-typed real odd, (2) the REAL median bookmaker odd from the
// API (school_book_odds, sourced from odds_snapshot), (3) the model estimate as a last resort. The
// first two are real prices (oddsReal = true, shown plainly); the estimate shows with a "~" prefix.
// DISPLAY-ONLY — none of this feeds selection, grading or settlement.
const priceLeg = (
  prob: number | null,
  adminOdd: number | null | undefined,
  bookOdd: number | null | undefined
): { odds: number | null; oddsReal: boolean } => {
  if (adminOdd != null && adminOdd > 1) return { odds: adminOdd, oddsReal: true };
  if (bookOdd != null && bookOdd > 1) return { odds: bookOdd, oddsReal: true };
  return { odds: modelOdds(prob), oddsReal: false };
};

// One flat leg row from school_strategy_legs() (the two candidate School lines, ranked top-N per day).
type StratRow = {
  strategy: string; dt: string; fixture_id: number; rnk: number; market: string; prob: number | null;
  home_team: string; away_team: string; ft_home: number | null; ft_away: number | null;
  home_goals: number | null; away_goals: number | null; status: string | null; elapsed: number | null;
  updated_at: string | null; kickoff_utc: string | null; league: string | null; flag: string | null; tier: string | null;
  relaxed?: boolean | null; // true when fewer than 2 legs cleared the >=1.45 odds floor (may pay < 2.0)
};

// Assemble the flat ranked rows into SchoolRecord[] + today's card — the SAME shape the onside_double
// deck uses — so the forward-test lab renders through the real SchoolMember view. Over-line legs clear
// monotonically (WON the instant the goals land); DC 1X settles only at FT (a lead can be lost).
// minN/maxN let a line be either a fixed-leg acca (over25: 2/2, dc1x: 3/3) or a variable "min 2, up to 3"
// lock acca — take up to maxN of the day's ranked legs, but only count the day if at least minN qualified.
function buildStrategy(rows: StratRow[], minN: number, maxN: number, todayLagos: string, voidPostponed = false, bookOf: Map<string, number> = new Map(), adminOf: Map<number, { odds: number | null; market: string | null }> = new Map()): { records: SchoolRecord[]; upcoming: SchoolRecord | null } {
  const byDay = new Map<string, StratRow[]>();
  for (const r of rows) {
    const arr = byDay.get(r.dt);
    if (arr) arr.push(r);
    else byDay.set(r.dt, [r]);
  }
  const mapped: SchoolRecord[] = [];
  for (const [dt, allRows] of byDay) {
    // void postponed/cancelled/abandoned legs (they never settle) so the day grades on the rest — a
    // rained-off leg shouldn't freeze the slip forever. Only the combined tab opts into this.
    // ALSO void ungradeable legs: an obscure reserve game that finished but whose SCORE never synced
    // (common in the Over 2.5 pool's minor leagues) can't be judged — counting it as a loss would lie.
    // Drop it so the day grades only on legs we can actually settle (owner-directed 2026-09-28).
    const ungradeable = (r: StratRow) => FINISHED.includes(r.status ?? "") && (r.ft_home ?? r.home_goals) == null;
    const dayRows = (voidPostponed ? allRows.filter((r) => !VOID.includes(r.status ?? "")) : allRows).filter((r) => !ungradeable(r));
    const legsRows = dayRows.slice().sort((a, b) => a.rnk - b.rnk).slice(0, maxN);
    if (legsRows.length < minN) continue; // need at least minN gradeable legs to form the day's acca
    const legs: SchoolLeg[] = legsRows.map((r) => {
      const statusStr = r.status ?? "";
      const finished = FINISHED.includes(statusStr);
      const inPlay = LIVE.includes(statusStr);
      const h = r.ft_home ?? r.home_goals;
      const a = r.ft_away ?? r.away_goals;
      const curTot = h != null && a != null ? h + a : null;
      // Admin override (school_set_leg_pick) wins on everything — outcome + odds the admin typed for this
      // game. Otherwise the Over 2.5 -> Over 3.5 auto-upgrade (owner-directed 2026-09-28): when Over 2.5 is
      // priced 1.11 or below the game is so high-scoring that Over 2.5 pays almost nothing — bet Over 3.5
      // instead (real book odd if quoted, else the ~ estimate derived from the Over 2.5 chance).
      const adm = adminOf.get(r.fixture_id);
      const origProb = r.prob != null && r.prob > 0 ? Number(r.prob) : null;
      let market = r.market;
      if (adm?.market) {
        market = adm.market; // admin explicitly chose the outcome — respect it, skip the auto-upgrade
      } else if (market === "over_2_5") {
        const dispO25 = bookOf.get(`${r.fixture_id}:over_2_5`) ?? modelOdds(origProb);
        if (dispO25 != null && dispO25 <= 1.11) market = "over_3_5";
      }
      // model-estimate fallback prob: an Over 3.5 derived from an Over 2.5 pick is priced off its own chance
      const priceProb = market === "over_3_5" && r.market === "over_2_5" ? over35FromOver25(origProb) : origProb;
      const need = NEED[market] ?? 3;
      const hit =
        market === "dc_1x"
          ? finished && h != null && a != null ? h >= a : null // DC 1X: home win or draw, judged at FT
          : market === "home"
            ? finished && h != null && a != null ? h > a : null // Home Win: judged at FT
            : curTot != null && curTot >= need ? true : finished ? false : null; // over-line: monotonic
      const { odds, oddsReal } = priceLeg(priceProb, adm?.odds ?? null, bookOf.get(`${r.fixture_id}:${market}`));
      return {
        game: `${r.home_team} v ${r.away_team}`,
        fixtureId: r.fixture_id,
        market,
        odds,
        oddsReal, // real median book odd when banked, else the model estimate
        score: (finished || inPlay) && h != null && a != null ? `${h}-${a}` : null,
        hit,
        elapsed: inPlay ? r.elapsed : null,
        status: statusStr || null,
        updatedAt: r.updated_at,
        finished,
        kickoff: r.kickoff_utc,
        league: r.league,
        flag: r.flag,
        tier: r.tier,
      };
    });
    const combined = Math.round(legs.reduce((p, l) => p * (l.odds ?? 1), 1) * 100) / 100;
    const result: "won" | "lost" | "pending" =
      legs.some((l) => l.hit === false) ? "lost" : legs.every((l) => l.hit === true) ? "won" : "pending";
    // thin day: the odds floor couldn't be met, so the double may pay under 2.0 (flagged on the slip)
    const relaxed = legsRows.some((r) => r.relaxed === true);
    mapped.push({ date: dt, legs, combined, result, relaxed });
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

  // The Onside School bet IS the Best Over 2.5 double (owner-ruled 2026-09-28: it won the forward-test,
  // so it's now the live member line — the old hand-set double and the other candidate tabs are retired).
  // Legs, record and today's pick all come from school_daily_over25(): the owner's two highest-model-Over-2.5
  // picks per day (Over 0.5 signal pool since Sep 7), graded Over 2.5, with the <=1.11 -> Over 3.5 upgrade.
  const todayLagos = new Date().toLocaleDateString("en-CA", { timeZone: "Africa/Lagos" });
  const { data: dailyRows } = await supabase.rpc("school_daily_over25");
  const stratRows = (dailyRows ?? []) as StratRow[];
  const fixtureIds = [...new Set(stratRows.map((r) => Number(r.fixture_id)))];
  const [{ data: bookRows }, { data: legPicks }] = await Promise.all([
    fixtureIds.length ? supabase.rpc("school_book_odds", { p_fixture_ids: fixtureIds }) : Promise.resolve({ data: [] as never[] }),
    fixtureIds.length ? supabase.from("school_leg_odds").select("fixture_id, odds, market").in("fixture_id", fixtureIds) : Promise.resolve({ data: [] as never[] }),
  ]);
  const bookOf = new Map<string, number>();
  for (const r of (bookRows ?? []) as Array<{ fixture_id: number; market: string; book_odds: number | null }>) {
    if (r.book_odds != null) bookOf.set(`${Number(r.fixture_id)}:${r.market}`, Number(r.book_odds));
  }
  const adminOf = new Map<number, { odds: number | null; market: string | null }>();
  for (const r of (legPicks ?? []) as Array<{ fixture_id: number; odds: number | null; market: string | null }>) {
    adminOf.set(Number(r.fixture_id), { odds: r.odds == null ? null : Number(r.odds), market: r.market ?? null });
  }
  const built = buildStrategy(stratRows, 2, 2, todayLagos, false, bookOf, adminOf);
  // SportyBet booking codes per day (RLS returns codes only to admins + admitted members)
  const codeDates = [...new Set([...built.records.map((r) => r.date), ...(built.upcoming ? [built.upcoming.date] : [])])];
  const { data: codeRows } = codeDates.length
    ? await supabase.from("school_codes").select("set_date, code").in("set_date", codeDates)
    : { data: [] as { set_date: string; code: string }[] };
  const codeByDate = new Map((codeRows ?? []).map((c) => [String(c.set_date), String(c.code)]));
  const withCode = (r: SchoolRecord): SchoolRecord => ({ ...r, code: codeByDate.get(r.date) ?? null });
  const records = built.records.map(withCode);
  const upcoming = built.upcoming ? withCode(built.upcoming) : null;

  // live game(s) in today's card → poll for fresh scores/minute (RealtimeRefresh runs a 60s render)
  const liveIds = upcoming ? upcoming.legs.filter((l) => l.elapsed != null && !l.finished).map((l) => l.fixtureId) : [];

  // already added today's double to their tracker? keeps the Track button in its "added" state after a refresh
  let todayTracked = false;
  if (upcoming && upcoming.legs.length) {
    const fxIds = upcoming.legs.map((l) => l.fixtureId);
    const { data: myTix } = await supabase
      .from("tickets")
      .select("fixture_id, market_key")
      .eq("user_id", user.id)
      .in("fixture_id", fxIds)
      // no status filter: a leg whose game has already settled is still "tracked" — else the button
      // wrongly reappears once one of the two games finishes (its ticket flips pending → won/lost)
      .not("tracker_hidden", "is", true);
    todayTracked = upcoming.legs.every((l) => (myTix ?? []).some((t) => t.fixture_id === l.fixtureId && t.market_key === l.market));
  }

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

  // Members (and admins) get the dashboard; everyone else gets the induction funnel. The School bet is a
  // single line now — the Best Over 2.5 double — rendered through the real member deck. Admins get the
  // same view with per-leg editing (odds + outcome) and the post-to-members control; members see it live.
  if (admitted) {
    return (
      <div className="pb-24">
        {isAdmin && (
          <div className="mx-auto mt-6 max-w-[960px] px-5 md:px-8">
            <SchoolAdmin />
          </div>
        )}
        <div className={isAdmin ? "mx-auto mt-2 max-w-[960px] px-5 md:px-8" : ""}>
          <SchoolMember
            records={records}
            upcoming={upcoming}
            admin={isAdmin}
            todayPosted={todayPosted}
            userId={user.id}
            todayTracked={todayTracked}
            heading="Best Over 2.5 · double"
            canPost={isAdmin}
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
