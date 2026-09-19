"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";

// Admin-only: set the SportyBet booking/verify code for a day's Onside School card. The code shows
// under that day's card on /school (to members + admins) so they can load the exact slip in one paste.
// One card per day, so the code is keyed by date. Blank code clears it. Writes go through the
// is_admin-gated school_set_code RPC; the recent list comes from school_codes_recent (admin-only).
type Row = { set_date: string; code: string; updated_at: string };

const lagosToday = () => new Date().toLocaleDateString("en-CA", { timeZone: "Africa/Lagos" });

export default function SchoolCodeUploader() {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [date, setDate] = useState(lagosToday());
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  async function load() {
    const supabase = createClient();
    const { data, error } = await supabase.rpc("school_codes_recent");
    if (error) {
      // before the migration is applied the RPC doesn't exist — stay quiet rather than alarm
      const notMigrated = error.code === "PGRST202" || /Could not find the function|schema cache/i.test(error.message);
      if (!notMigrated) setErr(error.message);
      setRows([]);
      return;
    }
    setRows((data ?? []) as Row[]);
  }

  useEffect(() => {
    load();
  }, []);

  // prefill the field when the chosen date already has a code
  useEffect(() => {
    const existing = rows?.find((r) => r.set_date === date);
    setCode(existing?.code ?? "");
  }, [date, rows]);

  async function save() {
    setBusy(true);
    setErr(null);
    setSaved(false);
    const supabase = createClient();
    const { error } = await supabase.rpc("school_set_code", { p_date: date, p_code: code });
    setBusy(false);
    if (error) {
      setErr(error.message);
      return;
    }
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
    load();
  }

  return (
    <section className="mt-6 rounded-2xl border border-white/10 bg-pitch-2 p-5">
      <p className="font-mono text-[10.5px] uppercase tracking-[0.2em] text-flood">Onside School · SportyBet code</p>
      <h2 className="mt-1 font-disp text-lg font-bold text-chalk">Booking code for a day&apos;s card</h2>
      <p className="mt-1 text-[13px] text-onpitch-mute">
        Shows under that day&apos;s card on /school (members &amp; you). Leave blank and save to clear it.
      </p>

      <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-end">
        <label className="flex flex-col gap-1">
          <span className="font-mono text-[10.5px] uppercase tracking-wide text-onpitch-mute">Date</span>
          <input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className="h-11 rounded-xl border border-white/10 bg-pitch px-3 font-mono text-sm text-chalk outline-none focus:border-flood/50"
          />
        </label>
        <label className="flex flex-1 flex-col gap-1">
          <span className="font-mono text-[10.5px] uppercase tracking-wide text-onpitch-mute">SportyBet code</span>
          <input
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            placeholder="e.g. AB12CD"
            className="h-11 rounded-xl border border-white/10 bg-pitch px-3 font-disp text-base font-bold tracking-[0.08em] text-chalk outline-none focus:border-flood/50"
          />
        </label>
        <button
          onClick={save}
          disabled={busy}
          className="h-11 flex-none rounded-xl bg-flood px-5 font-disp text-sm font-bold text-pitch transition hover:bg-flood/90 disabled:opacity-40"
        >
          {busy ? "Saving…" : saved ? "Saved ✓" : "Save code"}
        </button>
      </div>
      {err && <p className="mt-3 text-[13px] text-brick">{err}</p>}

      {rows && rows.length > 0 && (
        <div className="mt-4 border-t border-white/10 pt-3">
          <p className="font-mono text-[10px] uppercase tracking-wide text-onpitch-mute">Recent codes · tap to edit</p>
          <div className="mt-2 flex flex-col gap-1">
            {rows.map((r) => (
              <button
                key={r.set_date}
                type="button"
                onClick={() => setDate(r.set_date)}
                className={`flex items-center justify-between rounded-lg px-2 py-1.5 text-left transition hover:bg-white/5 ${
                  r.set_date === date ? "bg-white/5" : ""
                }`}
              >
                <span className="font-mono text-[12px] text-onpitch-mute">{r.set_date}</span>
                <span className="font-disp text-sm font-bold tracking-[0.08em] text-chalk">{r.code}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
