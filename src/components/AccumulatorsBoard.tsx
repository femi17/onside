"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { useConfirm } from "@/components/ConfirmDialog";
import { type TrackedTicket, stateOf, liveTrack, SCORE_GRADABLE, scoreGrade } from "@/lib/ticket";
import { settleFixtureByScore, voidFixture } from "@/lib/settle";
import { useMinuteTick } from "@/lib/useMinuteTick";
import { usePulse } from "@/lib/usePulse";
import type { MatchState } from "@/lib/matchState";
import StickyHeader from "@/components/StickyHeader";
import MobileLogo from "@/components/MobileLogo";

// an acca leg = a ticket + whether it's visible on the tracker (a leg removed from the
// tracker is only HIDDEN there — it stays on the slip, and can be put back)
export type AccaLeg = TrackedTicket & { tracker_hidden?: boolean | null };

export type Acca = {
  id: string;
  title: string | null;
  bookmaker: string | null;
  stake: number | null;
  potential_return: number | null;
  currency: string | null;
  leg_count: number | null;
  status: string;
  created_at: string;
  tickets: AccaLeg[];
};

type Cat = "cut" | "live" | "safe" | "soon" | "void";

const GROUPS: { cat: Cat; label: string; dot: string }[] = [
  { cat: "cut", label: "Cut", dot: "bg-brick" },
  { cat: "live", label: "Live now", dot: "bg-flood" },
  { cat: "safe", label: "Safe", dot: "bg-grass" },
  { cat: "soon", label: "Upcoming", dot: "bg-ink/30" },
  { cat: "void", label: "Void", dot: "bg-ink/25" },
];

const MK: Record<Cat, { glyph: string; cls: string }> = {
  cut: { glyph: "✕", cls: "bg-brick/15 text-brick" },
  live: { glyph: "●", cls: "bg-flood/20 text-flood-deep" },
  safe: { glyph: "✓", cls: "bg-grass/15 text-grass-deep" },
  soon: { glyph: "◷", cls: "bg-ink/[0.07] text-ink-mute" },
  void: { glyph: "–", cls: "bg-ink/[0.07] text-ink-mute" },
};

// Only the leg that actually lost is "cut". A voided leg doesn't count toward the acca (stake back)
// — call it out as "void" rather than folding it back into upcoming/live.
function legCat(leg: TrackedTicket, ms: MatchState | null): Cat {
  if (leg.status === "void") return "void";
  if (leg.status === "lost") return "cut";
  if (leg.status === "won") return "safe";
  if (leg.status === "live" || ms?.phase === "live") return "live";
  if (ms?.phase === "done") return "safe";
  return "soon";
}

const money = (cur: string | null, n: number | null) => {
  const sym = cur === "NGN" || cur == null ? "₦" : `${cur} `;
  return `${sym}${Number(n ?? 0).toLocaleString()}`;
};

// country flag + league name for a leg (UEFA competitions show a cup instead of a flag)
function LeagueTag({ lg }: { lg: { name: string; flag_url: string | null; tier: string | null } }) {
  return (
    <div className="flex min-w-0 items-center gap-1.5 font-mono text-[10px] uppercase tracking-wide text-ink-mute">
      {lg.tier === "uefa" ? (
        <span className="text-[11px] leading-none">🏆</span>
      ) : lg.flag_url ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={lg.flag_url} alt="" className="h-2.5 w-3.5 flex-none rounded-[2px] object-cover" />
      ) : (
        <span className="text-[11px] leading-none">⚽</span>
      )}
      <span className="truncate">{lg.name}</span>
    </div>
  );
}

