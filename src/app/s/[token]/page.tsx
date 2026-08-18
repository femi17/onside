import type { Metadata } from "next";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";

// Public shared slip — the growth loop's landing. Anonymised (the RPC never returns who owns
// it), readable signed-out, and every visit ends at the same door: upload your own slip.

type Leg = { game: string; market: string; league: string | null; status: string };
type PublicAcca = {
  bookmaker: string | null; stake: number | null; potential: number | null; currency: string | null;
  leg_count: number | null; status: string; created_at: string; legs: Leg[];
};

const CUR: Record<string, string> = { NGN: "₦", USD: "$", EUR: "€", GBP: "£", GHS: "GH₵", KES: "KSh", ZAR: "R" };
const money = (cur: string | null, n: number | null) =>
  n == null ? null : `${CUR[cur ?? "NGN"] ?? "₦"}${Number(n).toLocaleString()}`;

async function loadAcca(token: string): Promise<PublicAcca | null> {
  try {
    const supabase = await createClient();
    const { data } = await supabase.rpc("public_acca", { p_token: token });
    return (data as PublicAcca | null) ?? null;
  } catch {
    return null;
  }
}

export async function generateMetadata({ params }: { params: Promise<{ token: string }> }): Promise<Metadata> {
  const { token } = await params;
  const a = await loadAcca(token);
  if (!a) return { title: "Slip not found — Onside" };
  const fold = a.leg_count ?? a.legs.length;
  const stake = money(a.currency, a.stake);
  const pot = money(a.currency, a.potential);
  const state = a.status === "won" ? "landed ✓" : a.status === "lost" ? "cut" : "tracking live";
  return {
    title: `${fold}-fold acca ${stake && pot ? `· ${stake} → ${pot} ` : ""}· ${state} — Onside`,
    description: "Tracked live and settled automatically on Onside. Upload your own slip — no manual entry, every leg follows the game.",
  };
}

const LEG_META: Record<string, { glyph: string; cls: string }> = {
  won: { glyph: "✓", cls: "bg-grass/15 text-grass-deep" },
  lost: { glyph: "✕", cls: "bg-brick/15 text-brick" },
  void: { glyph: "–", cls: "bg-ink/[0.07] text-ink-mute" },
  live: { glyph: "●", cls: "bg-flood/20 text-flood-deep" },
  pending: { glyph: "○", cls: "bg-ink/[0.06] text-ink-mute" },
};

export default async function SharedAccaPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const a = await loadAcca(token);

  if (!a) {
    return (
      <main className="flex min-h-screen flex-col items-center justify-center gap-4 bg-pitch px-6 text-center">
        <p className="font-disp text-2xl font-extrabold text-chalk">This slip isn&apos;t here anymore.</p>
        <Link href="/" className="rounded-xl bg-flood px-5 py-3 font-bold text-ink">See what Onside does →</Link>
      </main>
    );
  }

  const fold = a.leg_count ?? a.legs.length;
  const stake = money(a.currency, a.stake);
  const pot = money(a.currency, a.potential);
  const won = a.status === "won";
  const dead = a.status === "lost";
  const counts = a.legs.reduce<Record<string, number>>((m, l) => { m[l.status] = (m[l.status] ?? 0) + 1; return m; }, {});

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

        {/* the slip */}
        <section className="betslip betslip-chalk rounded-2xl bg-chalk text-ink shadow-xl">
          <div className="border-b border-dashed border-ink/15 p-5">
            <div className="flex items-start justify-between gap-4">
              <div>
                <div className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-wide text-ink-mute">
                  <span className="rounded bg-ink px-1.5 py-0.5 font-bold tracking-wider text-chalk-2">{a.bookmaker ?? "Onside"}</span>
                  {won ? "won" : dead ? "cut" : "live"}
                </div>
                <div className="mt-2 font-disp text-[15px] font-extrabold">{fold}-fold accumulator</div>
              </div>
              <div className="text-right font-mono">
                {stake && pot ? (
                  <>
                    <div className="whitespace-nowrap text-[13px] text-ink-mute">stake <b className="text-ink">{stake}</b> →</div>
                    <div className={`mt-0.5 whitespace-nowrap font-disp text-2xl font-extrabold tracking-tight ${dead ? "text-brick line-through decoration-2" : won ? "text-grass-deep" : "text-ink"}`}>{pot}</div>
                  </>
                ) : (
                  <div className={`font-disp text-lg font-extrabold ${dead ? "text-brick" : won ? "text-grass-deep" : "text-ink"}`}>
                    {dead ? "Cut" : won ? "Won" : "Live"}
                  </div>
                )}
              </div>
            </div>
            <div className="mt-3 flex flex-wrap gap-3 font-mono text-[11px] text-ink-mute">
              {counts.won ? <span className="text-grass-deep">✓ {counts.won} landed</span> : null}
              {(counts.live ?? 0) + (counts.pending ?? 0) ? <span className="text-flood-deep">● {(counts.live ?? 0) + (counts.pending ?? 0)} in play or upcoming</span> : null}
              {counts.lost ? <span className="text-brick">✕ {counts.lost} cut</span> : null}
              {counts.void ? <span>– {counts.void} void</span> : null}
            </div>
          </div>

          <div className="p-3">
            {a.legs.map((l, i) => {
              const m = LEG_META[l.status] ?? LEG_META.pending;
              return (
                <div key={i} className="flex items-center gap-3 rounded-[10px] px-2.5 py-2.5">
                  <span className={`grid h-[22px] w-[22px] flex-none place-items-center rounded-[7px] font-mono text-xs font-bold ${m.cls}`}>{m.glyph}</span>
                  <div className="min-w-0">
                    {l.league && <div className="truncate font-mono text-[10px] uppercase tracking-wide text-ink-mute">{l.league}</div>}
                    <div className="truncate text-sm font-bold leading-tight text-ink">{l.game}</div>
                    <div className="mt-0.5 truncate font-mono text-[11px] font-bold uppercase tracking-wide text-flood-deep">{l.market}</div>
                  </div>
                </div>
              );
            })}
          </div>
        </section>

        {/* the door */}
        <div className="mt-6 rounded-2xl border border-white/10 bg-pitch-2 p-5 text-center">
          <p className="font-disp text-lg font-extrabold text-chalk">Got a slip of your own?</p>
          <p className="mt-1 text-[13.5px] leading-relaxed text-onpitch-mute">
            Upload a screenshot — Onside reads every leg, tracks the games live and settles them like the bookie. No manual entry.
          </p>
          <Link href="/" className="mt-4 inline-block rounded-xl bg-flood px-6 py-3 font-bold text-ink transition-transform hover:-translate-y-0.5">
            Track my slip — free
          </Link>
          <p className="mt-3 font-mono text-[10px] uppercase tracking-wide text-onpitch-mute">onside.com.ng</p>
        </div>
      </div>
    </main>
  );
}
