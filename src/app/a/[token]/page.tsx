import type { Metadata } from "next";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";

// Public shared agent feed — the agents' growth loop, sibling of /s/[token] (shared slips).
// Anonymised (the RPC never returns who owns the agent), readable signed-out, live scores
// on in-play picks, and every visit ends at the same door: get an agent of your own.

type Pick = {
  game: string; league: string | null; market: string; prob: number | null;
  result: string; value: string | number | null; kickoff: string | null;
  fx_status: string | null; elapsed: number | null; hg: number | null; ag: number | null;
};
type PublicAgent = {
  name: string; market: string | null; created_at: string;
  record: { won: number; lost: number }; picks: Pick[];
};

const LIVE = new Set(["1H", "HT", "2H", "ET", "BT", "P", "LIVE", "SUSP", "INT"]);

async function loadAgent(token: string): Promise<PublicAgent | null> {
  try {
    const supabase = await createClient();
    const { data } = await supabase.rpc("public_agent", { p_token: token });
    return (data as PublicAgent | null) ?? null;
  } catch {
    return null;
  }
}

export async function generateMetadata({ params }: { params: Promise<{ token: string }> }): Promise<Metadata> {
  const { token } = await params;
  const a = await loadAgent(token);
  if (!a) return { title: "Agent not found — Onside" };
  const settled = a.record.won + a.record.lost;
  const rec = settled ? ` · ${a.record.won}/${settled} landed` : "";
  return {
    title: `${a.name} — AI betting agent${rec} — Onside`,
    description: "An Onside agent hunts fixtures by its owner's rules and delivers picks daily — tracked live, settled automatically. Build your own for free.",
  };
}

const PICK_META: Record<string, { glyph: string; cls: string }> = {
  won: { glyph: "✓", cls: "bg-grass/15 text-grass-deep" },
  lost: { glyph: "✕", cls: "bg-brick/15 text-brick" },
  void: { glyph: "–", cls: "bg-ink/[0.07] text-ink-mute" },
  live: { glyph: "●", cls: "bg-flood/20 text-flood-deep" },
  pending: { glyph: "○", cls: "bg-ink/[0.06] text-ink-mute" },
};

export default async function SharedAgentPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const a = await loadAgent(token);

  if (!a) {
    return (
      <main className="flex min-h-screen flex-col items-center justify-center gap-4 bg-pitch px-6 text-center">
        <p className="font-disp text-2xl font-extrabold text-chalk">This agent isn&apos;t here anymore.</p>
        <Link href="/" className="rounded-xl bg-flood px-5 py-3 font-bold text-ink">See what Onside does →</Link>
      </main>
    );
  }

  const settled = a.record.won + a.record.lost;
  const winPct = settled ? Math.round((a.record.won / settled) * 100) : null;
  const liveNow = a.picks.filter((p) => p.result === "pending" && LIVE.has(p.fx_status ?? "")).length;

  return (
    <main className="min-h-screen bg-pitch px-4 py-10">
      <div className="mx-auto max-w-md">
        {/* brand */}
        <Link href="/" className="mb-5 flex items-center justify-center gap-2">
          <span className="glyph" />
          <span className="font-disp text-xl font-extrabold tracking-tight text-chalk">
            ON<span className="text-flood">SIDE</span>
          </span>
        </Link>

        {/* the agent */}
        <section className="betslip betslip-chalk rounded-2xl bg-chalk text-ink shadow-xl">
          <div className="border-b border-dashed border-ink/15 p-5">
            <div className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-wide text-ink-mute">
              <span className="rounded bg-ink px-1.5 py-0.5 font-bold tracking-wider text-chalk-2">AI agent</span>
              {liveNow ? <span className="text-flood-deep">● {liveNow} in play now</span> : "recent picks"}
            </div>
            <div className="mt-2 font-disp text-xl font-extrabold">{a.name}</div>
            {a.market && <div className="mt-0.5 font-mono text-[11px] font-bold uppercase tracking-wide text-flood-deep">{a.market}</div>}
            {settled > 0 && (
              <div className="mt-3 flex flex-wrap gap-3 font-mono text-[11px] text-ink-mute">
                <span className="text-grass-deep">✓ {a.record.won} landed</span>
                <span className="text-brick">✕ {a.record.lost} cut</span>
                {winPct != null && <span>{winPct}% of settled picks landed</span>}
              </div>
            )}
          </div>

          <div className="p-3">
            {a.picks.length === 0 && (
              <p className="px-2.5 py-4 text-center text-[13px] text-ink-mute">No picks delivered yet — this agent is warming up.</p>
            )}
            {a.picks.map((p, i) => {
              const isLive = p.result === "pending" && LIVE.has(p.fx_status ?? "");
              const state = p.result !== "pending" ? p.result : isLive ? "live" : "pending";
              const m = PICK_META[state] ?? PICK_META.pending;
              const score = p.hg != null && p.ag != null ? `${p.hg}–${p.ag}` : null;
              const when = p.kickoff
                ? new Date(p.kickoff).toLocaleString("en-GB", { weekday: "short", hour: "2-digit", minute: "2-digit" })
                : null;
              return (
                <div key={i} className="flex items-center gap-3 rounded-[10px] px-2.5 py-2.5">
                  <span className={`grid h-[22px] w-[22px] flex-none place-items-center rounded-[7px] font-mono text-xs font-bold ${m.cls}`}>{m.glyph}</span>
                  <div className="min-w-0 flex-1">
                    {p.league && <div className="truncate font-mono text-[10px] uppercase tracking-wide text-ink-mute">{p.league}</div>}
                    <div className="truncate text-sm font-bold leading-tight text-ink">{p.game}</div>
                    <div className="mt-0.5 truncate font-mono text-[11px] font-bold uppercase tracking-wide text-flood-deep">
                      {p.market}{p.prob != null ? ` · ${Math.round(p.prob * 100)}%` : ""}
                    </div>
                  </div>
                  <div className="flex-none text-right font-mono text-[11px] text-ink-mute">
                    {isLive ? (
                      <>
                        {score && <div className="font-bold text-ink">{score}</div>}
                        <div className="text-flood-deep">{p.elapsed != null ? `${p.elapsed}'` : "live"}</div>
                      </>
                    ) : p.result !== "pending" && score ? (
                      <div className="font-bold text-ink">{score}</div>
                    ) : (
                      when && <div>{when}</div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </section>

        {/* the door */}
        <div className="mt-6 rounded-2xl border border-white/10 bg-pitch-2 p-5 text-center">
          <p className="font-disp text-lg font-extrabold text-chalk">Want an agent hunting for you?</p>
          <p className="mt-1 text-[13.5px] leading-relaxed text-onpitch-mute">
            Onside agents scan the day&apos;s fixtures by YOUR rules and deliver picks like these daily — tracked live, settled like the bookie.
          </p>
          <Link href="/" className="mt-4 inline-block rounded-xl bg-flood px-6 py-3 font-bold text-ink transition-transform hover:-translate-y-0.5">
            Build my agent — free
          </Link>
          <p className="mt-3 font-mono text-[10px] uppercase tracking-wide text-onpitch-mute">onside.com.ng</p>
        </div>
      </div>
    </main>
  );
}
