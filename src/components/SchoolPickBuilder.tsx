"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

// The bet outcomes an admin can pick for a School leg — every one auto-grades from the final score
// (see gradePick in the school page). Key = grading key, label = what shows on the slip.
export const SCHOOL_OUTCOMES: Array<[string, string]> = [
  ["over_1_5", "Over 1.5"],
  ["over_2_5", "Over 2.5"],
  ["over_3_5", "Over 3.5"],
  ["under_1_5", "Under 1.5"],
  ["under_2_5", "Under 2.5"],
  ["under_3_5", "Under 3.5"],
  ["under_4_5", "Under 4.5"],
  ["btts_yes", "BTTS — Yes"],
  ["btts_no", "BTTS — No"],
  ["home", "Home win"],
  ["draw", "Draw"],
  ["away", "Away win"],
  ["dc_1x", "Home or Draw (1X)"],
  ["dc_12", "Home or Away (12)"],
  ["dc_x2", "Draw or Away (X2)"],
  ["home_ts", "Home to score"],
  ["away_ts", "Away to score"],
];

type Fixture = {
  id: number;
  kickoff_utc: string;
  home_team: string;
  away_team: string;
  status: string | null;
  leagues: { name: string | null } | null;
};
export type TodayPick = { id: string; fixture_id: number; game: string; label: string; odds: number };

const clock = (iso: string) =>
  new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Africa/Lagos" });

