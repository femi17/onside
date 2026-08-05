"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { type TrackedTicket, stateOf, liveTrack } from "@/lib/ticket";
import { useMinuteTick } from "@/lib/useMinuteTick";
import { usePulse } from "@/lib/usePulse";
import type { MatchState } from "@/lib/matchState";
import StickyHeader from "@/components/StickyHeader";
import MobileLogo from "@/components/MobileLogo";

export type Acca = {
  id: string;
  title: string | null;
  bookmaker: string | null;
  stake: number | null;
  potential_return: number | null;
  currency: string | null;
  leg_count: number | null;
  status: string;
  created_at: string;
  tickets: TrackedTicket[];
};

type Cat = "cut" | "live" | "safe" | "soon";

const GROUPS: { cat: Cat; label: string; dot: string }[] = [
  { cat: "cut", label: "Cut", dot: "bg-brick" },
  { cat: "live", label: "Live now", dot: "bg-flood" },
  { cat: "safe", label: "Safe", dot: "bg-grass" },
  { cat: "soon", label: "Upcoming", dot: "bg-ink/30" },
];

const MK: Record<Cat, { glyph: string; cls: string }> = {
  cut: { glyph: "✕", cls: "bg-brick/15 text-brick" },
  live: { glyph: "●", cls: "bg-flood/20 text-flood-deep" },
  safe: { glyph: "✓", cls: "bg-grass/15 text-grass-deep" },
  soon: { glyph: "◷", cls: "bg-ink/[0.07] text-ink-mute" },
};

// Only the leg that actually lost is "cut". A voided leg (the acca already died on
// another leg) is shown by its real game state, muted — never cut, never safe.
function legCat(leg: TrackedTicket, ms: MatchState | null): Cat {
  if (leg.status === "lost") return "cut";
  if (leg.status === "won") return "safe";
  if (leg.status === "void") return ms?.phase === "live" ? "live" : "soon";
  if (leg.status === "live" || ms?.phase === "live") return "live";
  if (ms?.phase === "done") return "safe";
  return "soon";
}

const money = (cur: string | null, n: number | null) => {
  const sym = cur === "NGN" || cur == null ? "₦" : `${cur} `;
  return `${sym}${Number(n ?? 0).toLocaleString()}`;
};

// country flag + league name for a leg (UEFA competitions show a cup instead of a flag)
function LeagueTag({ lg }: { lg: { name: string; flag_url: string | null; tier: string | null } }) {
  return (
    <div className="flex min-w-0 items-center gap-1.5 font-mono text-[10px] uppercase tracking-wide text-ink-mute">
      {lg.tier === "uefa" ? (
        <span className="text-[11px] leading-none">🏆</span>
      ) : lg.flag_url ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={lg.flag_url} alt="" className="h-2.5 w-3.5 flex-none rounded-[2px] object-cover" />
      ) : (
        <span className="text-[11px] leading-none">⚽</span>
      )}
      <span className="truncate">{lg.name}</span>
    </div>
  );
}

function LegRow({ leg, nowMs }: { leg: TrackedTicket; nowMs: number }) {
  const ms = stateOf(leg, nowMs);
  const cat = legCat(leg, ms);
  const voided = leg.status === "void";
  const track = liveTrack(leg);
  const f = leg.fixtures;
  const market = leg.market_label ?? leg.custom_market ?? "Tracked market";
  const pulse = usePulse(`${leg.current_value ?? ""}|${ms?.score ?? ""}`);

  let sc = "";
  let mn = "";
  if (voided) {
    sc = ms?.score ?? "—";
    mn = "not counted";
  } else if (cat === "soon") {
    sc = ms?.label ?? "—";
  } else if (cat === "live") {
    sc = track ? `${track.big}${track.of}` : ms?.score ?? "live";
    mn = ms?.label ?? "";
  } else if (cat === "safe") {
    sc = ms?.score ?? "✓";
    mn = leg.status === "won" ? "landed" : "FT";
  } else {
    sc = ms?.score ?? "✕";
    mn = "cut";
  }
  const scColor = cat === "cut" ? "text-brick" : cat === "safe" ? "text-grass-deep" : pulse ? "text-flood-deep" : "text-ink";

  return (
    <div className={`grid grid-cols-[26px_1fr_auto] items-center gap-3 rounded-[10px] px-2.5 py-2.5 transition-colors hover:bg-ink/[0.04] ${voided ? "opacity-60" : ""}`}>
      <span className={`grid h-[22px] w-[22px] place-items-center rounded-[7px] font-mono text-xs font-bold ${voided ? "bg-ink/[0.07] text-ink-mute" : MK[cat].cls}`}>
        {voided ? "–" : MK[cat].glyph}
      </span>
      <div className="min-w-0">
        {f?.leagues && <LeagueTag lg={f.leagues} />}
        <div className="mt-0.5 truncate text-sm font-bold leading-tight text-ink">
          {f ? (
            <>
              {f.home_team} <span className="font-semibold text-ink-mute">v</span> {f.away_team}
            </>
          ) : (
            "Match"
          )}
        </div>
        <div className="mt-0.5 truncate font-mono text-[11px] font-bold uppercase tracking-wide text-flood-deep">{market}</div>
      </div>
      <div className="text-right font-mono">
        <div className={`text-sm font-bold ${pulse && !voided ? "pop " : ""}${scColor}`}>{sc}</div>
        {mn && <div className="text-[11px] text-ink-mute">{mn}</div>}
      </div>
    </div>
  );
}

