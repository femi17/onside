"use client";

// Onside Triple — the bolder sibling of the Onside Double. Display mirrors the double (a cream banker
// card + history), but the triple is OPT-IN: a "Play this triple" button copies its legs onto the user's
// tracker as an accumulator. Kept self-contained so the Double component is untouched; only the shared
// leg/delivery TYPES are imported from it.
import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { type TrackedTicket, stateOf } from "@/lib/ticket";
import { useMinuteTick } from "@/lib/useMinuteTick";
import { canonicalMarket } from "@/lib/betCatalog";
import type { MatchState } from "@/lib/matchState";
import type { DoubleLeg, LegDelivery } from "@/components/OnsideDoubleTracker";

// a triple carries the same leg shape as the double (delivery_id, rank, game, market, agent, prob, fixture_id)
export type TripleLeg = DoubleLeg;
export type OnsideTriple = { id: string; set_date: string; summary: string | null; legs: TripleLeg[]; created_at: string };

type Cat = "cut" | "live" | "safe" | "soon";
const MK: Record<Cat, { glyph: string; cls: string }> = {
  cut: { glyph: "✕", cls: "bg-brick/15 text-brick" },
  live: { glyph: "●", cls: "bg-flood/20 text-flood-deep" },
  safe: { glyph: "✓", cls: "bg-grass/15 text-grass-deep" },
  soon: { glyph: "◷", cls: "bg-ink/[0.07] text-ink-mute" },
};

function legCat(leg: LegDelivery | null, ms: MatchState | null): Cat {
  if (!leg) return "soon";
  if (leg.status === "lost") return "cut";
  if (leg.status === "won") return "safe";
  if (leg.status === "void") return ms?.phase === "live" ? "live" : "soon";
  if (leg.status === "live" || ms?.phase === "live") return "live";
  if (ms?.phase === "done") return "safe";
  return "soon";
}

type TrpState = "won" | "cut" | "live" | "soon";
function tripleState(trp: OnsideTriple, deliveries: Record<string, LegDelivery>, nowMs: number): TrpState {
  const legs = (trp.legs ?? []).map((l) => deliveries[l.delivery_id] ?? null);
  if (legs.some((t) => t?.status === "lost")) return "cut";
  const counted = legs.filter((t) => t?.status !== "void");
  if (counted.length > 0 && counted.every((t) => t?.status === "won")) return "won";
  const anyLive = legs.some((t) => t && (t.status === "live" || stateOf(t, nowMs)?.phase === "live"));
  return anyLive ? "live" : "soon";
}

const STATE_META: Record<TrpState, { dot: string; word: string; tone: string; pill: string }> = {
  won: { dot: "bg-grass", word: "Landed", tone: "text-grass", pill: "bg-grass/15 text-grass-deep" },
  cut: { dot: "bg-brick", word: "Cut", tone: "text-brick", pill: "bg-brick/15 text-brick" },
  live: { dot: "bg-flood animate-pulse motion-reduce:animate-none", word: "Live", tone: "text-flood", pill: "bg-flood/15 text-flood-deep" },
  soon: { dot: "bg-ink/30", word: "Upcoming", tone: "text-onpitch-mute", pill: "bg-ink/[0.07] text-ink-mute" },
};

// combined decimal odds implied by the three legs' probabilities (all must land)
function combinedOdds(legs: TripleLeg[]): number | null {
  if (!legs?.length) return null;
  const p = legs.reduce((acc, l) => acc * (Math.min(99, Math.max(1, l.prob)) / 100), 1);
  return p > 0 ? 1 / p : null;
}

function dayLabel(setDate: string): string {
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "Africa/Lagos" });
  const yday = new Date(Date.now() - 86400000).toLocaleDateString("en-CA", { timeZone: "Africa/Lagos" });
  if (setDate === today) return "Today";
  if (setDate === yday) return "Yesterday";
  return new Date(`${setDate}T12:00:00Z`).toLocaleDateString("en-GB", { weekday: "short", day: "2-digit", month: "short" });
}

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

