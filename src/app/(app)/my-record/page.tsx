import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import StickyHeader from "@/components/StickyHeader";
import MobileLogo from "@/components/MobileLogo";

// My Record — the user's OWN graded truth, computed by my_record() from their tracked bets
// and agent picks. The lock-in surface: this data accumulates with every slip and exists
// nowhere else (bookies deliberately never show it). Visual language: the record IS a
// receipt, so the numbers live on the app's chalk/betslip cards against the pitch shell —
// same two-surface rhythm as Performance and the shared slip pages.

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
          <div className="mt-8 rounded-2xl border border-dashed border-ink/15 bg-chalk p-10 text-center text-ink shadow-xl">
            <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-flood/15 font-mono text-xl text-flood-deep">◆</div>
            <p className="font-disp text-xl font-extrabold text-ink">No graded bets yet.</p>
            <p className="mx-auto mt-2 max-w-sm text-[13.5px] leading-relaxed text-ink-mute">
              Track your first slip and this page starts keeping the record your bookie never
              shows you — what you actually win, where, and on which markets.
            </p>
            <div className="mt-5 flex justify-center gap-2.5">
              <Link href="/add" className="rounded-xl bg-flood px-5 py-2.5 text-[14px] font-bold text-ink">Upload a betslip</Link>
              <Link href="/strategies/new" className="rounded-xl border border-ink/20 px-5 py-2.5 text-[14px] font-bold text-ink">Build an agent</Link>
            </div>
          </div>
        ) : (
          <>
            {/* the record itself — a settled receipt on the chalk slip card */}
            <section className="betslip betslip-chalk mt-4 rounded-2xl bg-chalk text-ink shadow-xl">
              <div className="border-b border-dashed border-ink/15 p-5">
                <div className="flex items-center justify-between gap-2">
                  <span className="rounded bg-ink px-1.5 py-0.5 font-mono text-[11px] font-bold uppercase tracking-wider text-chalk-2">All time</span>
                  {r!.streak_days > 1 && (
                    <span className="font-mono text-[11px] font-bold text-flood-deep">🔥 {r!.streak_days}-day streak</span>
                  )}
                </div>
                <div className="mt-4 grid grid-cols-3 gap-3">
                  <div>
                    <div className="font-disp text-[28px] font-extrabold leading-none tracking-tight text-ink sm:text-[32px]">{r!.all_time.graded}</div>
                    <div className="mt-1.5 font-mono text-[10px] uppercase tracking-wide text-ink-mute">bets graded</div>
                  </div>
                  <div>
                    <div className="font-disp text-[28px] font-extrabold leading-none tracking-tight text-grass-deep sm:text-[32px]">{r!.all_time.won}</div>
                    <div className="mt-1.5 font-mono text-[10px] uppercase tracking-wide text-ink-mute">landed</div>
                  </div>
                  <div>
                    <div className="font-disp text-[28px] font-extrabold leading-none tracking-tight text-flood-deep sm:text-[32px]">{pct(r!.all_time.won, r!.all_time.graded)}%</div>
                    <div className="mt-1.5 font-mono text-[10px] uppercase tracking-wide text-ink-mute">hit rate</div>
                  </div>
                </div>
              </div>
              {r!.first_tracked && (
                <p className="px-5 py-3 font-mono text-[11px] text-ink-mute">
                  Counting since {new Date(r!.first_tracked).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" })} · last 30 days: <b className="text-ink">{r!.last30.won}/{r!.last30.graded}</b> ({pct(r!.last30.won, r!.last30.graded)}%)
                </p>
              )}
            </section>

            {/* this week */}
            <h2 className="mt-10 font-disp text-xl font-bold text-chalk">This week</h2>
            <div className="mt-3 grid grid-cols-2 gap-3">
              <div className="rounded-2xl bg-chalk p-4 text-ink shadow-xl">
                <div className="font-mono text-[10px] uppercase tracking-wide text-ink-mute">Your slips</div>
                <div className="mt-1.5 font-disp text-xl font-extrabold text-ink">
                  <span className="text-grass-deep">{r!.week_slips.won}</span> of {r!.week_slips.graded}
                </div>
                <div className="mt-0.5 font-mono text-[11px] text-ink-mute">landed</div>
              </div>
              <div className="rounded-2xl bg-chalk p-4 text-ink shadow-xl">
                <div className="font-mono text-[10px] uppercase tracking-wide text-ink-mute">Your agents&apos; picks</div>
                <div className="mt-1.5 font-disp text-xl font-extrabold text-ink">
                  <span className="text-grass-deep">{r!.week_agents.won}</span> of {r!.week_agents.graded}
                </div>
                <div className="mt-0.5 font-mono text-[11px] text-ink-mute">landed</div>
              </div>
            </div>

            {/* where you win */}
            <h2 className="mt-10 font-disp text-xl font-bold text-chalk">Where you win</h2>
            <p className="mt-1 text-[13.5px] text-onpitch-mute">Your record by bet type — the numbers your bookie never shows you.</p>
            <div className="mt-4 rounded-2xl bg-chalk p-5 text-ink shadow-xl">
              <div className="flex flex-col gap-3">
                {r!.families.map((f) => {
                  const p = pct(f.won, f.graded);
                  const tone = f.graded < 5 ? "text-ink-mute" : p >= 60 ? "text-grass-deep" : p >= 45 ? "text-flood-deep" : "text-brick";
                  return (
                    <div key={f.family} className="flex items-center gap-3">
                      <span className="w-20 flex-none font-mono text-[12px] font-bold text-ink">{f.family}</span>
                      <div className="h-2.5 flex-1 overflow-hidden rounded-full bg-ink/[0.08]">
                        <div className="h-full rounded-full bg-grass-deep" style={{ width: `${p}%` }} />
                      </div>
                      <span className={`w-28 flex-none text-right font-mono text-[12px] font-bold ${tone}`}>
                        {f.won}/{f.graded} · {p}%
                      </span>
                    </div>
                  );
                })}
              </div>
              {best && worst && best.family !== worst.family && (
                <p className="mt-4 border-t border-dashed border-ink/15 pt-3.5 text-[13px] leading-relaxed text-ink-mute">
                  Your sharpest edge: <b className="text-grass-deep">{best.family}</b> at {pct(best.won, best.graded)}%.
                  Your leak: <b className="text-brick">{worst.family}</b> at {pct(worst.won, worst.graded)}% — worth
                  letting an agent screen those before you back them.
                </p>
              )}
            </div>

            <p className="mt-10 font-mono text-[10px] uppercase tracking-wide text-onpitch-mute">
              Graded exactly like the bookie grades · voids excluded · 18+ · Track responsibly
            </p>
          </>
        )}
      </div>
    </div>
  );
}
