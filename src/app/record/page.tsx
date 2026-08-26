import type { Metadata } from "next";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import Footer from "@/components/Footer";
import BackButton from "@/components/BackButton";

// The public transparency page — the "honest record" the ads point at. Everything here
// comes from public_record(), an aggregates-only RPC (no user, agent, or pick identities),
// read straight from the same deliveries table the settlement engine grades. The page's
// whole pitch is that the numbers can't be curated: misses included, history immutable.
// Layout: small chalk cards — three all-time tiles, a perfect-day spotlight, then every
// day as its own tiny card so single-day feats (an agent's 4/4) don't drown in totals.

export const metadata: Metadata = {
  title: "The Onside record — every pick graded in public",
  description:
    "Every AI agent pick on Onside is graded in the open — landed or missed, the record stays up. See the live platform-wide results and what claimed confidence actually delivers.",
};

type PerfectLeg = { home: string; away: string; market: string; score: string | null };
type RecordData = {
  all_time: { graded: number; won: number; since: string | null };
  today_delivered: number;
  days: { day: string; graded: number; won: number; perfect?: number; perfect_n?: number | null }[];
  perfect_details?: { day: string; sweeps: { n: number; legs: PerfectLeg[] }[] }[];
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
const dayLabel = (iso: string, opts: Intl.DateTimeFormatOptions) =>
  new Date(iso + "T12:00:00").toLocaleDateString("en-GB", opts);

export default async function RecordPage() {
  const r = await loadRecord();
  // the perfect-day spotlight: most recent days where an individual agent swept its card,
  // with the actual winning legs to expand into
  const perfectDays = r?.perfect_details ?? [];

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
              <div className="rounded-2xl bg-chalk-2 p-4 shadow-xl">
                <div className="font-disp text-2xl font-extrabold text-ink sm:text-3xl">{r.all_time.graded.toLocaleString()}</div>
                <div className="mt-1 font-mono text-[10px] uppercase tracking-wide text-ink-mute">picks graded</div>
              </div>
              <div className="rounded-2xl bg-chalk-2 p-4 shadow-xl">
                <div className="font-disp text-2xl font-extrabold text-grass-deep sm:text-3xl">{r.all_time.won.toLocaleString()}</div>
                <div className="mt-1 font-mono text-[10px] uppercase tracking-wide text-ink-mute">landed</div>
              </div>
              <div className="rounded-2xl bg-chalk-2 p-4 shadow-xl">
                <div className="font-disp text-2xl font-extrabold text-ink sm:text-3xl">{pct(r.all_time.won, r.all_time.graded)}%</div>
                <div className="mt-1 font-mono text-[10px] uppercase tracking-wide text-ink-mute">hit rate</div>
              </div>
            </div>
            <p className="mt-2 font-mono text-[11px] text-onpitch-mute">
              {r.all_time.since && (
                <>Counting since {new Date(r.all_time.since).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" })} · </>
              )}
              {r.today_delivered > 0 && <>{r.today_delivered} picks delivered today · </>}
              voids excluded
            </p>

            {/* perfect-day spotlight — an individual agent swept its whole card; each card
                is an accordion that opens into the actual winning games */}
            {perfectDays.length > 0 && (
              <div className="mt-8 flex flex-col gap-2">
                {perfectDays.map((d, di) => {
                  const total = d.sweeps.length;
                  const biggest = d.sweeps[0]?.n ?? 0;
                  return (
                    <details key={d.day} open={di === 0} className="group rounded-2xl bg-chalk-2 shadow-xl ring-2 ring-inset ring-flood/60">
                      <summary className="flex cursor-pointer list-none items-center gap-3 p-4 [&::-webkit-details-marker]:hidden">
                        <span className="text-2xl">🎯</span>
                        <div className="min-w-0 flex-1">
                          <p className="font-disp text-[15px] font-extrabold text-ink">
                            {total > 1 ? `${total} agents went perfect` : `An agent went ${biggest}/${biggest}`}
                            {" — "}{dayLabel(d.day, { weekday: "long", day: "numeric", month: "short" })}
                          </p>
                          <p className="mt-0.5 font-mono text-[11px] text-ink-mute">
                            {total > 1
                              ? `biggest sweep ${biggest}/${biggest} · tap to see every game`
                              : "every pick landed · tap to see the games"}
                          </p>
                        </div>
                        <span className="flex-none font-mono text-[12px] text-ink-mute transition-transform group-open:rotate-90">▶</span>
                      </summary>
                      <div className="flex flex-col gap-4 border-t border-dashed border-ink/15 px-4 pb-4 pt-3">
                        {d.sweeps.map((s, si) => (
                          <div key={si}>
                            {total > 1 && (
                              <p className="mb-1 font-mono text-[10.5px] font-bold uppercase tracking-wide text-ink-mute">
                                Agent {si + 1} · {s.n}/{s.n}
                              </p>
                            )}
                            <div className="flex flex-col divide-y divide-ink/[0.06]">
                              {s.legs.map((l, li) => (
                                <div key={li} className="flex items-center gap-3 py-2">
                                  <div className="min-w-0 flex-1">
                                    <p className="truncate text-[13.5px] font-bold text-ink">
                                      {l.home} <span className="font-normal text-ink-mute">v</span> {l.away}
                                    </p>
                                    <p className="mt-0.5 truncate font-mono text-[11px] text-ink-mute">{l.market}</p>
                                  </div>
                                  {l.score && <span className="flex-none font-mono text-[13px] font-bold text-ink">{l.score}</span>}
                                  <span className="flex-none rounded-full bg-grass/15 px-2.5 py-1 font-mono text-[10px] font-bold uppercase tracking-wide text-grass-deep">won</span>
                                </div>
                              ))}
                            </div>
                          </div>
                        ))}
                      </div>
                    </details>
                  );
                })}
              </div>
            )}

            {/* day by day — each day its own tiny card */}
            <h2 className="mt-12 font-disp text-xl font-bold text-chalk">Day by day — the last 30 days</h2>
            <p className="mt-1 text-[13.5px] text-onpitch-mute">
              Wins and misses for every day, newest first. Bad days stay on the board. 🎯 = an agent swept its card.
            </p>
            <div className="mt-4 grid grid-cols-3 gap-2.5 sm:grid-cols-5">
              {r.days.map((d) => {
                const lost = d.graded - d.won;
                const hasPerfect = (d.perfect ?? 0) > 0;
                return (
                  <div key={d.day} className={`relative rounded-xl bg-chalk-2 p-3 shadow-xl ${hasPerfect ? "ring-2 ring-inset ring-flood/60" : ""}`}>
                    {hasPerfect && <span className="absolute right-2 top-2 text-[13px]" title="An agent swept its card">🎯</span>}
                    <div className="font-mono text-[9.5px] font-bold uppercase tracking-wide text-ink-mute">
                      {dayLabel(d.day, { weekday: "short", day: "2-digit", month: "short" })}
                    </div>
                    <div className="mt-1.5 font-disp text-lg font-extrabold leading-none text-ink">
                      <span className="text-grass-deep">{d.won}</span>
                      <span className="text-ink-mute">–</span>
                      <span className={lost > 0 ? "text-brick" : "text-ink-mute"}>{lost}</span>
                    </div>
                    <div className="mt-1 font-mono text-[10px] text-ink-mute">{pct(d.won, d.graded)}% of {d.graded}</div>
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
                <div className="mt-4 overflow-hidden rounded-2xl bg-chalk-2 shadow-xl">
                  <table className="w-full text-left">
                    <thead>
                      <tr className="border-b border-ink/10 font-mono text-[10px] uppercase tracking-wide text-ink-mute">
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
                          <tr key={b.band} className="border-t border-ink/[0.06] font-mono text-[12.5px] text-ink">
                            <td className="px-4 py-2.5">{b.band}–{b.band + 9}%</td>
                            <td className="px-2 py-2.5 text-right text-ink-mute">{b.claimed}%</td>
                            <td className={`px-2 py-2.5 text-right font-bold ${delta >= 0 ? "text-grass-deep" : "text-flood-deep"}`}>
                              {actual}%
                            </td>
                            <td className="px-4 py-2.5 text-right text-ink-mute">{b.n}</td>
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
