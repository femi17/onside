"use client";

// Owner-only forward-test lab. Tabs pick one of the 3 candidate School lines; the WHOLE view below is
// that line rendered through the REAL member dashboard (SchoolMember) — same stake input, same swipe
// deck of cream betslips, same profit header — just fed a different line's record. ★ Set-as-default
// persists the choice (set_school_default → school_config) so the daily DM + a future member view can
// follow it. No bespoke UI: members and I look at the exact same component.
import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { SchoolMember, type SchoolRecord } from "./SchoolBoard";

export type StrategyView = {
  key: string;
  name: string;
  noun: string; // "double" | "treble" — relabels SchoolMember's "Today's …" line
  records: SchoolRecord[];
  upcoming: SchoolRecord | null;
};

export default function SchoolStrategyDeck({
  strategies,
  defaultKey,
  userId,
  admin = false,
  todayPosted = false,
  todayTracked = false,
}: {
  strategies: StrategyView[];
  defaultKey: string;
  userId: string;
  admin?: boolean;
  todayPosted?: boolean;
  todayTracked?: boolean;
}) {
  const router = useRouter();
  const [active, setActive] = useState(Math.max(0, strategies.findIndex((s) => s.key === defaultKey)));
  const [dflt, setDflt] = useState(defaultKey);
  const [saving, setSaving] = useState(false);
  if (!strategies.length) return null;
  const sel = strategies[Math.min(active, strategies.length - 1)];
  // The live Onside Double is the real, editable bet — restore full admin editing (per-leg odds +
  // outcome/line via the LegEditor) on it. The model forward-test lines are derived, so they stay
  // read-only (nothing to persist).
  const editable = admin && sel.key === "school_double";

  const makeDefault = async () => {
    setSaving(true);
    try {
      await createClient().rpc("set_school_default", { p_key: sel.key });
      setDflt(sel.key);
      router.refresh();
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mx-auto mt-4 max-w-[960px] px-5 md:px-8">
      {/* tabs — pick the line; the whole board below re-renders as that line */}
      <p className="mb-2 font-mono text-[10.5px] uppercase tracking-[0.12em] text-onpitch-mute">Forward-test · pick the line</p>
      <div className="no-scrollbar -mx-1 flex gap-2 overflow-x-auto px-1 pb-1">
        {strategies.map((s, i) => (
          <button
            key={s.key}
            type="button"
            onClick={() => setActive(i)}
            aria-pressed={i === active}
            className={`flex-none rounded-xl border px-3.5 py-2.5 text-left leading-tight transition ${
              i === active ? "border-flood bg-flood/[0.12] text-chalk" : "border-white/10 bg-pitch-2 text-onpitch-mute"
            }`}
          >
            <span className="block font-mono text-[12px] font-bold">
              {dflt === s.key ? "★ " : ""}
              {s.name}
            </span>
            <span className="mt-0.5 block font-mono text-[10.5px] text-onpitch-mute">
              {s.records.filter((r) => r.result === "won").length}–{s.records.filter((r) => r.result === "lost").length}
            </span>
          </button>
        ))}
      </div>

      {/* set-as-default */}
      <button
        type="button"
        onClick={makeDefault}
        disabled={saving || dflt === sel.key}
        className={`mt-2 w-full rounded-xl py-2 font-disp text-sm font-bold transition disabled:opacity-70 ${
          dflt === sel.key ? "bg-grass/15 text-grass-deep" : "bg-flood text-ink hover:brightness-105"
        }`}
      >
        {dflt === sel.key ? "★ This line is the School default" : saving ? "Setting…" : `★ Set “${sel.name}” as the School default`}
      </button>

      {/* the chosen line, rendered through the real member dashboard (stake input + swipe deck) */}
      <SchoolMember
        key={sel.key}
        records={sel.records}
        upcoming={sel.upcoming}
        admin={editable}
        todayPosted={editable ? todayPosted : true}
        todayTracked={todayTracked}
        userId={userId}
        eyebrow={editable ? "Onside School" : "Onside School · Forward-test"}
        heading={sel.name}
        noun={sel.noun}
        hideTrack={!editable}
      />
    </div>
  );
}
