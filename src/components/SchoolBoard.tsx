"use client";

import { useMemo, useRef, useState } from "react";

export type SchoolLeg = { game: string; odds: number | null; score: string | null; hit: boolean | null };
export type SchoolRecord = {
  date: string;
  legs: SchoolLeg[];
  combined: number;
  result: "won" | "lost" | "pending";
};

const CHIPS = [5000, 10000, 50000, 100000];
const naira = (n: number) => (n < 0 ? "−₦" : "₦") + Math.round(Math.abs(n)).toLocaleString("en-US");
const short = (n: number) => (n >= 1000 ? "₦" + Math.round(n / 1000) + "k" : "₦" + n);
const day = (iso: string) =>
  new Date(iso + "T00:00:00Z").toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });

export default function SchoolBoard({ records }: { records: SchoolRecord[] }) {
  const [stake, setStake] = useState(10000);

  // oldest → newest for cumulative math; newest first for the deck
  const running = useMemo(() => {
    let c = 0;
    return records.map((r) => (c += r.result === "won" ? stake * (r.combined - 1) : -stake));
  }, [records, stake]);

  const sum = useMemo(() => {
    const wins = records.filter((r) => r.result === "won").length;
    const total = running.length ? running[running.length - 1] : 0;
    const avg = records.length ? records.reduce((a, r) => a + r.combined, 0) / records.length : 0;
    const staked = stake * records.length; // ₦stake risked each day, one bet a day
    const roi = staked ? Math.round((total / staked) * 100) : 0;
    return { wins, losses: records.length - wins, rate: records.length ? Math.round((wins / records.length) * 100) : 0, avg, total, roi, staked, returned: staked + total };
  }, [records, running, stake]);

  return (
    <div className="mx-auto max-w-md px-5 md:px-8">
      {/* headline P/L — capital explicit: staked → back → profit */}
      <div className="rounded-2xl border border-white/10 bg-pitch-2 p-5">
        <p className="font-mono text-[10.5px] uppercase tracking-[0.14em] text-onpitch-mute">
          Profit · {short(stake)}/day × {records.length} days
        </p>
        <p className={`mt-1 font-disp text-4xl font-extrabold tracking-tight tabular-nums ${sum.total >= 0 ? "text-grass" : "text-brick"}`}>
          {naira(sum.total)}
        </p>
        <div className="mt-3 grid grid-cols-3 gap-2 border-t border-white/10 pt-3 text-center font-mono tabular-nums">
          <div>
            <div className="text-[10px] uppercase tracking-wide text-onpitch-mute">Staked</div>
            <div className="mt-0.5 text-sm font-bold text-chalk">{naira(sum.staked)}</div>
          </div>
          <div>
            <div className="text-[10px] uppercase tracking-wide text-onpitch-mute">Back</div>
            <div className="mt-0.5 text-sm font-bold text-chalk">{naira(sum.returned)}</div>
          </div>
          <div>
            <div className="text-[10px] uppercase tracking-wide text-onpitch-mute">ROI</div>
            <div className={`mt-0.5 text-sm font-bold ${sum.roi >= 0 ? "text-grass" : "text-brick"}`}>
              {sum.roi >= 0 ? "+" : "−"}
              {Math.abs(sum.roi)}%
            </div>
          </div>
        </div>
        <p className="mt-2 text-center font-mono text-[10.5px] text-onpitch-mute tabular-nums">
          {sum.wins}–{sum.losses} · {sum.rate}% · avg {sum.avg.toFixed(2)}
        </p>
      </div>

      {/* stake */}
      <div className="mt-4 flex items-center gap-2">
        <div className="flex h-11 flex-1 items-center rounded-xl border border-white/10 bg-pitch-2 px-3">
          <span className="mr-1 font-disp font-bold text-onpitch-mute">₦</span>
          <input
            inputMode="numeric"
            value={stake.toLocaleString("en-US")}
            onChange={(e) => setStake(Math.max(0, Number(e.target.value.replace(/[^\d]/g, "")) || 0))}
            className="w-full bg-transparent font-disp text-lg font-extrabold tabular-nums text-chalk outline-none"
            aria-label="Daily stake"
          />
        </div>
        {CHIPS.map((c) => (
          <button
            key={c}
            type="button"
            onClick={() => setStake(c)}
            aria-pressed={stake === c}
            className={`h-11 rounded-xl border px-3 font-mono text-[12px] font-bold tabular-nums transition ${
              stake === c ? "border-flood bg-flood/15 text-flood" : "border-white/10 bg-pitch-2 text-onpitch-mute"
            }`}
          >
            {short(c)}
          </button>
        ))}
      </div>

      <Deck records={records} running={running} stake={stake} />

      <p className="mt-5 text-center font-mono text-[10.5px] uppercase tracking-[0.12em] text-onpitch-mute">
        Real record · flat stakes · 18+
      </p>
    </div>
  );
}

