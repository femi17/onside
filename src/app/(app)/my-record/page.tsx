import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import StickyHeader from "@/components/StickyHeader";
import MobileLogo from "@/components/MobileLogo";

// My Record — the user's OWN graded truth, computed by my_record() from their tracked bets
// and agent picks. The lock-in surface: this data accumulates with every slip and exists
// nowhere else (bookies deliberately never show it). Purely additive page — reads only.

type WL = { graded: number; won: number };
type MyRecord = {
  all_time: WL; last30: WL; week_slips: WL; week_agents: WL;
  families: { family: string; graded: number; won: number }[];
  streak_days: number; first_tracked: string | null;
};

const pct = (w: number, g: number) => (g > 0 ? Math.round((w / g) * 100) : 0);

export default async function MyRecordPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data } = await supabase.rpc("my_record");
  const r = (data as MyRecord | null) ?? null;
  const empty = !r || r.all_time.graded === 0;

  // best/worst families need a real sample before we call them anything
  const rated = (r?.families ?? []).filter((f) => f.graded >= 5);
  const best = rated.length ? rated.reduce((a, b) => (pct(b.won, b.graded) > pct(a.won, a.graded) ? b : a)) : null;
  const worst = rated.length > 1 ? rated.reduce((a, b) => (pct(b.won, b.graded) < pct(a.won, a.graded) ? b : a)) : null;

  return (
    <div className="pb-24">
      <StickyHeader>
        <div className="mx-auto max-w-2xl px-5 pb-3 pt-6 md:px-8">
          <MobileLogo />
          <p className="font-mono text-[11px] uppercase tracking-[0.25em] text-flood">My record</p>
          <h1 className="mt-2 font-disp text-3xl font-bold tracking-tight text-chalk sm:text-4xl">
            Your graded truth.
          </h1>
        </div>
      </StickyHeader>

      <div className="mx-auto max-w-2xl px-5 pt-2 md:px-8">
        {empty ? (
          <div className="mt-8 rounded-2xl border border-white/10 bg-pitch-2 p-8 text-center">
            <p className="font-disp text-xl font-extrabold text-chalk">No graded bets yet.</p>
            <p className="mx-auto mt-2 max-w-sm text-[13.5px] leading-relaxed text-onpitch-mute">
              Track your first slip and this page starts keeping the record your bookie never
              shows you — what you actually win, where, and on which markets.
            </p>
            <div className="mt-5 flex justify-center gap-2.5">
              <Link href="/add" className="rounded-xl bg-flood px-5 py-2.5 text-[14px] font-bold text-ink">Upload a betslip</Link>
              <Link href="/strategies/new" className="rounded-xl border border-white/15 px-5 py-2.5 text-[14px] font-bold text-chalk">Build an agent</Link>
            </div>
          </div>
        ) : (
          <>
            {r!.streak_days > 1 && (
              <p className="mt-4 font-mono text-[12px] font-bold text-flood">🔥 {r!.streak_days}-day tracking streak</p>
            )}

            {/* all-time */}
            <div className="mt-4 grid grid-cols-3 gap-3">
              <div className="rounded-2xl border border-white/10 bg-pitch-2 p-4">
                <div className="font-disp text-2xl font-extrabold text-chalk sm:text-3xl">{r!.all_time.graded}</div>
                <div className="mt-1 font-mono text-[10px] uppercase tracking-wide text-onpitch-mute">bets graded</div>
              </div>
              <div className="rounded-2xl border border-white/10 bg-pitch-2 p-4">
                <div className="font-disp text-2xl font-extrabold text-grass sm:text-3xl">{r!.all_time.won}</div>
                <div className="mt-1 font-mono text-[10px] uppercase tracking-wide text-onpitch-mute">landed</div>
              </div>
              <div className="rounded-2xl border border-white/10 bg-pitch-2 p-4">
                <div className="font-disp text-2xl font-extrabold text-chalk sm:text-3xl">{pct(r!.all_time.won, r!.all_time.graded)}%</div>
                <div className="mt-1 font-mono text-[10px] uppercase tracking-wide text-onpitch-mute">hit rate</div>
              </div>
            </div>
            {r!.first_tracked && (
              <p className="mt-2 font-mono text-[11px] text-onpitch-mute">
                Counting since {new Date(r!.first_tracked).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" })} · last 30 days: {r!.last30.won}/{r!.last30.graded} ({pct(r!.last30.won, r!.last30.graded)}%)
              </p>
            )}

            {/* this week */}
            <h2 className="mt-10 font-disp text-xl font-bold text-chalk">This week</h2>
            <div className="mt-3 grid grid-cols-2 gap-3">
              <div className="rounded-2xl border border-white/10 bg-pitch-2 p-4">
                <div className="font-mono text-[10px] uppercase tracking-wide text-onpitch-mute">Your slips</div>
                <div className="mt-1.5 font-disp text-xl font-extrabold text-chalk">
                  <span className="text-grass">{r!.week_slips.won}</span> of {r!.week_slips.graded} landed
                </div>
              </div>
              <div className="rounded-2xl border border-white/10 bg-pitch-2 p-4">
                <div className="font-mono text-[10px] uppercase tracking-wide text-onpitch-mute">Your agents&apos; picks</div>
                <div className="mt-1.5 font-disp text-xl font-extrabold text-chalk">
                  <span className="text-grass">{r!.week_agents.won}</span> of {r!.week_agents.graded} landed
                </div>
              </div>
            </div>

            {/* where you win */}
            <h2 className="mt-10 font-disp text-xl font-bold text-chalk">Where you win</h2>
            <p className="mt-1 text-[13.5px] text-onpitch-mute">Your record by bet type — the numbers your bookie never shows you.</p>
            <div className="mt-4 flex flex-col gap-2">
              {r!.families.map((f) => {
                const p = pct(f.won, f.graded);
                const tone = f.graded < 5 ? "text-onpitch-mute" : p >= 60 ? "text-grass" : p >= 45 ? "text-flood" : "text-brick";
                return (
                  <div key={f.family} className="flex items-center gap-3">
                    <span className="w-20 flex-none font-mono text-[12px] text-chalk">{f.family}</span>
                    <div className="h-4 flex-1 overflow-hidden rounded bg-white/5">
                      <div className="h-full rounded bg-grass/50" style={{ width: `${p}%` }} />
                    </div>
                    <span className={`w-28 flex-none text-right font-mono text-[12px] font-bold ${tone}`}>
                      {f.won}/{f.graded} · {p}%
                    </span>
                  </div>
                );
              })}
            </div>
            {best && worst && best.family !== worst.family && (
              <p className="mt-3 text-[13px] leading-relaxed text-onpitch-mute">
                Your sharpest edge: <b className="text-grass">{best.family}</b> at {pct(best.won, best.graded)}%.
                Your leak: <b className="text-brick">{worst.family}</b> at {pct(worst.won, worst.graded)}% — worth
                letting an agent screen those before you back them.
              </p>
            )}

            <p className="mt-10 font-mono text-[10px] uppercase tracking-wide text-onpitch-mute">
              Graded exactly like the bookie grades · voids excluded · 18+ · Track responsibly
            </p>
          </>
        )}
      </div>
    </div>
  );
}