function AccaCard({ acca, nowMs }: { acca: Acca; nowMs: number }) {
  // order the legs by kickoff so the slip reads in start-time order (earliest game first)
  const legs = [...(acca.tickets ?? [])].sort(
    (a, b) => (a.fixtures?.kickoff_utc ?? "").localeCompare(b.fixtures?.kickoff_utc ?? "") || a.id.localeCompare(b.id)
  );
  const counts: Record<Cat, number> = { cut: 0, live: 0, safe: 0, soon: 0 };
  const grouped: Record<Cat, TrackedTicket[]> = { cut: [], live: [], safe: [], soon: [] };
  for (const leg of legs) {
    const c = legCat(leg, stateOf(leg, nowMs));
    counts[c]++;
    grouped[c].push(leg);
  }
  const dead = acca.status === "lost" || counts.cut > 0;
  const won = acca.status === "won" || (legs.length > 0 && legs.every((l) => l.status === "won"));
  const fold = acca.leg_count ?? legs.length;
  const hasStake = acca.potential_return != null;

  return (
    <section className="betslip betslip-chalk rounded-2xl bg-chalk text-ink shadow-xl">
      <div className="border-b border-dashed border-ink/15 p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-wide text-ink-mute">
              <span className="rounded bg-ink px-1.5 py-0.5 font-bold tracking-wider text-chalk-2">{acca.bookmaker ?? "Onside"}</span>
              {won ? "won" : dead ? "cut" : "live"}
            </div>
            <div className="mt-2 font-disp text-[15px] font-extrabold">{fold}-fold accumulator</div>
          </div>
          <div className="text-right font-mono">
            {hasStake ? (
              <>
                <div className="text-[13px] text-ink-mute">
                  stake <b className="font-bold text-ink">{money(acca.currency, acca.stake)}</b> → potential
                </div>
                <div className={`mt-0.5 font-disp text-2xl font-extrabold tracking-tight ${dead ? "text-brick line-through decoration-2" : won ? "text-grass-deep" : "text-ink"}`}>
                  {money(acca.currency, acca.potential_return)}
                </div>
              </>
            ) : (
              <div className={`font-disp text-lg font-extrabold ${dead ? "text-brick" : won ? "text-grass-deep" : "text-ink"}`}>
                {dead ? "Cut" : won ? "Won" : "Live"}
              </div>
            )}
          </div>
        </div>

        <div className="mt-4 flex h-2.5 gap-0.5 overflow-hidden rounded-md">
          {counts.safe > 0 && <span className="rounded-sm bg-grass" style={{ flex: counts.safe }} />}
          {counts.live > 0 && <span className="rounded-sm bg-flood" style={{ flex: counts.live }} />}
          {counts.cut > 0 && <span className="rounded-sm bg-brick" style={{ flex: counts.cut }} />}
          {counts.soon > 0 && <span className="rounded-sm bg-ink/20" style={{ flex: counts.soon }} />}
        </div>
        <div className="mt-2.5 flex flex-wrap gap-4 font-mono text-[11px] text-ink-mute">
          {counts.safe > 0 && <span className="flex items-center gap-1.5"><i className="h-2 w-2 rounded-sm bg-grass" /> {counts.safe} safe</span>}
          {counts.live > 0 && <span className="flex items-center gap-1.5"><i className="h-2 w-2 rounded-sm bg-flood" /> {counts.live} live</span>}
          {counts.cut > 0 && <span className="flex items-center gap-1.5"><i className="h-2 w-2 rounded-sm bg-brick" /> {counts.cut} cut</span>}
          {counts.soon > 0 && <span className="flex items-center gap-1.5"><i className="h-2 w-2 rounded-sm bg-ink/30" /> {counts.soon} upcoming</span>}
        </div>

        {dead && (
          <div className="mt-4 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-xl bg-brick/[0.08] px-3 py-2.5 text-[12.5px]">
            <span className="font-bold text-brick">This slip cut.</span>
            <span className="text-ink-mute">Start another with an upgrade, or</span>
            <Link href="/add" className="font-bold text-ink underline decoration-ink/30 underline-offset-2 hover:decoration-ink">
              pick a game to track by hand
            </Link>
          </div>
        )}
      </div>

      <div className="no-scrollbar max-h-[380px] overflow-y-auto p-3">
        {GROUPS.map((g) =>
          grouped[g.cat].length ? (
            <div key={g.cat}>
              <div className="sticky top-0 z-10 flex items-center gap-2 bg-chalk px-2.5 py-2 font-mono text-[10.5px] uppercase tracking-wide text-ink-mute">
                <span className={`h-2 w-2 rounded-full ${g.dot}`} /> {g.label} · {grouped[g.cat].length}
              </div>
              {grouped[g.cat].map((leg) => (
                <LegRow key={leg.id} leg={leg} nowMs={nowMs} />
              ))}
            </div>
          ) : null
        )}
      </div>
    </section>
  );
}

