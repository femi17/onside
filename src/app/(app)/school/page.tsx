import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { SchoolFunnel, SchoolMember, type SchoolRecord, type SchoolLeg } from "@/components/SchoolBoard";
import SchoolEnroll from "@/components/SchoolEnroll";
import SchoolAdmin from "@/components/SchoolAdmin";
import SchoolStrategyDeck, { type StrategyView } from "@/components/SchoolStrategyDeck";
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

// One flat leg row from school_strategy_legs() (the two candidate School lines, ranked top-N per day).
type StratRow = {
  strategy: string; dt: string; fixture_id: number; rnk: number; market: string; prob: number | null;
  home_team: string; away_team: string; ft_home: number | null; ft_away: number | null;
  home_goals: number | null; away_goals: number | null; status: string | null; elapsed: number | null;
  updated_at: string | null; kickoff_utc: string | null; league: string | null; flag: string | null; tier: string | null;
};

// Assemble the flat ranked rows into SchoolRecord[] + today's card — the SAME shape the onside_double
// deck uses — so the forward-test lab renders through the real SchoolMember view. Over-line legs clear
// monotonically (WON the instant the goals land); DC 1X settles only at FT (a lead can be lost).
// minN/maxN let a line be either a fixed-leg acca (over25: 2/2, dc1x: 3/3) or a variable "min 2, up to 3"
// lock acca — take up to maxN of the day's ranked legs, but only count the day if at least minN qualified.
function buildStrategy(rows: StratRow[], minN: number, maxN: number, todayLagos: string, voidPostponed = false): { records: SchoolRecord[]; upcoming: SchoolRecord | null } {
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
    const dayRows = voidPostponed ? allRows.filter((r) => !VOID.includes(r.status ?? "")) : allRows;
    const legsRows = dayRows.slice().sort((a, b) => a.rnk - b.rnk).slice(0, maxN);
    if (legsRows.length < minN) continue; // need at least minN legs to form the day's acca
    const legs: SchoolLeg[] = legsRows.map((r) => {
      const statusStr = r.status ?? "";
      const finished = FINISHED.includes(statusStr);
      const inPlay = LIVE.includes(statusStr);
      const h = r.ft_home ?? r.home_goals;
      const a = r.ft_away ?? r.away_goals;
      const curTot = h != null && a != null ? h + a : null;
      const need = NEED[r.market] ?? 3;
      const hit =
        r.market === "dc_1x"
          ? finished && h != null && a != null ? h >= a : null // DC 1X: home win or draw, judged at FT
          : r.market === "home"
            ? finished && h != null && a != null ? h > a : null // Home Win: judged at FT
            : curTot != null && curTot >= need ? true : finished ? false : null; // over-line: monotonic
      const prob = r.prob != null && r.prob > 0 ? Number(r.prob) : null;
      const odds = modelOdds(prob);
      return {
        game: `${r.home_team} v ${r.away_team}`,
        fixtureId: r.fixture_id,
        market: r.market,
        odds,
        oddsReal: false, // model estimate until real prices bank in
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
      const estOdds = market === "over_2_5" ? modelOdds(over25) : null;
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
    // An Over 2.5 double is LOST the instant ANY leg finishes under 3 goals — a later leg can't
    // resurrect it — so show it lost immediately even if the other game hasn't kicked off (the
    // tracker already grades this way). Won only when every leg has hit; pending only while nothing
    // has failed yet. Odds may be null on an un-priced leg, but that must never hold up a settled
    // result (the old `graded` check left a lost double showing "Not started" until BOTH legs ended).
    const result: "won" | "lost" | "pending" =
      legs.some((l) => l.hit === false) ? "lost"
      : legs.length > 0 && legs.every((l) => l.hit === true) ? "won"
      : "pending";
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

  // Owner-only forward-test lab: the 3 candidate School lines, each rendered through the real member
  // deck. Line 1 = the live Onside Double (records/upcoming above). Lines 2-3 come from the admin-gated
  // school_strategy_legs() RPC (empty for non-admins). A stored default (school_config) picks the active
  // tab on load and is what the daily DM / a future member view follows.
  let strategyViews: StrategyView[] = [];
  let defaultKey = "school_double";
  if (isAdmin) {
    const [{ data: stratRows }, { data: cfg }] = await Promise.all([
      supabase.rpc("school_strategy_legs"),
      supabase.from("school_config").select("default_strategy").maybeSingle(),
    ]);
    const rows = (stratRows ?? []) as StratRow[];
    const over25 = buildStrategy(rows.filter((r) => r.strategy === "best_over25"), 2, 2, todayLagos);
    const dc1x = buildStrategy(rows.filter((r) => r.strategy === "dc1x_treble"), 3, 3, todayLagos);
    // Lock acca: bettable DC 1X locks (≤1.35), 2–3 legs, crushing favourites swapped to Home Win.
    const lock = buildStrategy(rows.filter((r) => r.strategy === "lock_acca"), 2, 3, todayLagos);
    // Cascade: same locks across ALL leagues, per-leg market 1X → Home (if 1X<1.20) → Over 2.5 (if home<1.10).
    const cascade = buildStrategy(rows.filter((r) => r.strategy === "lock_cascade"), 2, 3, todayLagos);
    // Combined: DC 1X treble ∪ Lock Acca merged into one slip/day (variable legs — take all). Postponed
    // legs void so the day grades on the rest (e.g. Sep 13's rained-off FAS v Alianza settles on its others).
    const combo = buildStrategy(rows.filter((r) => r.strategy === "dc_lock_combo"), 1, 99, todayLagos, true);
    strategyViews = [
      { key: "school_double", name: "Onside Double · O2.5", noun: "double", records, upcoming },
      { key: "best_over25", name: "Best Over 2.5 · double", noun: "double", records: over25.records, upcoming: over25.upcoming },
      { key: "dc1x_treble", name: "DC 1X · treble", noun: "treble", records: dc1x.records, upcoming: dc1x.upcoming },
      { key: "lock_acca", name: "Lock Acca · 1X + Home", noun: "acca", records: lock.records, upcoming: lock.upcoming },
      { key: "lock_cascade", name: "Cascade · 1X→Home→O2.5", noun: "acca", records: cascade.records, upcoming: cascade.upcoming },
      { key: "dc_lock_combo", name: "DC 1X + Lock Acca · combined", noun: "acca", records: combo.records, upcoming: combo.upcoming },
    ];
    defaultKey = (cfg?.default_strategy as string) ?? "school_double";
  }

  // Members (and admins) get the dashboard; everyone else gets the induction funnel.
  if (admitted) {
    return (
      <div className="pb-24">
        {isAdmin ? (
          <>
            <div className="mx-auto mt-6 max-w-[960px] px-5 md:px-8">
              <SchoolAdmin />
            </div>
            {/* Admin's School view = the strategy lab: tabs pick the line; the WHOLE board below is that
                line rendered through the real member deck (stake input + swipe betslips). ★ sets the default. */}
            <SchoolStrategyDeck
              strategies={strategyViews}
              defaultKey={defaultKey}
              userId={user.id}
              admin={isAdmin}
              todayPosted={todayPosted}
              todayTracked={todayTracked}
            />
          </>
        ) : (
          <SchoolMember records={records} upcoming={upcoming} admin={false} todayPosted={todayPosted} userId={user.id} todayTracked={todayTracked} />
        )}
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
