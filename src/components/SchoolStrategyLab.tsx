"use client";

// Owner-only School view: tabs pick one of the 3 candidate lines, and EVERYTHING below (the profit
// header + stat boxes + full day-by-day record) is that line's data. The default line is active on
// load; ★ Set-as-default persists the choice (set_school_default RPC). Data: school_strategy_records().
import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

type Day = { day: string; result: "won" | "lost"; odds: number; games: string[] };
type Strat = { key: string; name: string; legs: number; won: number; lost: number; profit: number; days: Day[] };
type Data = { since?: string; default?: string; strategies?: Strat[] } | null;

const naira = (n: number) => (n < 0 ? "−₦" : "₦") + Math.round(Math.abs(n)).toLocaleString("en-US");
const short = (n: number) => (n >= 1000 ? "₦" + Math.round(n / 1000) + "k" : "₦" + n);
const dayLabel = (iso: string) =>
  new Date(iso + "T00:00:00Z").toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });

export default function SchoolStrategyLab({ data, stake = 10000 }: { data: Data; stake?: number }) {
  const strategies = (data?.strategies ?? []).filter((s) => s && s.key);
  const defaultKeyInit = data?.default ?? strategies[0]?.key ?? "";
  const [active, setActive] = useState(Math.max(0, strategies.findIndex((s) => s.key === defaultKeyInit)));
  const [defaultKey, setDefaultKey] = useState(defaultKeyInit);
  const [saving, setSaving] = useState(false);
  const router = useRouter();
  if (!strategies.length) return null;

  const s = strategies[Math.min(active, strategies.length - 1)];
  const settled = s.won + s.lost;
  const roi = settled ? Math.round((s.profit / settled) * 100) : 0;
  const strike = settled ? Math.round((s.won / settled) * 100) : 0;
  const staked = stake * settled;
  const profitMoney = s.profit * stake;
  const returned = staked + profitMoney;
  const under1x = s.name.includes("1X");

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
      {/* tabs — pick the line */}
      <div className="flex gap-2 overflow-x-auto pb-1">
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
            {defaultKey === st.key ? "★ " : ""}{st.name}
          </button>
        ))}
      </div>

      {/* profit header for the selected line */}
      <div className="mt-3 rounded-2xl border border-white/10 bg-gradient-to-b from-pitch-2 to-pitch p-5 md:p-6">
        <p className="font-mono text-[10.5px] uppercase tracking-[0.14em] text-flood">
          Profit · {short(stake)}/day · {settled} days · {roi >= 0 ? "+" : "−"}{Math.abs(roi)}% ROI
        </p>
        <p className={`mt-1 font-disp text-5xl font-extrabold tracking-tight tabular-nums ${profitMoney >= 0 ? "text-flood" : "text-brick"}`}>
          {naira(profitMoney)}
        </p>
        <p className="mt-1 max-w-md text-[12.5px] leading-snug text-onpitch-mute">
          {naira(staked)} staked → {naira(returned)} back · {s.name}, flat stakes since {data?.since ?? "Sep 7"}.
        </p>
        <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Stat label="Record" value={`${s.won}–${s.lost}`} />
          <Stat label="Strike rate" value={`${strike}%`} />
          <Stat label="Staked" value={naira(staked)} />
          <Stat label="Returned" value={naira(returned)} tone={returned >= staked ? "text-grass" : "text-brick"} />
        </div>
        <button
          type="button"
          disabled={saving || defaultKey === s.key}
          onClick={() => makeDefault(s.key)}
          className={`mt-4 w-full rounded-xl py-2 font-disp text-sm font-bold transition disabled:opacity-70 ${
            defaultKey === s.key ? "bg-grass/15 text-grass-deep" : "bg-flood text-pitch hover:bg-flood/90"
          }`}
        >
          {defaultKey === s.key ? "★ This is the School default" : saving ? "Setting…" : "Set as School default"}
        </button>
      </div>

      {/* the record — day-by-day cream betslips, newest first */}
      <p className="mt-5 font-mono text-[10.5px] uppercase tracking-[0.12em] text-onpitch-mute">The record · newest first</p>
      <div className="mt-2 space-y-2">
        {s.days.length === 0 && <p className="rounded-2xl border border-dashed border-white/15 bg-pitch-2 p-6 text-center text-sm text-onpitch-mute">No settled days yet.</p>}
        {[...s.days].reverse().map((d, i) => (
          <div key={i} className="rounded-2xl bg-chalk p-4 text-ink shadow-lg">
            <div className="flex items-center justify-between">
              <span className="font-mono text-[10.5px] uppercase tracking-wide text-ink-mute">{dayLabel(d.day)}</span>
              <span className={`rounded px-2 py-0.5 font-mono text-[11px] font-bold uppercase ${d.result === "won" ? "bg-grass/15 text-grass-deep" : "bg-brick/15 text-brick"}`}>
                {d.result}
              </span>
            </div>
            <div className="my-2 space-y-1.5 border-y border-dashed border-ink/15 py-2">
              {d.games.map((g, k) => (
                <div key={k} className="flex items-center justify-between gap-3">
                  <span className="min-w-0 truncate text-[13.5px] font-bold leading-tight text-ink">{g}</span>
                  <span className="flex-none font-mono text-[11px] font-bold text-flood-deep">{under1x ? "1X" : "Over 2.5"}</span>
                </div>
              ))}
            </div>
            <div className="flex items-center justify-between">
              <span className="font-mono text-[10px] uppercase tracking-wide text-ink-mute">Combined ~{d.odds}</span>
              <span className={`font-disp text-base font-extrabold tabular-nums ${d.result === "won" ? "text-grass-deep" : "text-brick"}`}>
                {d.result === "won" ? naira(stake * (d.odds - 1)) : naira(-stake)}
              </span>
            </div>
          </div>
        ))}
      </div>
      <p className="mt-3 font-mono text-[10px] text-onpitch-mute">
        ~ odds are model estimates until real prices bank in · flip a tab to compare · tracking to year-end
      </p>
    </div>
  );
}

function Stat({ label, value, tone = "text-chalk" }: { label: string; value: string; tone?: string }) {
  return (
    <div className="rounded-xl border border-white/10 bg-pitch/40 px-3 py-2">
      <div className="font-mono text-[9.5px] uppercase tracking-wide text-onpitch-mute">{label}</div>
      <div className={`mt-0.5 font-disp text-base font-bold tabular-nums ${tone}`}>{value}</div>
    </div>
  );
}