function LegRow({ leg, del, nowMs }: { leg: TripleLeg; del: LegDelivery | null; nowMs: number }) {
  const ms = del ? stateOf(del, nowMs) : null;
  const cat = legCat(del, ms);
  const f = del?.fixtures ?? null;
  const voided = del?.status === "void";
  let sc = "";
  let mn = "";
  if (voided) { sc = "—"; mn = "void"; }
  else if (cat === "safe") { sc = ms?.score ?? "✓"; mn = del?.status === "won" ? "landed" : "FT"; }
  else if (cat === "cut") { sc = ms?.score ?? "✕"; mn = "cut"; }
  else if (cat === "live") { sc = ms?.score ?? "live"; mn = ms?.label ?? "live"; }
  else { sc = `${leg.prob}%`; mn = ms?.label ?? "upcoming"; }
  const scColor = voided ? "text-ink-mute" : cat === "cut" ? "text-brick" : cat === "safe" ? "text-grass-deep" : cat === "live" ? "text-flood-deep" : "text-ink";

  return (
    <div className="grid grid-cols-[24px_1fr_auto] items-center gap-2.5 rounded-[10px] px-2.5 py-2.5 transition-colors hover:bg-ink/[0.04]">
      <span className={`grid h-[22px] w-[22px] place-items-center rounded-[7px] font-mono text-xs font-bold ${voided ? "bg-ink/[0.07] text-ink-mute" : MK[cat].cls}`}>{voided ? "–" : MK[cat].glyph}</span>
      <div className={`min-w-0 ${voided ? "opacity-60" : ""}`}>
        {f?.leagues && <LeagueTag lg={f.leagues} />}
        <div className={`mt-0.5 truncate text-[13.5px] font-bold leading-tight text-ink ${voided ? "line-through" : ""}`}>{leg.game}</div>
        <div className="mt-0.5 truncate font-mono text-[10.5px] font-bold uppercase tracking-wide text-flood-deep">
          {leg.market}
          <span className="font-normal text-ink-mute"> · {leg.agent}</span>
        </div>
      </div>
      <div className="text-right font-mono">
        <div className={`text-[13.5px] font-bold ${scColor}`}>{sc}</div>
        {mn && <div className="text-[10.5px] text-ink-mute">{mn}</div>}
      </div>
    </div>
  );
}