function Deck({ records, running, stake }: { records: SchoolRecord[]; running: number[]; stake: number }) {
  const deck = records.map((r, i) => ({ r, i })).reverse(); // newest first
  const [top, setTop] = useState(0);
  const [flipped, setFlipped] = useState(false);
  const [dx, setDx] = useState(0);
  const drag = useRef({ x: 0, moved: false, active: false });

  if (deck.length === 0) {
    return (
      <p className="mt-6 rounded-2xl border border-dashed border-white/15 bg-pitch-2 p-6 text-center text-sm text-onpitch-mute">
        No settled doubles yet.
      </p>
    );
  }

  const go = (n: number) => {
    setTop((t) => Math.min(deck.length - 1, Math.max(0, t + n)));
    setFlipped(false);
    setDx(0);
  };
  const down = (e: React.PointerEvent) => {
    drag.current = { x: e.clientX, moved: false, active: true };
  };
  const move = (e: React.PointerEvent) => {
    if (!drag.current.active) return;
    const d = e.clientX - drag.current.x;
    if (Math.abs(d) > 6) drag.current.moved = true;
    setDx(d);
  };
  const up = () => {
    if (!drag.current.active) return;
    const d = dx;
    drag.current.active = false;
    if (Math.abs(d) > 90) go(d < 0 ? 1 : -1);
    else if (!drag.current.moved) setFlipped((f) => !f);
    else setDx(0);
  };

  return (
    <div className="mt-6">
      <div className="mb-2 flex items-center justify-between px-1">
        <span className="font-mono text-[10.5px] uppercase tracking-[0.12em] text-onpitch-mute">
          {top + 1}/{deck.length}
        </span>
        <span className="font-mono text-[10.5px] text-onpitch-mute">swipe · tap to flip</span>
      </div>

      <div className="relative h-[300px] select-none" style={{ perspective: "1200px", touchAction: "pan-y" }}>
        {deck.map(({ r, i }, pos) => {
          const depth = pos - top;
          if (depth < 0 || depth > 2) return null;
          const isTop = depth === 0;
          const t = isTop
            ? `translateX(${dx}px) rotate(${dx * 0.04}deg)`
            : `translateY(${depth * 10}px) scale(${1 - depth * 0.04})`;
          return (
            <div
              key={r.date + i}
              className="absolute inset-0"
              style={{
                transform: t,
                zIndex: 10 - depth,
                opacity: isTop ? 1 - Math.min(Math.abs(dx) / 320, 0.5) : 1,
                transition: drag.current.active && isTop ? "none" : "transform .3s cubic-bezier(.2,.7,.25,1), opacity .3s",
                pointerEvents: isTop ? "auto" : "none",
              }}
              onPointerDown={isTop ? down : undefined}
              onPointerMove={isTop ? move : undefined}
              onPointerUp={isTop ? up : undefined}
              onPointerCancel={isTop ? up : undefined}
            >
              <Card r={r} running={running[i]} stake={stake} flipped={isTop && flipped} />
            </div>
          );
        })}
      </div>

      <div className="mt-4 flex gap-2">
        <button onClick={() => go(-1)} disabled={top === 0} className="h-10 flex-1 rounded-xl border border-white/10 bg-pitch-2 text-sm font-bold text-chalk disabled:opacity-40">
          ‹
        </button>
        <button onClick={() => go(1)} disabled={top >= deck.length - 1} className="h-10 flex-1 rounded-xl border border-white/10 bg-pitch-2 text-sm font-bold text-chalk disabled:opacity-40">
          ›
        </button>
      </div>
    </div>
  );
}