// Admin-only card to hand-build a day's School slip: search a match, pick the outcome, type the odds.
// Each add writes a row to school_picks (auto-graded into the record). Members never see this.
export default function SchoolPickBuilder({ setDate, picks }: { setDate: string; picks: TodayPick[] }) {
  const router = useRouter();
  const supabase = createClient();

  const [q, setQ] = useState("");
  const [results, setResults] = useState<Fixture[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [picked, setPicked] = useState<Fixture | null>(null);
  const [market, setMarket] = useState("over_2_5");
  const [odds, setOdds] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  // search upcoming + live fixtures by team or league name (global), debounced
  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) {
      setResults(null);
      setSearching(false);
      return;
    }
    let cancelled = false;
    setSearching(true);
    const t = setTimeout(async () => {
      const like = `%${term}%`;
      const liveFloor = new Date(Date.now() - 4 * 3600 * 1000).toISOString();
      const { data: lgs } = await supabase.from("leagues").select("id").or(`name.ilike.${like},country.ilike.${like}`).limit(80);
      const ids = (lgs ?? []).map((l) => l.id);
      const orMatch = [`home_team.ilike.${like}`, `away_team.ilike.${like}`];
      if (ids.length) orMatch.push(`league_id.in.(${ids.join(",")})`);
      const { data } = await supabase
        .from("fixtures")
        .select("id, kickoff_utc, home_team, away_team, status, leagues(name)")
        .gte("kickoff_utc", liveFloor)
        .or(orMatch.join(","))
        .order("kickoff_utc", { ascending: true })
        .limit(40);
      if (!cancelled) {
        setResults((data ?? []) as unknown as Fixture[]);
        setSearching(false);
      }
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  async function addPick() {
    if (!picked) return;
    const num = parseFloat(odds);
    if (!Number.isFinite(num) || num <= 1) {
      setMsg("Enter odds greater than 1.");
      return;
    }
    const label = SCHOOL_OUTCOMES.find(([k]) => k === market)?.[1] ?? market;
    setBusy(true);
    setMsg(null);
    const { error } = await supabase.rpc("school_add_pick", {
      p_date: setDate,
      p_fixture_id: picked.id,
      p_market: market,
      p_label: label,
      p_odds: Math.round(num * 100) / 100,
    });
    setBusy(false);
    if (error) {
      setMsg(error.message);
      return;
    }
    // reset for the next leg
    setPicked(null);
    setQ("");
    setResults(null);
    setOdds("");
    setMarket("over_2_5");
    router.refresh();
  }

  async function removePick(id: string) {
    setBusy(true);
    await supabase.rpc("school_remove_pick", { p_id: id });
    setBusy(false);
    router.refresh();
  }

  return (
    <div className="rounded-2xl border border-flood/30 bg-chalk-2 p-4 text-ink shadow-lg">
      <div className="flex items-center justify-between">
        <span className="font-disp text-lg font-extrabold">Build today&apos;s slip</span>
        <span className="font-mono text-[11px] text-ink-mute">{setDate}</span>
      </div>
      <p className="mt-0.5 font-mono text-[10.5px] uppercase tracking-wide text-ink-mute">Admin only · pick match · outcome · odds</p>

      {/* 1 · match */}
      {!picked ? (
        <div className="mt-3">
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search a team or league…"
            className="w-full rounded-lg border border-ink/20 bg-white px-3 py-2.5 text-sm text-ink outline-none focus:border-flood"
          />
          {searching && <p className="mt-2 font-mono text-[11px] text-ink-mute">Searching…</p>}
          {results && results.length > 0 && (
            <div className="no-scrollbar mt-2 flex max-h-56 flex-col gap-1.5 overflow-y-auto">
              {results.map((f) => (
                <button
                  key={f.id}
                  onClick={() => {
                    setPicked(f);
                    setResults(null);
                  }}
                  className="flex items-center justify-between gap-2 rounded-lg border border-ink/10 px-3 py-2 text-left hover:border-flood/50"
                >
                  <span className="min-w-0">
                    <span className="block truncate text-[13px] font-bold">
                      {f.home_team} <span className="text-ink-mute">v</span> {f.away_team}
                    </span>
                    <span className="block truncate font-mono text-[10.5px] text-ink-mute">
                      {f.leagues?.name ?? ""} · {clock(f.kickoff_utc)}
                    </span>
                  </span>
                  <span className="font-mono text-lg text-flood-deep">+</span>
                </button>
              ))}
            </div>
          )}
          {results && results.length === 0 && !searching && <p className="mt-2 font-mono text-[11px] text-ink-mute">No matches found.</p>}
        </div>
      ) : (
        <div className="mt-3 space-y-3">
          <div className="flex items-center justify-between gap-2 rounded-lg border border-flood/40 bg-flood/5 px-3 py-2">
            <span className="min-w-0">
              <span className="block truncate text-[13px] font-bold">
                {picked.home_team} <span className="text-ink-mute">v</span> {picked.away_team}
              </span>
              <span className="block truncate font-mono text-[10.5px] text-ink-mute">
                {picked.leagues?.name ?? ""} · {clock(picked.kickoff_utc)}
              </span>
            </span>
            <button onClick={() => setPicked(null)} className="font-mono text-sm text-ink-mute hover:text-brick" aria-label="Change match">
              change
            </button>
          </div>

          {/* 2 · outcome + 3 · odds */}
          <div className="flex gap-2">
            <select
              value={market}
              onChange={(e) => setMarket(e.target.value)}
              className="min-w-0 flex-1 rounded-lg border border-ink/20 bg-white px-3 py-2.5 text-sm font-semibold text-ink outline-none focus:border-flood"
            >
              {SCHOOL_OUTCOMES.map(([k, lbl]) => (
                <option key={k} value={k}>
                  {lbl}
                </option>
              ))}
            </select>
            <input
              inputMode="decimal"
              value={odds}
              onChange={(e) => setOdds(e.target.value.replace(/[^\d.]/g, ""))}
              placeholder="odds"
              className="w-20 rounded-lg border border-ink/20 bg-white px-3 py-2.5 text-right font-mono text-sm font-bold text-ink outline-none focus:border-flood"
            />
          </div>

          <button
            onClick={addPick}
            disabled={busy || !odds}
            className="w-full rounded-xl bg-flood px-4 py-2.5 font-disp text-sm font-extrabold text-ink transition hover:brightness-105 disabled:opacity-40"
          >
            {busy ? "Adding…" : "Add pick"}
          </button>
        </div>
      )}

      {msg && <p className="mt-2 font-mono text-[11px] text-brick">{msg}</p>}

      {/* today's picks */}
      {picks.length > 0 && (
        <div className="mt-4 border-t border-dashed border-ink/15 pt-3">
          <p className="mb-2 font-mono text-[10.5px] uppercase tracking-wide text-ink-mute">Today&apos;s slip · {picks.length} leg{picks.length === 1 ? "" : "s"}</p>
          <div className="flex flex-col gap-1.5">
            {picks.map((p) => (
              <div key={p.id} className="flex items-center justify-between gap-2 rounded-lg border border-ink/10 px-3 py-2">
                <span className="min-w-0">
                  <span className="block truncate text-[13px] font-bold">{p.game}</span>
                  <span className="font-mono text-[10.5px] font-bold text-flood-deep">{p.label} @ {p.odds.toFixed(2)}</span>
                </span>
                <button onClick={() => removePick(p.id)} disabled={busy} className="font-mono text-ink-mute hover:text-brick" aria-label="Remove pick">
                  ×
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