function TripleCard({ trp, deliveries, nowMs, userId }: { trp: OnsideTriple; deliveries: Record<string, LegDelivery>; nowMs: number; userId: string }) {
  const router = useRouter();
  const supabase = createClient();
  const legs = [...(trp.legs ?? [])].sort((a, b) => a.rank - b.rank);
  const state = tripleState(trp, deliveries, nowMs);
  const meta = STATE_META[state];
  const odds = combinedOdds(legs);

  const counts: Record<Cat, number> = { cut: 0, live: 0, safe: 0, soon: 0 };
  for (const l of legs) {
    const del = deliveries[l.delivery_id] ?? null;
    counts[legCat(del, del ? stateOf(del, nowMs) : null)]++;
  }

  const [busy, setBusy] = useState(false);
  const [played, setPlayed] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const today = new Date().toLocaleDateString("en-CA", { timeZone: "Africa/Lagos" });
  const isToday = trp.set_date === today;
  // playable only before any leg has kicked off — copying a half-started triple makes no sense
  const notStarted = (t: LegDelivery | null) => !!t && (t.status === "pending") && stateOf(t, nowMs)?.phase !== "live";
  const playableLegs = legs.map((l) => deliveries[l.delivery_id] ?? null).filter(notStarted);
  const canPlay = isToday && !played && state === "soon" && playableLegs.length === legs.length && legs.length === 3;

  async function play() {
    setBusy(true);
    setMsg(null);
    // build one accumulator from the three legs' source deliveries
    const rows = [] as Record<string, unknown>[];
    for (const l of legs) {
      const del = deliveries[l.delivery_id] ?? null;
      const fx = (del?.fixtures as { id?: number } | null)?.id ?? null;
      if (!del || fx == null || del.status !== "pending") continue;
      const c = canonicalMarket(del.market_key, del.line, del.side);
      rows.push({
        user_id: userId, fixture_id: fx,
        market_key: c.marketKey, market_label: del.market_label, custom_market: del.custom_market ?? null,
        line: c.line, side: c.side, period: del.period ?? "ft", bet_value: del.bet_value ?? null,
        source: "agent", status: "pending",
      });
    }
    if (rows.length < 2) { setMsg("Not enough upcoming legs to play."); setBusy(false); return; }
    const { data: acca, error } = await supabase
      .from("accumulators")
      .insert({ user_id: userId, leg_count: rows.length, source: "agent", status: "open" })
      .select("id").single();
    if (error || !acca) {
      const lim = error?.message.match(/DAILY_ACCA_LIMIT:(\w+):(\d+)/);
      setMsg(lim ? `Your ${lim[1].replace("_", " ")} plan tracks ${lim[2]} accumulator${lim[2] === "1" ? "" : "s"} a day. Upgrade for more.` : error?.message ?? "Couldn't create the slip.");
      setBusy(false);
      return;
    }
    const withAcca = rows.map((r) => ({ ...r, accumulator_id: acca.id }));
    const { error: insErr } = await supabase.from("tickets").insert(withAcca);
    setBusy(false);
    if (insErr) { setMsg(insErr.message); return; }
    setPlayed(true);
    setMsg("Playing — added to your accumulators.");
    setTimeout(() => { router.push("/accumulators"); router.refresh(); }, 900);
  }

  return (
    <section className="betslip betslip-chalk overflow-hidden rounded-2xl bg-chalk text-ink shadow-xl">
      <div className="border-b border-dashed border-ink/15 p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-1.5 font-mono text-[10.5px] uppercase tracking-wide text-ink-mute">
              <span className="rounded bg-ink px-1.5 py-0.5 font-bold tracking-wider text-chalk-2">🎲 Onside</span>
              <span className={`rounded px-1.5 py-0.5 font-bold ${meta.pill}`}>{meta.word}</span>
              <span>{dayLabel(trp.set_date)}</span>
            </div>
            <div className="mt-2 font-disp text-[15px] font-extrabold">3-leg banker triple</div>
          </div>
          <div className="flex-none text-right font-mono">
            <div className="text-[10.5px] text-ink-mute">all three land</div>
            <div className={`font-disp text-lg font-extrabold tracking-tight ${state === "cut" ? "text-brick line-through decoration-2" : state === "won" ? "text-grass-deep" : "text-ink"}`}>
              {odds != null ? `≈${odds.toFixed(2)}` : "—"}
            </div>
          </div>
        </div>

        <div className="mt-3 flex h-2 gap-0.5 overflow-hidden rounded-md">
          {counts.safe > 0 && <span className="rounded-sm bg-grass" style={{ flex: counts.safe }} />}
          {counts.live > 0 && <span className="rounded-sm bg-flood" style={{ flex: counts.live }} />}
          {counts.cut > 0 && <span className="rounded-sm bg-brick" style={{ flex: counts.cut }} />}
          {counts.soon > 0 && <span className="rounded-sm bg-ink/20" style={{ flex: counts.soon }} />}
        </div>
      </div>

      <div className="p-2.5">
        {legs.map((l) => (
          <LegRow key={l.delivery_id} leg={l} del={deliveries[l.delivery_id] ?? null} nowMs={nowMs} />
        ))}
      </div>

      {/* opt-in: it's up to the user whether to play it */}
      {(canPlay || played || msg) && (
        <div className="border-t border-dashed border-ink/15 p-3">
          {played ? (
            <p className="text-center font-mono text-[11.5px] font-bold text-grass-deep">✓ Playing — see it in Accumulators</p>
          ) : canPlay ? (
            <button
              onClick={play}
              disabled={busy}
              className="w-full rounded-xl bg-ink px-4 py-2.5 font-bold text-chalk-2 transition-transform hover:-translate-y-0.5 disabled:opacity-50"
            >
              {busy ? "Adding…" : "Play this triple →"}
            </button>
          ) : null}
          {msg && !played && <p className="mt-2 text-center font-mono text-[11px] text-ink-mute">{msg}</p>}
        </div>
      )}
    </section>
  );
}