function Card({ r, running, stake, flipped }: { r: SchoolRecord; running: number; stake: number; flipped: boolean }) {
  const won = r.result === "won";
  const dayPL = won ? stake * (r.combined - 1) : -stake;
  return (
    <div className="relative h-full w-full" style={{ transformStyle: "preserve-3d", transition: "transform .5s cubic-bezier(.2,.7,.25,1)", transform: flipped ? "rotateY(180deg)" : "rotateY(0)" }}>
      {/* front */}
      <div className="betslip betslip-chalk absolute inset-0 flex flex-col rounded-2xl bg-chalk p-4 text-ink shadow-xl" style={{ backfaceVisibility: "hidden", WebkitBackfaceVisibility: "hidden" }}>
        <div className="flex items-center justify-between">
          <span className="font-mono text-[10.5px] uppercase tracking-wide text-ink-mute">{day(r.date)}</span>
          <span className="rounded bg-ink px-1.5 py-0.5 font-mono text-[11px] font-bold tabular-nums text-chalk-2">@{r.combined.toFixed(2)}</span>
        </div>
        <div className="mt-3 flex flex-1 flex-col justify-center gap-2 border-y border-dashed border-ink/15 py-3">
          {r.legs.map((l, k) => (
            <div key={k} className="flex items-center justify-between gap-3">
              <span className="truncate text-[14px] font-bold text-ink">{l.game}</span>
              <span className="font-mono text-[13px] font-bold tabular-nums text-flood-deep">{l.odds ? l.odds.toFixed(2) : "—"}</span>
            </div>
          ))}
        </div>
        <div className="mt-3 flex items-end justify-between">
          <span className="font-mono text-[10.5px] uppercase tracking-wide text-ink-mute">Over 2.5 · both</span>
          <span className="font-disp text-lg font-extrabold tabular-nums text-ink">{naira(stake * r.combined)}</span>
        </div>
      </div>
      {/* back */}
      <div
        className="betslip betslip-chalk absolute inset-0 flex flex-col rounded-2xl bg-chalk p-4 text-ink shadow-xl"
        style={{ backfaceVisibility: "hidden", WebkitBackfaceVisibility: "hidden", transform: "rotateY(180deg)" }}
      >
        <div className="flex items-center justify-between">
          <span className="font-mono text-[10.5px] uppercase tracking-wide text-ink-mute">{day(r.date)}</span>
          <span className={`rounded px-1.5 py-0.5 font-mono text-[11px] font-bold uppercase ${won ? "bg-grass/15 text-grass-deep" : "bg-brick/15 text-brick"}`}>
            {won ? "Won" : "Lost"}
          </span>
        </div>
        <div className="mt-3 flex flex-1 flex-col justify-center gap-2 border-y border-dashed border-ink/15 py-3">
          {r.legs.map((l, k) => (
            <div key={k} className="flex items-center justify-between gap-3">
              <span className="truncate text-[14px] font-bold text-ink">{l.game}</span>
              <span className="flex items-center gap-1.5">
                <span className="font-mono text-[13px] font-bold tabular-nums text-ink">{l.score ?? "—"}</span>
                <span className={`text-[13px] font-bold ${l.hit ? "text-grass-deep" : "text-brick"}`}>{l.hit ? "✓" : "✕"}</span>
              </span>
            </div>
          ))}
        </div>
        <div className="mt-3 flex items-end justify-between">
          <span className={`font-disp text-xl font-extrabold tabular-nums ${dayPL >= 0 ? "text-grass-deep" : "text-brick"}`}>{naira(dayPL)}</span>
          <span className="font-mono text-[10.5px] text-ink-mute tabular-nums">
            run <span className={running >= 0 ? "text-grass-deep" : "text-brick"}>{naira(running)}</span>
          </span>
        </div>
      </div>
    </div>
  );
}
