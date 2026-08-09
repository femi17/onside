"use client";

import { useState } from "react";
import { type TrackedTicket, stateOf } from "@/lib/ticket";
import { useMinuteTick } from "@/lib/useMinuteTick";
import type { MatchState } from "@/lib/matchState";

// a leg as stored on the double (jsonb) — reliable display text even if the source delivery is stale
export type DoubleLeg = { delivery_id: string; rank: number; game: string; market: string; agent: string; prob: number; fixture_id: number };
export type OnsideDouble = { id: string; set_date: string; summary: string | null; legs: DoubleLeg[]; created_at: string };
// each leg resolves live tick/cross/score from its source delivery (result mapped -> status)
export type LegDelivery = TrackedTicket & { period?: string | null; bet_value?: string | null; settle_score?: string | null };

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

type DblState = "won" | "cut" | "live" | "soon";

function doubleState(dbl: OnsideDouble, deliveries: Record<string, LegDelivery>, nowMs: number): DblState {
  const legs = (dbl.legs ?? []).map((l) => deliveries[l.delivery_id] ?? null);
  if (legs.some((t) => t?.status === "lost")) return "cut";
  if (legs.length > 0 && legs.every((t) => t?.status === "won")) return "won";
  const anyLive = legs.some((t) => t && (t.status === "live" || stateOf(t, nowMs)?.phase === "live"));
  return anyLive ? "live" : "soon";
}

const STATE_META: Record<DblState, { dot: string; word: string; tone: string; pill: string }> = {
  won: { dot: "bg-grass", word: "Landed", tone: "text-grass", pill: "bg-grass/15 text-grass-deep" },
  cut: { dot: "bg-brick", word: "Cut", tone: "text-brick", pill: "bg-brick/15 text-brick" },
  live: { dot: "bg-flood animate-pulse motion-reduce:animate-none", word: "Live", tone: "text-flood", pill: "bg-flood/15 text-flood-deep" },
  soon: { dot: "bg-ink/30", word: "Upcoming", tone: "text-onpitch-mute", pill: "bg-ink/[0.07] text-ink-mute" },
};