function TripleRow({ trp, deliveries, active, onClick, nowMs }: { trp: OnsideTriple; deliveries: Record<string, LegDelivery>; active: boolean; onClick: () => void; nowMs: number }) {
  const meta = STATE_META[tripleState(trp, deliveries, nowMs)];
  return (
    <button
      onClick={onClick}
      className={`w-full rounded-xl border p-3 text-left transition-colors ${active ? "border-flood bg-flood/10" : "border-white/10 bg-pitch-2 hover:border-white/25"}`}
    >
      <div className="flex items-center gap-2.5">
        <span className={`h-2 w-2 flex-none rounded-full ${meta.dot}`} />
        <span className="min-w-0 flex-1 truncate text-sm font-bold text-chalk">{dayLabel(trp.set_date)}</span>
        <span className={`font-mono text-[10px] font-bold uppercase ${meta.tone}`}>{meta.word}</span>
      </div>
      <div className="mt-1.5 truncate pl-[18px] font-mono text-[10.5px] text-onpitch-mute">
        {(trp.legs ?? []).map((l) => l.game.split(" v ")[0]).join(" + ") || "3 legs"}
      </div>
    </button>
  );
}

// Embeddable Onside Triple tracker — sits under the Double in the agent feed. `userId` powers the
// opt-in Play button. `noGamesToday`: agents ran but cleared nothing, so no triple could form.
export default function OnsideTripleTracker({ triples, deliveries, userId, noGamesToday = false }: { triples: OnsideTriple[]; deliveries: Record<string, LegDelivery>; userId: string; noGamesToday?: boolean }) {
  const nowMs = useMinuteTick();
  const [selId, setSelId] = useState<string | null>(triples[0]?.id ?? null);
  const selected = triples.find((t) => t.id === selId) ?? triples[0] ?? null;

  const today = new Date().toLocaleDateString("en-CA", { timeZone: "Africa/Lagos" });
  const hasToday = triples.some((t) => t.set_date === today);
  const showNoGames = noGamesToday && !hasToday;

  return (
    <div className="flex flex-col gap-3">
      <div className="px-1 font-mono text-[10.5px] uppercase tracking-[0.2em] text-onpitch-mute">🎲 Onside Triple</div>

      {showNoGames && (
        <div className="rounded-2xl border border-dashed border-white/15 bg-pitch-2 p-4 text-center">
          <div className="mx-auto mb-2 flex h-10 w-10 items-center justify-center rounded-xl bg-ink/[0.06] text-lg text-onpitch-mute">◷</div>
          <p className="text-[13px] font-bold text-chalk">No games today</p>
          <p className="mt-1 text-[11.5px] leading-snug text-onpitch-mute">
            Your agents ran but no fixtures cleared — so there&apos;s no banker triple today.
          </p>
        </div>
      )}

      {selected ? (
        <TripleCard trp={selected} deliveries={deliveries} nowMs={nowMs} userId={userId} />
      ) : showNoGames ? null : (
        <div className="rounded-2xl border border-dashed border-white/15 bg-pitch-2 p-5 text-center">
          <div className="mx-auto mb-2 flex h-10 w-10 items-center justify-center rounded-xl bg-flood/15 text-lg">🎲</div>
          <p className="text-[13px] font-bold text-chalk">No banker triple yet</p>
          <p className="mt-1 text-[11.5px] leading-snug text-onpitch-mute">
            When your agents deliver three strong picks in a day, your bolder banker triple lands here — play it if you fancy the bigger return.
          </p>
        </div>
      )}

      {triples.length > 1 && (
        <div className="flex flex-col gap-2">
          <div className="px-1 font-mono text-[10px] uppercase tracking-wide text-onpitch-mute/70">Previous triples</div>
          <div className="no-scrollbar flex max-h-[13.5rem] flex-col gap-2 overflow-y-auto">
            {triples.map((t) => (
              <TripleRow key={t.id} trp={t} deliveries={deliveries} active={t.id === selected?.id} onClick={() => setSelId(t.id)} nowMs={nowMs} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
