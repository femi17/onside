"use client";

// Owner-only School lab: flip between the 3 candidate lines (Onside Double O2.5 · Best O2.5 · DC 1X
// treble), see each one's day-by-day games + result + running profit, and ★ Set one as the School
// default. Data from school_strategy_records(); the default is persisted via set_school_default().
import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

type Day = { day: string; result: "won" | "lost"; odds: number; games: string[] };
type Strat = { key: string; name: string; legs: number; won: number; lost: number; profit: number; days: Day[] };
type Data = { since?: string; default?: string; strategies?: Strat[] } | null;

const naira = (n: number) => (n < 0 ? "−₦" : "₦") + Math.round(Math.abs(n)).toLocaleString("en-US");
const dayLabel = (iso: string) =>
  new Date(iso + "T00:00:00Z").toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });

export default function SchoolStrategyLab({ data, stake = 10000 }: { data: Data; stake?: number }) {
  const strategies = (data?.strategies ?? []).filter((s) => s && s.key);
  const [active, setActive] = useState(0);
  const [defaultKey, setDefaultKey] = useState(data?.default ?? "school_double");
  const [saving, setSaving] = useState(false);
  const router = useRouter();
  if (!strategies.length) return null;

  const s = strategies[Math.min(active, strategies.length - 1)];
  const settled = s.won + s.lost;
  const roi = settled ? Math.round((s.profit / settled) * 100) : 0;
  const money = s.profit * stake;

  const makeDefault = async (key: string) => {
    setSaving(true);
    try {
      await createClient().rpc("set_school_default", { p_key: key });
      setDefaultKey(key);
      router.refresh();
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mx-auto mt-6 max-w-[960px] px-5 md:px-8">
      <p className="font-mono text-[10.5px] uppercase tracking-[0.14em] text-onpitch-mute">
        Owner lab · forward test since {data?.since ?? "Sep 7"} · pick the School line
      </p>

      {/* strategy tabs */}
      <div className="mt-2 flex gap-2 overflow-x-auto pb-1">
        {strategies.map((st, i) => (
          <button
            key={st.key}
            type="button"
            onClick={() => setActive(i)}
            aria-pressed={i === active}
            className={`flex-none rounded-xl border px-3 py-2 font-mono text-[11px] font-bold tabular-nums transition ${
              i === active ? "border-flood bg-flood/15 text-flood" : "border-white/10 bg-pitch-2 text-onpitch-mute"
            }`}
          >
            {defaultKey === st.key ? "★ " : ""}{st.name} · {st.won}-{st.lost}
          </button>
        ))}
      </div>

      {/* selected strategy */}
      <div className="mt-3 rounded-2xl border border-white/10 bg-pitch-2 p-5">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="font-disp text-lg font-bold text-chalk">{s.name}</p>
            <p className="mt-0.5 text-[11px] text-onpitch-mute">
              <b className="text-chalk">{s.won}–{s.lost}</b> · {roi >= 0 ? "+" : "−"}{Math.abs(roi)}% ROI · {s.legs} legs
            </p>
          </div>
          <div className="flex-none text-right">
            <p className={`font-disp text-2xl font-extrabold tabular-nums ${money >= 0 ? "text-grass" : "text-brick"}`}>{naira(money)}</p>
            <p className="text-[10px] text-onpitch-mute">at {naira(stake)}/day</p>
          </div>
        </div>

        <button
          type="button"
          disabled={saving || defaultKey === s.key}
          onClick={() => makeDefault(s.key)}
          className={`mt-3 w-full rounded-xl py-2 font-disp text-sm font-bold transition disabled:opacity-70 ${
            defaultKey === s.key ? "bg-grass/15 text-grass-deep" : "bg-flood text-pitch hover:bg-flood/90"
          }`}
        >
          {defaultKey === s.key ? "★ Current School default" : saving ? "Setting…" : "Set as School default"}
        </button>

        {/* day-by-day games (newest first) */}
        <div className="mt-4 space-y-2">
          {s.days.length === 0 && <p className="text-center text-sm text-onpitch-mute">No settled days yet.</p>}
          {[...s.days].reverse().map((d, i) => (
            <div
              key={i}
              className={`rounded-xl border px-3 py-2 ${d.result === "won" ? "border-grass/25 bg-grass/[0.05]" : "border-brick/25 bg-brick/[0.05]"}`}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="font-mono text-[10.5px] text-onpitch-mute">{dayLabel(d.day)}</span>
                <span className={`flex-none font-mono text-[11px] font-bold ${d.result === "won" ? "text-grass" : "text-brick"}`}>
                  {d.result === "won" ? "WON" : "LOST"} · ~{d.odds}
                </span>
              </div>
              <p className="mt-1 text-[12.5px] leading-snug text-chalk">{d.games.join("  +  ")}</p>
            </div>
          ))}
        </div>
      </div>

      <p className="mt-2 font-mono text-[10px] text-onpitch-mute">
        ~ odds are model estimates until real prices bank in · flat stakes · tracking to year-end
      </p>
    </div>
  );
}
