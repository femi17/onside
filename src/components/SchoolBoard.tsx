"use client";

import { useMemo, useState } from "react";

export type SchoolLeg = { game: string; odds: number | null; score: string | null; hit: boolean | null };
export type SchoolRecord = {
  date: string;
  legs: SchoolLeg[];
  combined: number;
  result: "won" | "lost" | "pending";
};

const CHIPS = [5000, 10000, 50000, 100000];

const naira = (n: number) =>
  (n < 0 ? "−₦" : "₦") + Math.round(Math.abs(n)).toLocaleString("en-US");
const shortNaira = (n: number) =>
  n >= 1000 ? "₦" + Math.round(n / 1000) + "k" : "₦" + n;
const fmtDate = (iso: string) =>
  new Date(iso + "T00:00:00Z").toLocaleDateString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });

export default function SchoolBoard({ records }: { records: SchoolRecord[] }) {
  const [stake, setStake] = useState(10000);
  const [revealed, setRevealed] = useState<Set<number>>(new Set());

  const summary = useMemo(() => {
    const graded = records.filter((r) => r.result !== "pending");
    const wins = graded.filter((r) => r.result === "won").length;
    const avgOdds =
      graded.length > 0 ? graded.reduce((a, r) => a + r.combined, 0) / graded.length : 0;
    let cum = 0;
    const series = graded.map((r) => {
      cum += r.result === "won" ? stake * (r.combined - 1) : -stake;
      return cum;
    });
    const total = series.length ? series[series.length - 1] : 0;
    const staked = stake * graded.length;
    return {
      n: graded.length,
      wins,
      losses: graded.length - wins,
      rate: graded.length ? Math.round((wins / graded.length) * 100) : 0,
      avgOdds,
      total,
      staked,
      roi: staked ? Math.round((total / staked) * 100) : 0,
    };
  }, [records, stake]);

  // cumulative P/L up to and including each card (records are oldest → newest)
  const runningByIndex = useMemo(() => {
    let cum = 0;
    return records.map((r) => {
      cum += r.result === "won" ? stake * (r.combined - 1) : -stake;
      return cum;
    });
  }, [records, stake]);

  const toggle = (i: number) =>
    setRevealed((prev) => {
      const next = new Set(prev);
      next.has(i) ? next.delete(i) : next.add(i);
      return next;
    });

  return (
    <div className="mx-auto max-w-5xl px-5 md:px-8">
      {/* summary */}
      <div className="grid grid-cols-3 gap-3">
        <Stat k="Record" v={`${summary.wins}–${summary.losses}`} />
        <Stat k="Win rate" v={`${summary.rate}%`} accent />
        <Stat k="Avg odds" v={summary.avgOdds ? summary.avgOdds.toFixed(2) : "—"} />
      </div>

      {/* profit band */}
      <div className="mt-3 rounded-2xl border border-white/10 bg-pitch-2 p-5">
        <p className="font-mono text-[11px] uppercase tracking-[0.15em] text-onpitch-mute">
          Flat stake · {summary.n}-day P/L
        </p>
        <p
          className={`mt-1 font-disp text-4xl font-extrabold tracking-tight tabular-nums ${
            summary.total >= 0 ? "text-flood" : "text-rose-400"
          }`}
        >
          {naira(summary.total)}
        </p>
        <p className="mt-1.5 font-mono text-[11px] text-onpitch-mute tabular-nums">
          {shortNaira(stake)}/day · {naira(summary.staked)} staked ·{" "}
          {summary.roi >= 0 ? "+" : "−"}
          {Math.abs(summary.roi)}% ROI
        </p>
      </div>

      {/* stake control */}
      <div className="mt-5">
        <label
          htmlFor="school-stake"
          className="mb-2 block font-mono text-[11px] uppercase tracking-[0.15em] text-onpitch-mute"
        >
          Your daily stake — see what you&apos;d have made
        </label>
        <div className="flex h-[52px] items-center rounded-xl border border-white/10 bg-pitch-2 px-4">
          <span className="mr-1.5 font-disp text-lg font-bold text-onpitch-mute">₦</span>
          <input
            id="school-stake"
            inputMode="numeric"
            value={stake.toLocaleString("en-US")}
            onChange={(e) => setStake(Math.max(0, Number(e.target.value.replace(/[^\d]/g, "")) || 0))}
            className="w-full bg-transparent font-disp text-xl font-extrabold tabular-nums text-chalk outline-none"
            aria-label="Daily stake in naira"
          />
        </div>
        <div className="mt-2.5 flex gap-2">
          {CHIPS.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => setStake(c)}
              aria-pressed={stake === c}
              className={`flex-1 rounded-full border px-0 py-2 font-mono text-[12px] font-bold tabular-nums transition ${
                stake === c
                  ? "border-flood bg-flood/15 text-flood"
                  : "border-white/10 bg-pitch-2 text-onpitch-mute hover:text-onpitch"
              }`}
            >
              {shortNaira(c)}
            </button>
          ))}
        </div>
      </div>

      {/* record cards */}
      <div className="mt-7">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="font-disp text-lg font-bold tracking-tight text-chalk">The record</h2>
          <span className="font-mono text-[11px] text-onpitch-mute">Tap a card to reveal</span>
        </div>

        {records.length === 0 ? (
          <p className="rounded-xl border border-white/10 bg-pitch-2 p-6 text-center text-sm text-onpitch-mute">
            No settled doubles yet — the record starts filling as games finish.
          </p>
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {records
              .map((r, i) => ({ r, i }))
              .reverse() /* newest first for display */
              .map(({ r, i }) => {
                const open = revealed.has(i);
                const dayPL = r.result === "won" ? stake * (r.combined - 1) : -stake;
                return (
                  <button
                    key={r.date + i}
                    type="button"
                    onClick={() => toggle(i)}
                    className={`flex min-h-[176px] flex-col rounded-2xl border p-4 text-left transition ${
                      open
                        ? r.result === "won"
                          ? "border-flood/50 bg-flood/[0.06]"
                          : "border-rose-400/40 bg-rose-400/[0.05]"
                        : "border-white/10 bg-pitch-2 hover:border-white/20"
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <span className="font-mono text-[11px] uppercase tracking-[0.12em] text-onpitch-mute">
                        {fmtDate(r.date)}
                      </span>
                      {open ? (
                        <span
                          className={`font-mono text-[11px] font-bold uppercase tracking-[0.1em] ${
                            r.result === "won" ? "text-flood" : "text-rose-400"
                          }`}
                        >
                          {r.result === "won" ? "Won" : "Lost"}
                        </span>
                      ) : (
                        <span className="font-mono text-[11px] font-bold uppercase tracking-[0.1em] text-flood">
                          @{r.combined.toFixed(2)}
                        </span>
                      )}
                    </div>

                    {!open ? (
                      <div className="mt-3 flex flex-1 flex-col gap-2">
                        {r.legs.map((l, k) => (
                          <div key={k} className="flex items-center justify-between gap-2">
                            <span className="truncate text-[13px] font-semibold text-onpitch">{l.game}</span>
                            <span className="shrink-0 font-mono text-[12px] font-bold tabular-nums text-chalk">
                              {l.odds ? l.odds.toFixed(2) : "—"}
                            </span>
                          </div>
                        ))}
                        <div className="mt-auto flex items-center justify-between pt-2">
                          <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-onpitch-mute">
                            Over 2.5 double
                          </span>
                          <span className="font-mono text-[11px] text-onpitch-mute tabular-nums">
                            returns {naira(stake * r.combined)}
                          </span>
                        </div>
                      </div>
                    ) : (
                      <div className="mt-3 flex flex-1 flex-col gap-2">
                        {r.legs.map((l, k) => (
                          <div key={k} className="flex items-center justify-between gap-2">
                            <span className="truncate text-[13px] font-semibold text-onpitch">{l.game}</span>
                            <span className="flex shrink-0 items-center gap-1.5">
                              <span className="font-mono text-[12px] font-bold tabular-nums text-chalk">
                                {l.score ?? "—"}
                              </span>
                              <span
                                className={`text-[12px] font-bold ${l.hit ? "text-flood" : "text-rose-400"}`}
                              >
                                {l.hit ? "✓" : "✕"}
                              </span>
                            </span>
                          </div>
                        ))}
                        <div className="mt-auto flex items-end justify-between pt-2">
                          <span
                            className={`font-disp text-xl font-extrabold tabular-nums ${
                              dayPL >= 0 ? "text-flood" : "text-rose-400"
                            }`}
                          >
                            {naira(dayPL)}
                          </span>
                          <span className="text-right font-mono text-[10px] uppercase tracking-[0.1em] text-onpitch-mute">
                            running{" "}
                            <span className={runningByIndex[i] >= 0 ? "text-flood" : "text-rose-400"}>
                              {naira(runningByIndex[i])}
                            </span>
                          </span>
                        </div>
                      </div>
                    )}
                  </button>
                );
              })}
          </div>
        )}
      </div>

      <p className="mt-7 border-t border-white/10 pt-4 font-mono text-[11px] leading-relaxed text-onpitch-mute">
        Real results. Each card is an actual Onside Double regraded as its two Over&nbsp;2.5 legs — it only wins
        if <span className="text-onpitch">both</span> games hit 3+ goals. Odds shown are each leg&apos;s Over&nbsp;2.5
        price. <span className="text-onpitch">Flat staking only</span> — the same stake every day, win or lose. A
        losing day is a cost of business, not a signal to chase. 18+ · bet responsibly.
      </p>
    </div>
  );
}

function Stat({ k, v, accent = false }: { k: string; v: string; accent?: boolean }) {
  return (
    <div className="rounded-xl border border-white/10 bg-pitch-2 p-3.5">
      <p className="font-mono text-[10.5px] uppercase tracking-[0.12em] text-onpitch-mute">{k}</p>
      <p className={`mt-1 font-disp text-2xl font-extrabold tabular-nums ${accent ? "text-flood" : "text-chalk"}`}>
        {v}
      </p>
    </div>
  );
}