// --- previous-slip browser (fixed sidebar) ---

type AccaState = "won" | "cut" | "live" | "soon";

function accaState(acca: Acca, nowMs: number): AccaState {
  const legs = acca.tickets ?? [];
  if (acca.status === "lost" || legs.some((l) => l.status === "lost")) return "cut";
  if (acca.status === "won" || (legs.length > 0 && legs.every((l) => l.status === "won"))) return "won";
  const anyLive = legs.some((l) => l.status === "live" || stateOf(l, nowMs)?.phase === "live");
  return anyLive ? "live" : "soon";
}

const STATE_META: Record<AccaState, { dot: string; word: string; tone: string }> = {
  won: { dot: "bg-grass", word: "Won", tone: "text-grass" },
  cut: { dot: "bg-brick", word: "Cut", tone: "text-brick" },
  live: { dot: "bg-flood animate-pulse motion-reduce:animate-none", word: "Live", tone: "text-flood" },
  soon: { dot: "bg-ink/30", word: "Soon", tone: "text-onpitch-mute" },
};

function accaName(acca: Acca): string {
  const t = acca.title?.trim();
  if (t) return t;
  const fold = acca.leg_count ?? acca.tickets?.length ?? 0;
  return `${fold}-fold acca`;
}

function accaDate(iso: string): string {
  const d = new Date(iso);
  const day = d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  const time = d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  return `${day} · ${time}`;
}

function AccaRow({ acca, active, onClick, nowMs }: { acca: Acca; active: boolean; onClick: () => void; nowMs: number }) {
  const meta = STATE_META[accaState(acca, nowMs)];
  const fold = acca.leg_count ?? acca.tickets?.length ?? 0;
  return (
    <button
      onClick={onClick}
      className={`w-full rounded-xl border p-3 text-left transition-colors ${
        active ? "border-flood bg-flood/10" : "border-white/10 bg-pitch-2 hover:border-white/25"
      }`}
    >
      <div className="flex items-center gap-2.5">
        <span className={`h-2 w-2 flex-none rounded-full ${meta.dot}`} />
        <span className="min-w-0 flex-1 truncate text-sm font-bold text-chalk">{accaName(acca)}</span>
        <span className={`font-mono text-[10px] font-bold uppercase ${meta.tone}`}>{meta.word}</span>
      </div>
      <div className="mt-1.5 pl-[18px] font-mono text-[10.5px] text-onpitch-mute">
        {accaDate(acca.created_at)} · {fold} leg{fold === 1 ? "" : "s"}
      </div>
    </button>
  );
}

function AccaPill({ acca, active, onClick, nowMs }: { acca: Acca; active: boolean; onClick: () => void; nowMs: number }) {
  const meta = STATE_META[accaState(acca, nowMs)];
  return (
    <button
      onClick={onClick}
      className={`flex flex-none flex-col gap-1 rounded-xl border px-3.5 py-2.5 text-left transition-colors ${
        active ? "border-flood bg-flood/10" : "border-white/10 bg-pitch-2"
      }`}
    >
      <span className="flex items-center gap-2">
        <span className={`h-1.5 w-1.5 flex-none rounded-full ${meta.dot}`} />
        <span className="max-w-[160px] truncate text-[13px] font-bold text-chalk">{accaName(acca)}</span>
      </span>
      <span className="pl-3.5 font-mono text-[10px] text-onpitch-mute">{accaDate(acca.created_at)}</span>
    </button>
  );
}

