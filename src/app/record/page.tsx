import type { Metadata } from "next";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import Footer from "@/components/Footer";
import BackButton from "@/components/BackButton";

// The public transparency page — the "honest record" the ads point at. Everything here
// comes from public_record(), an aggregates-only RPC (no user, agent, or pick identities),
// read straight from the same deliveries table the settlement engine grades. The page's
// whole pitch is that the numbers can't be curated: misses included, history immutable.
// Visually the record IS a betslip: the brand's chalk card with a perforated stub — the
// all-time totals ride the stub, each day sits below as a graded leg, losses in brick.

export const metadata: Metadata = {
  title: "The Onside record — every pick graded in public",
  description:
    "Every AI agent pick on Onside is graded in the open — landed or missed, the record stays up. See the live platform-wide results and what claimed confidence actually delivers.",
};

type RecordData = {
  all_time: { graded: number; won: number; since: string | null };
  today_delivered: number;
  days: { day: string; graded: number; won: number }[];
  bands: { band: number; n: number; won: number; claimed: number }[];
};

async function loadRecord(): Promise<RecordData | null> {
  try {
    const supabase = await createClient();
    const { data } = await supabase.rpc("public_record");
    return (data as RecordData | null) ?? null;
  } catch {
    return null;
  }
}

const pct = (won: number, graded: number) => (graded > 0 ? Math.round((won / graded) * 100) : 0);

// the perforated tear line between a slip's stub and its legs (matches the app betslip)
function Perforation() {
  return (
    <div
      aria-hidden
      className="h-6"
      style={{
        backgroundImage: "radial-gradient(circle at 12px 12px, #0E1A1B 8px, #F6F2E9 9px)",
        backgroundSize: "40px 24px",
        backgroundPosition: "8px 0",
      }}
    />
  );
}

