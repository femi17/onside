import type { Metadata } from "next";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import Footer from "@/components/Footer";
import BackButton from "@/components/BackButton";

// The public transparency page — the "honest record" the ads point at. Everything here
// comes from public_record(), an aggregates-only RPC (no user, agent, or pick identities),
// read straight from the same deliveries table the settlement engine grades. The page's
// whole pitch is that the numbers can't be curated: misses included, history immutable.

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

export default async function RecordPage() {
  const r = await loadRecord();

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
            {/* all-time tiles */}
            <div className="mt-8 grid grid-cols-3 gap-3">
              <div className="rounded-2xl border border-white/10 bg-pitch-2 p-4">
                <div className="font-disp text-2xl font-extrabold text-chalk sm:text-3xl">{r.all_time.graded.toLocaleString()}</div>
                <div className="mt-1 font-mono text-[10px] uppercase tracking-wide text-onpitch-mute">picks graded</div>
              </div>
              <div className="rounded-2xl border border-white/10 bg-pitch-2 p-4">
                <div className="font-disp text-2xl font-extrabold text-grass sm:text-3xl">{r.all_time.won.toLocaleString()}</div>
                <div className="mt-1 font-mono text-[10px] uppercase tracking-wide text-onpitch-mute">landed</div>
              </div>
              <div className="rounded-2xl border border-white/10 bg-pitch-2 p-4">
                <div className="font-disp text-2xl font-extrabold text-chalk sm:text-3xl">{pct(r.all_time.won, r.all_time.graded)}%</div>
                <div className="mt-1 font-mono text-[10px] uppercase tracking-wide text-onpitch-mute">hit rate</div>
              </div>
            </div>
            <p className="mt-2 font-mono text-[11px] text-onpitch-mute">
              {r.all_time.since && (
                <>Counting since {new Date(r.all_time.since).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" })} · </>
              )}
              {r.today_delivered > 0 && <>{r.today_delivered} picks delivered today · </>}
              voids excluded
            </p>

            {/* day by day */}
            <h2 className="mt-12 font-disp text-xl font-bold text-chalk">Day by day — the last 30 days</h2>
            <p className="mt-1 text-[13.5px] text-onpitch-mute">Landed out of graded, newest first. Bad days stay on the board.</p>
            <div className="mt-4 flex flex-col gap-1.5">
              {r.days.map((d) => {
                const p = pct(d.won, d.graded);
                return (
                  <div key={d.day} className="flex items-center gap-3">
                    <span className="w-16 flex-none font-mono text-[11px] text-onpitch-mute">
                      {new Date(d.day + "T12:00:00").toLocaleDateString("en-GB", { day: "2-digit", month: "short" })}
                    </span>
                    <div className="h-4 flex-1 overflow-hidden rounded bg-white/5">
                      <div className="h-full rounded bg-grass/60" style={{ width: `${p}%` }} />
                    </div>
                    <span className="w-24 flex-none text-right font-mono text-[11px] text-chalk">
                      <span className="text-grass">{d.won}</span>
                      <span className="text-onpitch-mute"> / {d.graded} · {p}%</span>
                    </span>
                  </div>
                );
              })}
            </div>

            {/* claimed vs landed */}
            {r.bands.length > 0 && (
              <>
                <h2 className="mt-12 font-disp text-xl font-bold text-chalk">Claimed confidence vs what landed</h2>
                <p className="mt-1 max-w-[52ch] text-[13.5px] leading-relaxed text-onpitch-mute">
                  Each pick is delivered with the model&apos;s own probability. Here is what every
                  confidence band claimed on average — and what it actually delivered. When a band
                  runs under its claim, it says so, and the engine stops delivering the bet types
                  responsible.
                </p>
                <div className="mt-4 overflow-hidden rounded-2xl border border-white/10">
                  <table className="w-full text-left">
                    <thead>
                      <tr className="bg-pitch-2 font-mono text-[10px] uppercase tracking-wide text-onpitch-mute">
                        <th className="px-4 py-2.5 font-medium">Band</th>
                        <th className="px-2 py-2.5 text-right font-medium">Claimed</th>
                        <th className="px-2 py-2.5 text-right font-medium">Landed</th>
                        <th className="px-4 py-2.5 text-right font-medium">Picks</th>
                      </tr>
                    </thead>
                    <tbody>
                      {r.bands.map((b) => {
                        const actual = pct(b.won, b.n);
                        const delta = actual - b.claimed;
                        return (
                          <tr key={b.band} className="border-t border-white/5 font-mono text-[12.5px] text-chalk">
                            <td className="px-4 py-2.5">{b.band}–{b.band + 9}%</td>
                            <td className="px-2 py-2.5 text-right text-onpitch-mute">{b.claimed}%</td>
                            <td className={`px-2 py-2.5 text-right font-bold ${delta >= 0 ? "text-grass" : "text-flood"}`}>
                              {actual}%
                            </td>
                            <td className="px-4 py-2.5 text-right text-onpitch-mute">{b.n}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </>
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