export default function AccumulatorsBoard({ accas, plan = "free", cap = null }: { accas: Acca[]; plan?: string; cap?: number | null }) {
  const nowMs = useMinuteTick();
  const [selId, setSelId] = useState<string | null>(accas[0]?.id ?? null);
  const selected = useMemo(() => accas.find((a) => a.id === selId) ?? accas[0] ?? null, [accas, selId]);

  // the free/pro history cap is full — surface a nudge to keep more (pro_max = unlimited = no cap)
  const atCap = cap != null && accas.length >= cap;
  const nextPlan = plan === "free" ? "Pro" : "Pro Max";
  const keepMore = plan === "free" ? "10 slips" : "unlimited slips";

  const header = (
    <StickyHeader className="-mx-5 px-5 pb-4 pt-6 md:-mx-8 md:px-8">
      <MobileLogo />
      <div className="flex items-end justify-between gap-4">
      <div className="min-w-0">
        <p className="font-mono text-[11px] uppercase tracking-[0.25em] text-flood">
          {accas.length} slip{accas.length === 1 ? "" : "s"}
        </p>
        <h1 className="mt-2 font-disp text-3xl font-bold tracking-tight text-chalk sm:text-4xl">
          Your acca, <span className="text-onpitch-mute">leg by leg.</span>
        </h1>
      </div>
      {/* icon-only on mobile so it rides the heading line; full label from sm up */}
      <Link
        href="/add"
        aria-label="Add to tracker"
        className="grid h-11 w-11 flex-none place-items-center rounded-xl bg-flood font-bold text-ink transition-transform hover:-translate-y-0.5 sm:h-auto sm:w-auto sm:px-4 sm:py-3"
      >
        <span className="text-2xl leading-none sm:hidden">+</span>
        <span className="hidden sm:inline">+ Add to tracker</span>
      </Link>
      </div>
    </StickyHeader>
  );

  if (accas.length === 0) {
    return (
      <div className="mx-auto max-w-3xl px-5 pb-10 md:px-8">
        {header}
        <div className="mt-6 rounded-2xl border border-dashed border-ink/15 bg-chalk p-12 text-center shadow-xl">
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-flood/15 font-mono text-xl text-flood-deep">+</div>
          <h2 className="font-disp text-xl font-bold text-ink">No accumulators yet.</h2>
          <p className="mx-auto mt-2 max-w-sm text-sm text-ink-mute">
            Add two or more games at once and they&apos;ll track here as one slip — safe, live and cut legs at a glance.
          </p>
          <Link href="/add" className="mt-5 inline-block rounded-xl bg-flood px-5 py-3 font-bold text-ink">
            Build your first slip
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto flex max-w-6xl flex-col px-5 pb-10 md:px-8 lg:h-full lg:pb-0">
      <div className="shrink-0">{header}</div>

      {/* mobile: horizontal switcher between slips */}
      <div className="no-scrollbar -mx-5 mb-4 flex shrink-0 gap-2 overflow-x-auto px-5 lg:hidden">
        {accas.map((a) => (
          <AccaPill key={a.id} acca={a} active={a.id === selected?.id} onClick={() => setSelId(a.id)} nowMs={nowMs} />
        ))}
      </div>

      <div className="flex min-h-0 flex-1 gap-6">
        {/* detail — the selected slip, leg by leg */}
        <main className="no-scrollbar min-w-0 flex-1 lg:overflow-y-auto lg:pb-10">
          {selected && <AccaCard acca={selected} nowMs={nowMs} />}
        </main>

        {/* fixed sidebar (right) — pick a previous slip to open on the left */}
        <aside className="hidden w-[272px] shrink-0 flex-col lg:flex">
          <div className="no-scrollbar flex flex-1 flex-col gap-2 overflow-y-auto pl-1">
            <div className="px-1 pb-1 font-mono text-[10.5px] uppercase tracking-[0.2em] text-onpitch-mute">Previous slips</div>
            {accas.map((a) => (
              <AccaRow key={a.id} acca={a} active={a.id === selected?.id} onClick={() => setSelId(a.id)} nowMs={nowMs} />
            ))}
          </div>
          {atCap && (
            <div className="ml-1 mt-4 pb-6">
              <div className="font-mono text-[10px] uppercase tracking-wide text-flood">History full</div>
              <p className="mt-1.5 text-[12.5px] font-semibold leading-snug text-chalk">
                Your oldest slip drops off as new ones come in.
              </p>
              <p className="mt-1 text-[11.5px] leading-snug text-onpitch-mute">
                Go {nextPlan} to keep {keepMore} in your history.
              </p>
              <Link
                href="/profile"
                className="mt-2 inline-block font-mono text-[11px] font-bold uppercase tracking-wide text-flood transition-opacity hover:opacity-70"
              >
                Upgrade to {nextPlan} →
              </Link>
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}