function LegRow({ leg, nowMs, onDetach, onTrack, onSettle, busy, dead, settling }: { leg: AccaLeg; nowMs: number; onDetach?: () => void; onTrack?: () => void; onSettle?: (id: string, result: "won" | "lost" | "void", score?: string) => void; busy?: boolean; dead?: boolean; settling?: boolean }) {
  const ms = stateOf(leg, nowMs);
  const cat = legCat(leg, ms);
  const voided = leg.status === "void";
  const track = liveTrack(leg);
  const f = leg.fixtures;
  const market = leg.market_label ?? leg.custom_market ?? "Tracked market";
  const pulse = usePulse(`${leg.current_value ?? ""}|${ms?.score ?? ""}`);
  const [hStr, setHStr] = useState("");
  const [aStr, setAStr] = useState("");
  const canScore = SCORE_GRADABLE.has(leg.market_key ?? "");

  let sc = "";
  let mn = "";
  if (voided) {
    sc = ms?.score ?? "—";
    mn = "not counted";
  } else if (cat === "soon") {
    sc = ms?.label ?? "—";
  } else if (cat === "live") {
    // under lines show the running count AGAINST the line ("2 / 3.5") so you can see how
    // near/far the game is from breaking it — "3.5 under" alone said nothing about the goals
    sc = track
      ? track.under && track.count != null
        ? `${track.count} / ${track.big}`
        : `${track.big}${track.of}`
      : ms?.score ?? "live";
    mn = track?.under ? (track.busted ? "line broken" : `${ms?.label ?? ""} · under`) : ms?.label ?? "";
  } else if (cat === "safe") {
    sc = ms?.score ?? "✓";
    mn = leg.status === "won" ? "landed" : "FT";
  } else {
    sc = ms?.score ?? "✕";
    mn = "cut";
  }
  const scColor = cat === "cut" ? "text-brick" : cat === "safe" ? "text-grass-deep" : pulse ? "text-flood-deep" : "text-ink";

  // a leg the feed never graded — a game well past kickoff still not settled (no coverage), or a
  // custom bet the engine can't auto-grade once it has kicked off — gets manual settle controls
  const overdueNoFeed = !!f?.kickoff_utc && Date.parse(f.kickoff_utc) < nowMs - 2.5 * 3600 * 1000;
  const kicked = !!f?.kickoff_utc && Date.parse(f.kickoff_utc) < nowMs;
  const showManual =
    !!onSettle && !dead && leg.status !== "won" && leg.status !== "lost" && leg.status !== "void" &&
    (overdueNoFeed || (leg.market_key === "custom" && kicked));

  return (
    <div>
    <div className={`grid ${onDetach ? "grid-cols-[26px_1fr_auto_auto]" : "grid-cols-[26px_1fr_auto]"} items-center gap-3 rounded-[10px] px-2.5 py-2.5 transition-colors hover:bg-ink/[0.04] ${voided ? "opacity-60" : ""}`}>
      <span className={`grid h-[22px] w-[22px] place-items-center rounded-[7px] font-mono text-xs font-bold ${voided ? "bg-ink/[0.07] text-ink-mute" : MK[cat].cls}`}>
        {voided ? "–" : MK[cat].glyph}
      </span>
      <div className="min-w-0">
        {f?.leagues && <LeagueTag lg={f.leagues} />}
        <div className="mt-0.5 truncate text-sm font-bold leading-tight text-ink">
          {f ? (
            <>
              {f.home_team} <span className="font-semibold text-ink-mute">v</span> {f.away_team}
            </>
          ) : (
            "Match"
          )}
        </div>
        <div className="mt-0.5 truncate font-mono text-[11px] font-bold uppercase tracking-wide text-flood-deep">{market}</div>
        {/* open legs say whether they're ALSO visible on the tracker (a hidden one is one tap
            away); a landed/missed/void leg is done — tracking it again would be pointless.
            On a CUT slip the games were cleared off the tracker on purpose, so no re-add chip */}
        {!dead && leg.status !== "won" && leg.status !== "lost" && leg.status !== "void" && (
          leg.tracker_hidden ? (
            <button
              onClick={onTrack}
              disabled={busy || !onTrack}
              className="mt-1 rounded-full bg-flood/15 px-2 py-0.5 font-mono text-[9.5px] font-bold uppercase text-flood-deep transition-colors hover:bg-flood/25 disabled:opacity-50"
            >
              ＋ Add to tracker
            </button>
          ) : (
            <span className="mt-0.5 block font-mono text-[9.5px] uppercase tracking-wide text-ink-mute/70">✓ on tracker</span>
          )
        )}
      </div>
      <div className="text-right font-mono">
        <div className={`text-sm font-bold ${pulse && !voided ? "pop " : ""}${scColor}`}>{sc}</div>
        {mn && <div className="text-[11px] text-ink-mute">{mn}</div>}
      </div>
      {onDetach && (
        <button
          onClick={onDetach}
          disabled={busy}
          aria-label="Remove this game from the slip"
          title="Remove from this slip"
          className="grid h-6 w-6 flex-none place-items-center rounded-md font-mono text-sm text-ink-mute transition-colors hover:bg-brick/10 hover:text-brick disabled:opacity-40"
        >
          ×
        </button>
      )}
    </div>
      {showManual && (
        <div className="px-2.5 pb-2 pt-0.5">
          {canScore ? (
            // enter the final score → grades this leg AND every other bet you hold on this game
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="mr-auto font-mono text-[9.5px] uppercase tracking-wide text-ink-mute">Final score</span>
              <input type="number" min={0} inputMode="numeric" value={hStr} onChange={(e) => setHStr(e.target.value)} placeholder="H" className="w-10 rounded-md border border-ink/20 bg-white px-1.5 py-0.5 text-center font-mono text-xs text-ink" />
              <span className="font-mono text-ink-mute">–</span>
              <input type="number" min={0} inputMode="numeric" value={aStr} onChange={(e) => setAStr(e.target.value)} placeholder="A" className="w-10 rounded-md border border-ink/20 bg-white px-1.5 py-0.5 text-center font-mono text-xs text-ink" />
              <button
                disabled={settling || hStr === "" || aStr === ""}
                onClick={() => {
                  const h = Number(hStr), a = Number(aStr);
                  if (!Number.isFinite(h) || !Number.isFinite(a) || h < 0 || a < 0) return;
                  const r = (scoreGrade(leg.market_key ?? null, leg.side ?? null, leg.line ?? null, h, a) ?? "void") as "won" | "lost" | "void";
                  onSettle!(leg.id, r, `${h}-${a}`);
                }}
                className="rounded-md bg-ink px-2 py-0.5 font-mono text-[9.5px] font-bold uppercase text-chalk-2 disabled:opacity-40"
              >
                Settle
              </button>
              <button onClick={() => onSettle!(leg.id, "void")} disabled={settling} title="Game off — void" className="rounded-md bg-ink/10 px-2 py-0.5 font-mono text-[9.5px] font-bold uppercase text-ink-mute transition-colors hover:bg-ink/20 disabled:opacity-50">Void</button>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <span className="mr-auto font-mono text-[9.5px] uppercase tracking-wide text-ink-mute">No result — settle</span>
              <button onClick={() => onSettle!(leg.id, "won")} disabled={settling} className="rounded-md bg-grass/20 px-2 py-0.5 font-mono text-[9.5px] font-bold uppercase text-grass-deep transition-colors hover:bg-grass/30 disabled:opacity-50">Landed</button>
              <button onClick={() => onSettle!(leg.id, "lost")} disabled={settling} className="rounded-md bg-brick/20 px-2 py-0.5 font-mono text-[9.5px] font-bold uppercase text-brick transition-colors hover:bg-brick/30 disabled:opacity-50">Missed</button>
              <button onClick={() => onSettle!(leg.id, "void")} disabled={settling} title="Game off (postponed/abandoned) — void" className="rounded-md bg-ink/10 px-2 py-0.5 font-mono text-[9.5px] font-bold uppercase text-ink-mute transition-colors hover:bg-ink/20 disabled:opacity-50">Void</button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// a standalone tracked bet that can be pulled INTO this slip (accumulator_id is null)
type LooseTicket = {
  id: string;
  market_label: string | null;
  custom_market: string | null;
  fixtures: { home_team: string; away_team: string; kickoff_utc: string } | null;
};

function AccaCard({ acca, nowMs, plan, uploadsLeft }: { acca: Acca; nowMs: number; plan: string; uploadsLeft: number | null }) {
  const supabase = createClient();
  const router = useRouter();
  const confirm = useConfirm();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [loose, setLoose] = useState<LooseTicket[] | null>(null);

  // order the legs by kickoff so the slip reads in start-time order (earliest game first)
  const legs = [...(acca.tickets ?? [])].sort(
    (a, b) => (a.fixtures?.kickoff_utc ?? "").localeCompare(b.fixtures?.kickoff_utc ?? "") || a.id.localeCompare(b.id)
  );

  // wrong game on the slip (a bad screenshot match)? pull it out — the bet itself stays
  // tracked as a single, so nothing is lost and it can be re-added below
  async function detachLeg(leg: TrackedTicket) {
    const okGo = await confirm({
      title: "Remove this game from the slip?",
      body: "It stays in your tracker as a single bet — you can add it back to this slip anytime with “Add a game”.",
      confirmLabel: "Remove",
    });
    if (!okGo) return;
    setBusyId(leg.id);
    const { error } = await supabase.from("tickets").update({ accumulator_id: null }).eq("id", leg.id);
    if (!error) await supabase.from("accumulators").update({ leg_count: Math.max(1, legs.length - 1) }).eq("id", acca.id);
    setBusyId(null);
    router.refresh();
  }

  // list the user's standalone open bets (not on any slip) to add into this acca
  async function toggleAdd() {
    const opening = !addOpen;
    setAddOpen(opening);
    if (opening) {
      const { data } = await supabase
        .from("tickets")
        .select("id, market_label, custom_market, fixtures(home_team, away_team, kickoff_utc)")
        .is("accumulator_id", null)
        .in("status", ["pending", "live"])
        .order("created_at", { ascending: false })
        .limit(30);
      setLoose((data ?? []) as unknown as LooseTicket[]);
    }
  }

  async function attachLeg(id: string) {
    setBusyId(id);
    const { error } = await supabase.from("tickets").update({ accumulator_id: acca.id }).eq("id", id);
    if (!error) await supabase.from("accumulators").update({ leg_count: legs.length + 1 }).eq("id", acca.id);
    setBusyId(null);
    setAddOpen(false);
    setLoose(null);
    router.refresh();
  }

  // a cut slip can be deleted — soft delete only, so the day's upload/acca quota
  // stays used (both quota checks count accumulators rows, deleted or not)
  async function deleteAcca() {
    const okGo = await confirm({
      title: "Delete this slip?",
      body: "It disappears from your accumulators for good. Today's upload count stays used — deleting a slip doesn't give it back.",
      confirmLabel: "Delete",
      tone: "danger",
    });
    if (!okGo) return;
    setBusyId(acca.id);
    // belt and braces: its games should already be off the tracker (the cut hides them)
    await supabase.from("tickets").update({ tracker_hidden: true }).eq("accumulator_id", acca.id);
    await supabase.from("accumulators").update({ deleted_at: new Date().toISOString() }).eq("id", acca.id);
    setBusyId(null);
    router.refresh();
  }

  // a leg hidden from the tracker (removed there / Clear all) goes back with one tap
  async function retrackLeg(leg: AccaLeg) {
    setBusyId(leg.id);
    await supabase.from("tickets").update({ tracker_hidden: false }).eq("id", leg.id);
    setBusyId(null);
    router.refresh();
  }

  // settle a leg the feed never graded (a stuck game, or a custom bet) — the same soft manual
  // settle as the tracker: flips this leg's ticket, and won/lost/void flows into the acca's standing
  // (a voided leg drops out of the calc). RLS scopes the update to the caller's own ticket.
  // Settle once, everywhere: a final SCORE grades every bet on the fixture (this acca leg + tracker +
  // agent pick) by its own market; a VOID voids them all. A direct Landed/Missed with no score
  // settles just this leg.
  async function settleLeg(id: string, result: "won" | "lost" | "void", score?: string) {
    const leg = (acca.tickets ?? []).find((t) => t.id === id);
    const fixtureId = (leg?.fixtures as { id?: number } | null | undefined)?.id;
    setBusyId(id);
    try {
      if (result === "void" && fixtureId) {
        await voidFixture(supabase, fixtureId);
      } else if (score && fixtureId) {
        const [h, a] = score.split("-").map(Number);
        if (Number.isFinite(h) && Number.isFinite(a)) await settleFixtureByScore(supabase, fixtureId, h, a);
        else await supabase.from("tickets").update({ status: result, settled_at: new Date().toISOString() }).eq("id", id);
      } else {
        const { error } = await supabase.from("tickets").update({ status: result, settled_at: new Date().toISOString() }).eq("id", id);
        if (error && typeof window !== "undefined") window.alert(`Couldn't settle this leg: ${error.message}`);
      }
    } finally {
      setBusyId(null);
    }
    router.refresh();
  }

  const counts: Record<Cat, number> = { cut: 0, live: 0, safe: 0, soon: 0, void: 0 };
  const grouped: Record<Cat, TrackedTicket[]> = { cut: [], live: [], safe: [], soon: [], void: [] };
  for (const leg of legs) {
    const c = legCat(leg, stateOf(leg, nowMs));
    counts[c]++;
    grouped[c].push(leg);
  }
  const dead = acca.status === "lost" || counts.cut > 0;
  // a voided leg drops out — the acca is won when every non-void leg landed
  const countedLegs = legs.filter((l) => l.status !== "void");
  const won = acca.status === "won" || (countedLegs.length > 0 && countedLegs.every((l) => l.status === "won"));
  const fold = acca.leg_count ?? legs.length;
  const hasStake = acca.potential_return != null;

  return (
    <section className="betslip betslip-chalk rounded-2xl bg-chalk text-ink shadow-xl">
      <div className="border-b border-dashed border-ink/15 p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-wide text-ink-mute">
              <span className="rounded bg-ink px-1.5 py-0.5 font-bold tracking-wider text-chalk-2">{acca.bookmaker ?? "Onside"}</span>
              {won ? "won" : dead ? "cut" : "live"}
              {dead && (
                <button
                  onClick={deleteAcca}
                  disabled={busyId === acca.id}
                  aria-label="Delete this slip"
                  title="Delete this slip"
                  className="grid h-6 w-6 flex-none place-items-center rounded-md text-ink-mute transition-colors hover:bg-brick/10 hover:text-brick disabled:opacity-40"
                >
                  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-3.5 w-3.5">
                    <path d="M2.5 4h11M6.5 4V2.5h3V4M4 4l.7 9a1.4 1.4 0 0 0 1.4 1.3h3.8a1.4 1.4 0 0 0 1.4-1.3L12 4M6.5 7v4.5M9.5 7v4.5" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </button>
              )}
            </div>
            <div className="mt-2 font-disp text-[15px] font-extrabold">{fold}-fold accumulator</div>
          </div>
          <div className="text-right font-mono">
            {hasStake ? (
              <>
                {/* one line on mobile: shorter label + smaller amount so ₦13M-scale numbers don't wrap */}
                <div className="whitespace-nowrap text-[13px] text-ink-mute">
                  stake <b className="font-bold text-ink">{money(acca.currency, acca.stake)}</b> → <span className="sm:hidden">pot</span><span className="hidden sm:inline">potential</span>
                </div>
                <div className={`mt-0.5 whitespace-nowrap font-disp text-xl font-extrabold tracking-tight sm:text-2xl ${dead ? "text-brick line-through decoration-2" : won ? "text-grass-deep" : "text-ink"}`}>
                  {money(acca.currency, acca.potential_return)}
                </div>
              </>
            ) : (
              <div className={`font-disp text-lg font-extrabold ${dead ? "text-brick" : won ? "text-grass-deep" : "text-ink"}`}>
                {dead ? "Cut" : won ? "Won" : "Live"}
              </div>
            )}
          </div>
        </div>

        <div className="mt-4 flex h-2.5 gap-0.5 overflow-hidden rounded-md">
          {counts.safe > 0 && <span className="rounded-sm bg-grass" style={{ flex: counts.safe }} />}
          {counts.live > 0 && <span className="rounded-sm bg-flood" style={{ flex: counts.live }} />}
          {counts.cut > 0 && <span className="rounded-sm bg-brick" style={{ flex: counts.cut }} />}
          {counts.soon > 0 && <span className="rounded-sm bg-ink/20" style={{ flex: counts.soon }} />}
          {counts.void > 0 && <span className="rounded-sm bg-ink/10" style={{ flex: counts.void }} />}
        </div>
        <div className="mt-2.5 flex flex-wrap gap-4 font-mono text-[11px] text-ink-mute">
          {counts.safe > 0 && <span className="flex items-center gap-1.5"><i className="h-2 w-2 rounded-sm bg-grass" /> {counts.safe} safe</span>}
          {counts.live > 0 && <span className="flex items-center gap-1.5"><i className="h-2 w-2 rounded-sm bg-flood" /> {counts.live} live</span>}
          {counts.cut > 0 && <span className="flex items-center gap-1.5"><i className="h-2 w-2 rounded-sm bg-brick" /> {counts.cut} cut</span>}
          {counts.soon > 0 && <span className="flex items-center gap-1.5"><i className="h-2 w-2 rounded-sm bg-ink/30" /> {counts.soon} upcoming</span>}
          {counts.void > 0 && <span className="flex items-center gap-1.5"><i className="h-2 w-2 rounded-sm bg-ink/25" /> {counts.void} void</span>}
        </div>

        {dead && (
          <div className="mt-4 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-xl bg-brick/[0.08] px-3 py-2.5 text-[12.5px]">
            <span className="font-bold text-brick">This slip cut.</span>
            {/* only talk upgrades when the user is actually OUT of uploads — a paid user with
                quota left just gets pointed at their next slip */}
            {uploadsLeft != null && uploadsLeft > 0 ? (
              <span className="text-ink-mute">
                <Link href="/add" className="font-bold text-ink underline decoration-ink/30 underline-offset-2 hover:decoration-ink">
                  Upload another slip
                </Link>{" "}
                ({uploadsLeft} left today), or{" "}
                <Link href="/add" className="font-bold text-ink underline decoration-ink/30 underline-offset-2 hover:decoration-ink">
                  pick a game to track by hand
                </Link>
              </span>
            ) : uploadsLeft === 0 ? (
              <span className="text-ink-mute">
                Today&apos;s uploads are used
                {plan === "pro_max" ? (
                  <> — more tomorrow. Meanwhile,{" "}</>
                ) : (
                  <>
                    {" — "}
                    <Link href="/profile" className="font-bold text-ink underline decoration-ink/30 underline-offset-2 hover:decoration-ink">
                      upgrade for more
                    </Link>
                    , or{" "}
                  </>
                )}
                <Link href="/add" className="font-bold text-ink underline decoration-ink/30 underline-offset-2 hover:decoration-ink">
                  pick a game to track by hand
                </Link>
              </span>
            ) : (
              <span className="text-ink-mute">
                <Link href="/add" className="font-bold text-ink underline decoration-ink/30 underline-offset-2 hover:decoration-ink">
                  Start another slip
                </Link>{" "}
                or{" "}
                <Link href="/add" className="font-bold text-ink underline decoration-ink/30 underline-offset-2 hover:decoration-ink">
                  pick a game to track by hand
                </Link>
              </span>
            )}
          </div>
        )}
      </div>

      <div className="no-scrollbar max-h-[380px] overflow-y-auto p-3">
        {GROUPS.map((g) =>
          grouped[g.cat].length ? (
            <div key={g.cat}>
              <div className="sticky top-0 z-10 flex items-center gap-2 bg-chalk px-2.5 py-2 font-mono text-[10.5px] uppercase tracking-wide text-ink-mute">
                <span className={`h-2 w-2 rounded-full ${g.dot}`} /> {g.label} · {grouped[g.cat].length}
              </div>
              {grouped[g.cat].map((leg) => (
                <LegRow key={leg.id} leg={leg} nowMs={nowMs} onDetach={() => detachLeg(leg)} onTrack={() => retrackLeg(leg)} onSettle={settleLeg} settling={busyId === leg.id} busy={busyId === leg.id} dead={dead} />
              ))}
            </div>
          ) : null
        )}
      </div>

      {/* add a game to this slip — any standalone tracked bet can become a leg */}
      <div className="border-t border-dashed border-ink/15 p-3">
        <button
          onClick={toggleAdd}
          className="w-full rounded-xl border border-dashed border-ink/25 py-2.5 font-mono text-[11.5px] font-bold uppercase tracking-wide text-ink-mute transition-colors hover:border-ink/50 hover:text-ink"
        >
          {addOpen ? "Close" : "＋ Add a game to this slip"}
        </button>
        {addOpen && (
          <div className="mt-2 flex max-h-[220px] flex-col gap-1.5 overflow-y-auto">
            {loose === null ? (
              <p className="px-1 py-2 font-mono text-[11px] text-ink-mute">Loading your tracked bets…</p>
            ) : loose.length === 0 ? (
              <p className="px-1 py-2 font-mono text-[11px] text-ink-mute">
                No standalone bets to add — track a game from{" "}
                <Link href="/add" className="font-bold text-ink underline decoration-ink/30 underline-offset-2">
                  Add to tracker
                </Link>{" "}
                first, then add it here.
              </p>
            ) : (
              loose.map((t) => (
                <button
                  key={t.id}
                  onClick={() => attachLeg(t.id)}
                  disabled={busyId === t.id}
                  className="flex items-center justify-between gap-2 rounded-lg border border-ink/10 px-3 py-2 text-left transition-colors hover:border-flood-deep disabled:opacity-50"
                >
                  <span className="min-w-0">
                    <span className="block truncate text-[13px] font-bold">
                      {t.fixtures ? `${t.fixtures.home_team} v ${t.fixtures.away_team}` : "Match"}
                    </span>
                    <span className="block truncate font-mono text-[10.5px] font-bold uppercase text-flood-deep">
                      {t.market_label ?? t.custom_market ?? "Tracked market"}
                    </span>
                  </span>
                  <span className="flex-none font-mono text-[10px] font-bold uppercase text-grass-deep">Add</span>
                </button>
              ))
            )}
          </div>
        )}
      </div>
    </section>
  );
}

// --- previous-slip browser (fixed sidebar) ---

type AccaState = "won" | "cut" | "live" | "soon";

function accaState(acca: Acca, nowMs: number): AccaState {
  const legs = acca.tickets ?? [];
  if (acca.status === "lost" || legs.some((l) => l.status === "lost")) return "cut";
  // a voided leg drops out (stake back) — the acca wins if every REMAINING leg won
  const counted = legs.filter((l) => l.status !== "void");
  if (acca.status === "won" || (counted.length > 0 && counted.every((l) => l.status === "won"))) return "won";
  const anyLive = legs.some((l) => l.status === "live" || stateOf(l, nowMs)?.phase === "live");
  return anyLive ? "live" : "soon";
}

const STATE_META: Record<AccaState, { dot: string; word: string; tone: string }> = {
  won: { dot: "bg-grass", word: "Won", tone: "text-grass" },
  cut: { dot: "bg-brick", word: "Cut", tone: "text-brick" },
  live: { dot: "bg-flood animate-pulse motion-reduce:animate-none", word: "Live", tone: "text-flood" },
  soon: { dot: "bg-ink/30", word: "Soon", tone: "text-onpitch-mute" },
};

function accaName(acca: Acca): string {
  const t = acca.title?.trim();
  if (t) return t;
  const fold = acca.leg_count ?? acca.tickets?.length ?? 0;
  return `${fold}-fold acca`;
}

function accaDate(iso: string): string {
  const d = new Date(iso);
  const day = d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  const time = d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  return `${day} · ${time}`;
}

function AccaRow({
  acca,
  active,
  onClick,
  nowMs,
  canDelete = false,
  onDelete,
  deleting = false,
}: {
  acca: Acca;
  active: boolean;
  onClick: () => void;
  nowMs: number;
  canDelete?: boolean;
  onDelete?: () => void;
  deleting?: boolean;
}) {
  const meta = STATE_META[accaState(acca, nowMs)];
  const fold = acca.leg_count ?? acca.tickets?.length ?? 0;
  // wrapper is a div (not a button) so the trash can be a real nested button — a button
  // inside a button is invalid HTML. The selection area is its own inner button.
  return (
    <div
      className={`relative rounded-xl border transition-colors ${
        active ? "border-flood bg-flood/10" : "border-white/10 bg-pitch-2 hover:border-white/25"
      }`}
    >
      <button onClick={onClick} className="w-full p-3 text-left">
        <div className="flex items-center gap-2.5">
          <span className={`h-2 w-2 flex-none rounded-full ${meta.dot}`} />
          <span className="min-w-0 flex-1 truncate text-sm font-bold text-chalk">{accaName(acca)}</span>
          <span className={`font-mono text-[10px] font-bold uppercase ${meta.tone}`}>{meta.word}</span>
        </div>
        <div className={`mt-1.5 pl-[18px] font-mono text-[10.5px] text-onpitch-mute ${canDelete ? "pr-7" : ""}`}>
          {accaDate(acca.created_at)} · {fold} leg{fold === 1 ? "" : "s"}
        </div>
      </button>
      {canDelete && (
        <button
          onClick={onDelete}
          disabled={deleting}
          aria-label="Delete this slip"
          title="Delete this slip"
          className="absolute bottom-2 right-2 grid h-6 w-6 place-items-center rounded-md text-onpitch-mute transition-colors hover:bg-brick/15 hover:text-brick disabled:opacity-40"
        >
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-3.5 w-3.5">
            <path d="M2.5 4h11M6.5 4V2.5h3V4M4 4l.7 9a1.4 1.4 0 0 0 1.4 1.3h3.8a1.4 1.4 0 0 0 1.4-1.3L12 4M6.5 7v4.5M9.5 7v4.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      )}
    </div>
  );
}

function AccaPill({ acca, active, onClick, nowMs }: { acca: Acca; active: boolean; onClick: () => void; nowMs: number }) {
  const meta = STATE_META[accaState(acca, nowMs)];
  return (
    <button
      onClick={onClick}
      className={`flex flex-none flex-col gap-1 rounded-xl border px-3.5 py-2.5 text-left transition-colors ${
        active ? "border-flood bg-flood/10" : "border-white/10 bg-pitch-2"
      }`}
    >
      <span className="flex items-center gap-2">
        <span className={`h-1.5 w-1.5 flex-none rounded-full ${meta.dot}`} />
        <span className="max-w-[160px] truncate text-[13px] font-bold text-chalk">{accaName(acca)}</span>
      </span>
      <span className="pl-3.5 font-mono text-[10px] text-onpitch-mute">{accaDate(acca.created_at)}</span>
    </button>
  );
}

export default function AccumulatorsBoard({ accas, plan = "free", cap = null, uploadsLeft = null }: { accas: Acca[]; plan?: string; cap?: number | null; uploadsLeft?: number | null }) {
  const nowMs = useMinuteTick();
  const router = useRouter();
  const supabase = createClient();
  const confirm = useConfirm();
  const [selId, setSelId] = useState<string | null>(accas[0]?.id ?? null);
  const [delId, setDelId] = useState<string | null>(null);
  const selected = useMemo(() => accas.find((a) => a.id === selId) ?? accas[0] ?? null, [accas, selId]);

  // delete a cut slip straight from the sidebar list (same soft-delete as the detail card:
  // its legs are hidden from the tracker, the row disappears, but today's upload/acca quota
  // stays used — deleting doesn't hand a slot back).
  async function deleteAccaFromList(id: string) {
    const okGo = await confirm({
      title: "Delete this slip?",
      body: "It disappears from your accumulators for good. Today's upload count stays used — deleting a slip doesn't give it back.",
      confirmLabel: "Delete",
      tone: "danger",
    });
    if (!okGo) return;
    setDelId(id);
    await supabase.from("tickets").update({ tracker_hidden: true }).eq("accumulator_id", id);
    await supabase.from("accumulators").update({ deleted_at: new Date().toISOString() }).eq("id", id);
    if (selId === id) setSelId(null);
    setDelId(null);
    router.refresh();
  }

  // the free/pro history cap is full — surface a nudge to keep more (pro_max = unlimited = no cap)
  const atCap = cap != null && accas.length >= cap;
  const nextPlan = plan === "free" ? "Pro" : "Pro Max";
  const keepMore = plan === "free" ? "10 slips" : "unlimited slips";

  const header = (
    <StickyHeader className="-mx-5 px-5 pb-4 pt-6 md:-mx-8 md:px-8">
      <MobileLogo />
      <div className="flex items-end justify-between gap-4">
      <div className="min-w-0">
        <p className="font-mono text-[11px] uppercase tracking-[0.25em] text-flood">
          {accas.length} slip{accas.length === 1 ? "" : "s"}
        </p>
        <h1 className="mt-2 font-disp text-3xl font-bold tracking-tight text-chalk sm:text-4xl">
          Your acca, <span className="text-onpitch-mute">leg by leg.</span>
        </h1>
      </div>
      {/* icon-only on mobile so it rides the heading line; full label from sm up */}
      <Link
        href="/add"
        aria-label="Add to tracker"
        className="grid h-11 w-11 flex-none place-items-center rounded-xl bg-flood font-bold text-ink transition-transform hover:-translate-y-0.5 sm:h-auto sm:w-auto sm:px-4 sm:py-3"
      >
        <span className="text-2xl leading-none sm:hidden">+</span>
        <span className="hidden sm:inline">+ Add to tracker</span>
      </Link>
      </div>
    </StickyHeader>
  );

  if (accas.length === 0) {
    return (
      <div className="mx-auto max-w-3xl px-5 pb-10 md:px-8">
        {header}
        <div className="mt-6 rounded-2xl border border-dashed border-ink/15 bg-chalk p-12 text-center shadow-xl">
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-flood/15 font-mono text-xl text-flood-deep">+</div>
          <h2 className="font-disp text-xl font-bold text-ink">No accumulators yet.</h2>
          <p className="mx-auto mt-2 max-w-sm text-sm text-ink-mute">
            Add two or more games at once and they&apos;ll track here as one slip — safe, live and cut legs at a glance.
          </p>
          <Link href="/add" className="mt-5 inline-block rounded-xl bg-flood px-5 py-3 font-bold text-ink">
            Build your first slip
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto flex max-w-6xl flex-col px-5 pb-10 md:px-8 lg:h-full lg:pb-0">
      <div className="shrink-0">{header}</div>

      {/* mobile: horizontal switcher between slips */}
      <div className="no-scrollbar -mx-5 mb-4 flex shrink-0 gap-2 overflow-x-auto px-5 lg:hidden">
        {accas.map((a) => (
          <AccaPill key={a.id} acca={a} active={a.id === selected?.id} onClick={() => setSelId(a.id)} nowMs={nowMs} />
        ))}
      </div>

      <div className="flex min-h-0 flex-1 gap-6">
        {/* detail — the selected slip, leg by leg */}
        <main className="no-scrollbar min-w-0 flex-1 lg:overflow-y-auto lg:pb-10">
          {selected && <AccaCard acca={selected} nowMs={nowMs} plan={plan} uploadsLeft={uploadsLeft} />}
        </main>

        {/* fixed sidebar (right) — pick a previous slip to open on the left */}
        <aside className="hidden w-[272px] shrink-0 flex-col lg:flex">
          <div className="no-scrollbar flex flex-1 flex-col gap-2 overflow-y-auto pl-1">
            <div className="px-1 pb-1 font-mono text-[10.5px] uppercase tracking-[0.2em] text-onpitch-mute">Previous slips</div>
            {accas.map((a) => (
              <AccaRow
                key={a.id}
                acca={a}
                active={a.id === selected?.id}
                onClick={() => setSelId(a.id)}
                nowMs={nowMs}
                canDelete={accaState(a, nowMs) === "cut"}
                onDelete={() => deleteAccaFromList(a.id)}
                deleting={delId === a.id}
              />
            ))}
          </div>
          {atCap && (
            <div className="ml-1 mt-4 pb-6">
              <div className="font-mono text-[10px] uppercase tracking-wide text-flood">History full</div>
              <p className="mt-1.5 text-[12.5px] font-semibold leading-snug text-chalk">
                Your oldest slip drops off as new ones come in.
              </p>
              <p className="mt-1 text-[11.5px] leading-snug text-onpitch-mute">
                Go {nextPlan} to keep {keepMore} in your history.
              </p>
              <Link
                href="/profile"
                className="mt-2 inline-block font-mono text-[11px] font-bold uppercase tracking-wide text-flood transition-opacity hover:opacity-70"
              >
                Upgrade to {nextPlan} →
              </Link>
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}