export default async function RecordPage() {
  const r = await loadRecord();
  const maxGraded = Math.max(1, ...(r?.days ?? []).map((d) => d.graded));

  return (
    <>
      <div className="mx-auto w-full max-w-2xl flex-1 px-5 pb-20 pt-10">
        <div className="mb-8 flex items-center justify-between gap-3">
          <Link href="/" className="flex items-center gap-2">
            <span className="glyph" />
            <span className="font-disp text-xl font-extrabold tracking-tight text-chalk">
              ON<span className="text-flood">SIDE</span>
            </span>
          </Link>
          <BackButton />
        </div>

        <p className="font-mono text-[11px] uppercase tracking-[0.25em] text-flood">The record</p>
        <h1 className="mt-2 font-disp text-3xl font-bold tracking-tight text-chalk sm:text-4xl">
          Every pick graded. Even the misses.
        </h1>
        <p className="mt-3 max-w-[52ch] text-[15px] leading-relaxed text-onpitch-mute">
          Every AI agent pick on Onside is timestamped before kickoff and settled by the same
          engine that grades tracked bets. Nothing on this page is typed in by a person — it
          reads live from the settlement database, misses included, and history can&apos;t be edited.
        </p>

        {!r ? (
          <p className="mt-10 text-[14px] text-onpitch-mute">The record is loading slowly — refresh in a moment.</p>
        ) : (
          <>
            {/* the record slip: all-time on the stub, each day a graded leg below */}
            <div className="mt-10" style={{ filter: "drop-shadow(0 18px 36px rgba(0,0,0,0.4))" }}>
              {/* stub */}
              <div className="rounded-t-3xl bg-chalk-2 px-6 pb-5 pt-6 sm:px-8">
                <div className="grid grid-cols-3 gap-4">
                  <div>
                    <div className="font-disp text-3xl font-extrabold tracking-tight text-ink sm:text-4xl">
                      {r.all_time.graded.toLocaleString()}
                    </div>
                    <div className="mt-1 font-mono text-[10px] uppercase tracking-wide text-ink-mute">picks graded</div>
                  </div>
                  <div>
                    <div className="font-disp text-3xl font-extrabold tracking-tight text-grass-deep sm:text-4xl">
                      {r.all_time.won.toLocaleString()}
                    </div>
                    <div className="mt-1 font-mono text-[10px] uppercase tracking-wide text-ink-mute">landed</div>
                  </div>
                  <div>
                    <div className="font-disp text-3xl font-extrabold tracking-tight text-ink sm:text-4xl">
                      {pct(r.all_time.won, r.all_time.graded)}%
                    </div>
                    <div className="mt-1 font-mono text-[10px] uppercase tracking-wide text-ink-mute">hit rate</div>
                  </div>
                </div>
                <p className="mt-4 font-mono text-[10.5px] uppercase tracking-wide text-ink-mute">
                  {r.all_time.since && (
                    <>Since {new Date(r.all_time.since).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })} · </>
                  )}
                  {r.today_delivered > 0 && <>{r.today_delivered} delivered today · </>}
                  voids excluded
                </p>
              </div>

              <Perforation />

              {/* day-by-day legs */}
              <div className="rounded-b-3xl bg-chalk-2 px-6 pb-6 pt-1 sm:px-8">
                <div className="flex items-baseline justify-between pb-1 pt-3">
                  <h2 className="font-disp text-lg font-bold text-ink">Day by day</h2>
                  <span className="font-mono text-[10.5px] uppercase tracking-wide text-ink-mute">last 30 · newest first</span>
                </div>
                <p className="pb-2 text-[13px] leading-relaxed text-ink-mute">
                  Wins in green, misses in brick — bad days stay on the board. 🎯 marks a perfect day.
                </p>
                <div className="flex flex-col divide-y divide-ink/[0.07]">
                  {r.days.map((d) => {
                    const lost = d.graded - d.won;
                    const p = pct(d.won, d.graded);
                    const perfect = d.graded >= 3 && lost === 0;
                    return (
                      <div key={d.day} className="flex items-center gap-3 py-2.5 sm:gap-4">
                        <span className="w-16 flex-none font-mono text-[11px] font-bold uppercase text-ink sm:w-20">
                          {new Date(d.day + "T12:00:00").toLocaleDateString("en-GB", { weekday: "short", day: "2-digit", month: "short" }).replace(",", "")}
                        </span>
                        {/* bar width tracks the day's volume; the split tracks its outcome */}
                        <div className="h-3.5 flex-1">
                          <div
                            className="flex h-full min-w-[6px] overflow-hidden rounded-full"
                            style={{ width: `${Math.max(6, (d.graded / maxGraded) * 100)}%` }}
                          >
                            <div className="h-full bg-grass-deep" style={{ width: `${p}%` }} />
                            <div className="h-full bg-brick/80" style={{ width: `${100 - p}%` }} />
                          </div>
                        </div>
                        <span className="flex-none text-right font-mono text-[12px] font-bold text-ink">
                          <span className="text-grass-deep">{d.won}W</span>
                          {lost > 0 && <span className="text-brick"> {lost}L</span>}
                        </span>
                        <span className="w-12 flex-none text-right font-mono text-[11.5px] text-ink-mute">
                          {perfect ? "🎯" : `${p}%`}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>

            {/* claimed vs landed */}
            {r.bands.length > 0 && (
              <div className="mt-10 rounded-3xl bg-chalk-2 p-6 shadow-xl sm:p-8">
                <h2 className="font-disp text-lg font-bold text-ink">Claimed confidence vs what landed</h2>
                <p className="mt-1 max-w-[52ch] text-[13px] leading-relaxed text-ink-mute">
                  Each pick is delivered with the model&apos;s own probability. Here is what every
                  confidence band claimed on average — and what it actually delivered. When a band
                  runs under its claim, it says so, and the engine stops delivering the bet types
                  responsible.
                </p>
                <table className="mt-4 w-full text-left">
                  <thead>
                    <tr className="border-b border-ink/10 font-mono text-[10px] uppercase tracking-wide text-ink-mute">
                      <th className="py-2.5 font-medium">Band</th>
                      <th className="py-2.5 text-right font-medium">Claimed</th>
                      <th className="py-2.5 text-right font-medium">Landed</th>
                      <th className="py-2.5 text-right font-medium">Picks</th>
                    </tr>
                  </thead>
                  <tbody>
                    {r.bands.map((b) => {
                      const actual = pct(b.won, b.n);
                      const delta = actual - b.claimed;
                      return (
                        <tr key={b.band} className="border-t border-ink/[0.06] font-mono text-[12.5px] text-ink">
                          <td className="py-2.5">{b.band}–{b.band + 9}%</td>
                          <td className="py-2.5 text-right text-ink-mute">{b.claimed}%</td>
                          <td className={`py-2.5 text-right font-bold ${delta >= 0 ? "text-grass-deep" : "text-flood-deep"}`}>
                            {actual}%
                          </td>
                          <td className="py-2.5 text-right text-ink-mute">{b.n}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}

        {/* the door */}
        <div className="mt-14 rounded-2xl border border-white/10 bg-pitch-2 p-6 text-center">
          <p className="font-disp text-lg font-extrabold text-chalk">This record is built by agents like yours.</p>
          <p className="mx-auto mt-1 max-w-[46ch] text-[13.5px] leading-relaxed text-onpitch-mute">
            Onside agents scan the day&apos;s fixtures by YOUR rules, deliver picks daily, and get
            graded in the open — every one of them lands on this page, win or lose.
          </p>
          <Link href="/login" className="mt-4 inline-block rounded-xl bg-flood px-6 py-3 font-bold text-ink transition-transform hover:-translate-y-0.5">
            Build my agent — free
          </Link>
          <p className="mt-3 font-mono text-[10px] uppercase tracking-wide text-onpitch-mute">18+ · Track responsibly</p>
        </div>
      </div>
      <Footer />
    </>
  );
}