// combined decimal odds implied by the two legs' model probabilities (both must land)
function combinedOdds(legs: DoubleLeg[]): number | null {
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

function LegRow({ leg, del, nowMs }: { leg: DoubleLeg; del: LegDelivery | null; nowMs: number }) {
  const ms = del ? stateOf(del, nowMs) : null;
  const cat = legCat(del, ms);
  const f = del?.fixtures ?? null;

  let sc = "";
  let mn = "";
  if (cat === "safe") {
    sc = ms?.score ?? "✓";
    mn = del?.status === "won" ? "landed" : "FT";
  } else if (cat === "cut") {
    sc = ms?.score ?? "✕";
    mn = "cut";
  } else if (cat === "live") {
    sc = ms?.score ?? "live";
    mn = ms?.label ?? "live";
  } else {
    sc = `${leg.prob}%`;
    mn = ms?.label ?? "upcoming";
  }
  const scColor = cat === "cut" ? "text-brick" : cat === "safe" ? "text-grass-deep" : cat === "live" ? "text-flood-deep" : "text-ink";

  return (
    <div className="grid grid-cols-[24px_1fr_auto] items-center gap-2.5 rounded-[10px] px-2.5 py-2.5 transition-colors hover:bg-ink/[0.04]">
      <span className={`grid h-[22px] w-[22px] place-items-center rounded-[7px] font-mono text-xs font-bold ${MK[cat].cls}`}>{MK[cat].glyph}</span>
      <div className="min-w-0">
        {f?.leagues && <LeagueTag lg={f.leagues} />}
        <div className="mt-0.5 truncate text-[13.5px] font-bold leading-tight text-ink">{leg.game}</div>
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

function DoubleCard({ dbl, deliveries, nowMs }: { dbl: OnsideDouble; deliveries: Record<string, LegDelivery>; nowMs: number }) {
  const legs = [...(dbl.legs ?? [])].sort((a, b) => a.rank - b.rank);
  const state = doubleState(dbl, deliveries, nowMs);
  const meta = STATE_META[state];
  const odds = combinedOdds(legs);

  const counts: Record<Cat, number> = { cut: 0, live: 0, safe: 0, soon: 0 };
  for (const l of legs) {
    const del = deliveries[l.delivery_id] ?? null;
    counts[legCat(del, del ? stateOf(del, nowMs) : null)]++;
  }

  return (
    <section className="betslip betslip-chalk overflow-hidden rounded-2xl bg-chalk text-ink shadow-xl">
      <div className="border-b border-dashed border-ink/15 p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-1.5 font-mono text-[10.5px] uppercase tracking-wide text-ink-mute">
              <span className="rounded bg-ink px-1.5 py-0.5 font-bold tracking-wider text-chalk-2">🎯 Onside</span>
              <span className={`rounded px-1.5 py-0.5 font-bold ${meta.pill}`}>{meta.word}</span>
              <span>{dayLabel(dbl.set_date)}</span>
            </div>
            <div className="mt-2 font-disp text-[15px] font-extrabold">2-leg banker double</div>
          </div>
          <div className="flex-none text-right font-mono">
            <div className="text-[10.5px] text-ink-mute">both land</div>
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
    </section>
  );
}

function DoubleRow({ dbl, deliveries, active, onClick, nowMs }: { dbl: OnsideDouble; deliveries: Record<string, LegDelivery>; active: boolean; onClick: () => void; nowMs: number }) {
  const meta = STATE_META[doubleState(dbl, deliveries, nowMs)];
  return (
    <button
      onClick={onClick}
      className={`w-full rounded-xl border p-3 text-left transition-colors ${active ? "border-flood bg-flood/10" : "border-white/10 bg-pitch-2 hover:border-white/25"}`}
    >
      <div className="flex items-center gap-2.5">
        <span className={`h-2 w-2 flex-none rounded-full ${meta.dot}`} />
        <span className="min-w-0 flex-1 truncate text-sm font-bold text-chalk">{dayLabel(dbl.set_date)}</span>
        <span className={`font-mono text-[10px] font-bold uppercase ${meta.tone}`}>{meta.word}</span>
      </div>
      <div className="mt-1.5 truncate pl-[18px] font-mono text-[10.5px] text-onpitch-mute">
        {(dbl.legs ?? []).map((l) => l.game.split(" v ")[0]).join(" + ") || "2 legs"}
      </div>
    </button>
  );
}

// Embeddable Onside Double tracker: today's cream banker card + a switchable history of previous
// days' doubles. Used inside the agent feed (right sidebar on desktop, top block on mobile).
export default function OnsideDoubleTracker({ doubles, deliveries }: { doubles: OnsideDouble[]; deliveries: Record<string, LegDelivery> }) {
  const nowMs = useMinuteTick();
  const [selId, setSelId] = useState<string | null>(doubles[0]?.id ?? null);
  const selected = doubles.find((d) => d.id === selId) ?? doubles[0] ?? null;

  return (
    <div className="flex flex-col gap-3">
      <div className="px-1 font-mono text-[10.5px] uppercase tracking-[0.2em] text-onpitch-mute">🎯 Onside Double</div>

      {selected ? (
        <DoubleCard dbl={selected} deliveries={deliveries} nowMs={nowMs} />
      ) : (
        <div className="rounded-2xl border border-dashed border-white/15 bg-pitch-2 p-5 text-center">
          <div className="mx-auto mb-2 flex h-10 w-10 items-center justify-center rounded-xl bg-flood/15 text-lg">🎯</div>
          <p className="text-[13px] font-bold text-chalk">No banker double yet</p>
          <p className="mt-1 text-[11.5px] leading-snug text-onpitch-mute">
            Once all your agents deliver for the day, your two safest picks land here as a daily double.
          </p>
        </div>
      )}

      {doubles.length > 1 && (
        <div className="flex flex-col gap-2">
          <div className="px-1 font-mono text-[10px] uppercase tracking-wide text-onpitch-mute/70">Previous doubles</div>
          {doubles.map((d) => (
            <DoubleRow key={d.id} dbl={d} deliveries={deliveries} active={d.id === selected?.id} onClick={() => setSelId(d.id)} nowMs={nowMs} />
          ))}
        </div>
      )}
    </div>
  );
}
