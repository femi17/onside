"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

export type SchoolLeg = {
  game: string;
  fixtureId: number;
  odds: number | null;
  oddsReal: boolean; // true = real bookie odds an admin typed; false = model estimate (shown "~")
  score: string | null; // current score (live or final), e.g. "2-1"
  hit: boolean | null; // Over 2.5: true once 3 goals land, false only at FT under 3, null pending
  elapsed: number | null; // live minute
  finished: boolean;
  kickoff: string | null;
  league: string | null;
  flag: string | null;
  tier: string | null;
};
export type SchoolRecord = {
  date: string;
  legs: SchoolLeg[];
  combined: number;
  result: "won" | "lost" | "pending";
  code?: string | null; // SportyBet booking/verify code for this day's slip (members/admin only)
};

const CHIPS = [5000, 10000, 50000, 100000];
const naira = (n: number) => (n < 0 ? "−₦" : "₦") + Math.round(Math.abs(n)).toLocaleString("en-US");
const short = (n: number) => (n >= 1000 ? "₦" + Math.round(n / 1000) + "k" : "₦" + n);
const day = (iso: string) =>
  new Date(iso + "T00:00:00Z").toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
// kickoff clock in the users' timezone (Africa/Lagos), e.g. "18:30"
const clock = (iso: string) =>
  new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Africa/Lagos" });

function Flag({ url, tier }: { url: string | null; tier: string | null }) {
  if (tier === "uefa") return <span className="text-[13px] leading-none">🏆</span>;
  if (url)
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={url} alt="" className="h-3 w-4 flex-none rounded-[2px] object-cover" />;
  return <span className="text-[13px] leading-none">⚽</span>;
}

export default function SchoolBoard({
  records,
  upcoming = null,
  admin = false,
  locked = false,
  joinSlot = null,
}: {
  records: SchoolRecord[];
  upcoming?: SchoolRecord | null;
  admin?: boolean;
  locked?: boolean;
  joinSlot?: ReactNode;
}) {
  const [stake, setStake] = useState(10000);
  const router = useRouter();

  // once today's pick has kicked off (any leg live or past kickoff), poll the server for fresh
  // scores so the card updates from "18:30" → live score+minute → final without a manual reload.
  const trackLive =
    !!upcoming &&
    upcoming.legs.some((l) => (l.elapsed != null && !l.finished) || (l.kickoff != null && Date.parse(l.kickoff) <= Date.now()));
  useEffect(() => {
    if (!trackLive) return;
    const id = setInterval(() => router.refresh(), 60000);
    return () => clearInterval(id);
  }, [trackLive, router]);

  // cumulative P/L over the SETTLED record only — the upcoming pick doesn't count until it plays
  const running = useMemo(() => {
    let c = 0;
    return records.map((r) => (c += r.result === "won" ? stake * (r.combined - 1) : -stake));
  }, [records, stake]);

  const sum = useMemo(() => {
    const wins = records.filter((r) => r.result === "won").length;
    const total = running.length ? running[running.length - 1] : 0;
    const avg = records.length ? records.reduce((a, r) => a + r.combined, 0) / records.length : 0;
    const staked = stake * records.length;
    const roi = staked ? Math.round((total / staked) * 100) : 0;
    return { wins, losses: records.length - wins, rate: records.length ? Math.round((wins / records.length) * 100) : 0, avg, total, roi, staked, returned: staked + total };
  }, [records, running, stake]);

  return (
    <div className="mx-auto max-w-4xl px-5 md:px-8">
     <div className="flex flex-col gap-6 md:flex-row-reverse md:items-start md:gap-8">
      {/* profit summary — right sidebar on desktop, top block on mobile */}
      <aside className="md:sticky md:top-4 md:w-[280px] md:flex-none">
      <div className="rounded-2xl border border-white/10 bg-pitch-2 p-5">
        <p className="font-mono text-[10.5px] uppercase tracking-[0.14em] text-onpitch-mute">
          Profit · {short(stake)}/day × {records.length} days
        </p>
        <p className={`mt-1 font-disp text-4xl font-extrabold tracking-tight tabular-nums ${sum.total >= 0 ? "text-grass" : "text-brick"}`}>
          {naira(sum.total)}
        </p>
        <p className="mt-1 text-[11px] leading-snug text-onpitch-mute">
          {locked ? "This could’ve been yours — join to bet the next one." : "What our record has paid you at this stake."}
        </p>
        <div className="mt-3 grid grid-cols-3 gap-2 border-t border-white/10 pt-3 text-center font-mono tabular-nums">
          <div>
            <div className="text-[10px] uppercase tracking-wide text-onpitch-mute">Staked</div>
            <div className="mt-0.5 text-sm font-bold text-chalk">{naira(sum.staked)}</div>
          </div>
          <div>
            <div className="text-[10px] uppercase tracking-wide text-onpitch-mute">Back</div>
            <div className="mt-0.5 text-sm font-bold text-chalk">{naira(sum.returned)}</div>
          </div>
          <div>
            <div className="text-[10px] uppercase tracking-wide text-onpitch-mute">ROI</div>
            <div className={`mt-0.5 text-sm font-bold ${sum.roi >= 0 ? "text-grass" : "text-brick"}`}>
              {sum.roi >= 0 ? "+" : "−"}
              {Math.abs(sum.roi)}%
            </div>
          </div>
        </div>
        <p className="mt-2 text-center font-mono text-[10.5px] text-onpitch-mute tabular-nums">
          {sum.wins}–{sum.losses} · {sum.rate}% · avg ~{sum.avg.toFixed(2)}
        </p>
      </div>

      {/* join card rides in the sidebar, directly under the summary (non-members only) */}
      {joinSlot && <div className="mt-4">{joinSlot}</div>}
      </aside>

      {/* main column: stake + record deck (today's pick rides in as the first card) */}
      <div className="min-w-0 flex-1">
      <div className="flex items-center gap-2">
        <div className="flex h-11 flex-1 items-center rounded-xl border border-white/10 bg-pitch-2 px-3">
          <span className="mr-1 font-disp font-bold text-onpitch-mute">₦</span>
          <input
            inputMode="numeric"
            value={stake.toLocaleString("en-US")}
            onChange={(e) => setStake(Math.max(0, Number(e.target.value.replace(/[^\d]/g, "")) || 0))}
            className="w-full bg-transparent font-disp text-lg font-extrabold tabular-nums text-chalk outline-none"
            aria-label="Daily stake"
          />
        </div>
        {CHIPS.map((c) => (
          <button
            key={c}
            type="button"
            onClick={() => setStake(c)}
            aria-pressed={stake === c}
            className={`h-11 rounded-xl border px-3 font-mono text-[12px] font-bold tabular-nums transition ${
              stake === c ? "border-flood bg-flood/15 text-flood" : "border-white/10 bg-pitch-2 text-onpitch-mute"
            }`}
          >
            {short(c)}
          </button>
        ))}
      </div>

      <Deck records={records} upcoming={upcoming} stake={stake} locked={locked} admin={admin} />

      <MonthlyBreakdown records={records} stake={stake} />
      </div>
     </div>

      <p className="mt-5 text-center font-mono text-[10.5px] uppercase tracking-[0.12em] text-onpitch-mute">
        Real record · flat stakes · odds are the price we took · ~ = model estimate until confirmed · 18+
      </p>
    </div>
  );
}

function Deck({
  records,
  upcoming,
  stake,
  locked,
  admin,
}: {
  records: SchoolRecord[];
  upcoming: SchoolRecord | null;
  stake: number;
  locked: boolean;
  admin: boolean;
}) {
  // today's pick (if any) leads, then the settled record newest → oldest
  const deck = useMemo(() => {
    const settled = [...records].reverse();
    return upcoming ? [upcoming, ...settled] : settled;
  }, [records, upcoming]);
  const [top, setTop] = useState(0);
  const [dx, setDx] = useState(0);
  const drag = useRef({ x: 0, active: false });

  if (deck.length === 0) {
    return (
      <p className="mt-6 rounded-2xl border border-dashed border-white/15 bg-pitch-2 p-6 text-center text-sm text-onpitch-mute">
        No settled doubles yet.
      </p>
    );
  }

  const go = (n: number) => {
    setTop((t) => Math.min(deck.length - 1, Math.max(0, t + n)));
    setDx(0);
  };
  const down = (e: React.PointerEvent) => {
    drag.current = { x: e.clientX, active: true };
  };
  const move = (e: React.PointerEvent) => {
    if (drag.current.active) setDx(e.clientX - drag.current.x);
  };
  const up = () => {
    if (!drag.current.active) return;
    drag.current.active = false;
    if (Math.abs(dx) > 90) go(dx < 0 ? 1 : -1);
    else setDx(0);
  };

  return (
    <div className="mt-6">
      <div className="mb-2 flex items-center justify-between px-1">
        <span className="font-mono text-[10.5px] uppercase tracking-[0.12em] text-onpitch-mute">
          {top + 1}/{deck.length}
        </span>
        <span className="font-mono text-[10.5px] text-onpitch-mute">swipe →</span>
      </div>

      <div className="relative h-[300px] select-none" style={{ touchAction: "pan-y" }}>
        {deck.map((r, i) => {
          const depth = i - top;
          if (depth < 0 || depth > 2) return null;
          const isTop = depth === 0;
          const t = isTop
            ? `translateX(${dx}px) rotate(${dx * 0.04}deg)`
            : `translateY(${depth * 10}px) scale(${1 - depth * 0.04})`;
          return (
            <div
              key={r.date + "-" + i}
              className="absolute inset-0"
              style={{
                transform: t,
                zIndex: 10 - depth,
                opacity: isTop ? 1 - Math.min(Math.abs(dx) / 320, 0.5) : 1,
                transition: drag.current.active && isTop ? "none" : "transform .3s cubic-bezier(.2,.7,.25,1), opacity .3s",
                pointerEvents: isTop ? "auto" : "none",
              }}
              onPointerDown={isTop ? down : undefined}
              onPointerMove={isTop ? move : undefined}
              onPointerUp={isTop ? up : undefined}
              onPointerCancel={isTop ? up : undefined}
            >
              <Card r={r} stake={stake} locked={locked && r.result === "pending"} admin={admin} />
            </div>
          );
        })}
      </div>

      <div className="mt-4 flex gap-2">
        <button onClick={() => go(-1)} disabled={top === 0} className="h-10 flex-1 rounded-xl border border-white/10 bg-pitch-2 text-sm font-bold text-chalk disabled:opacity-40">
          ‹
        </button>
        <button onClick={() => go(1)} disabled={top >= deck.length - 1} className="h-10 flex-1 rounded-xl border border-white/10 bg-pitch-2 text-sm font-bold text-chalk disabled:opacity-40">
          ›
        </button>
      </div>
    </div>
  );
}

// SportyBet booking code printed at the foot of the betslip (light/ink theme to match the slip). One
// tap copies it to load the exact slip in the app. stopPropagation so a tap/copy doesn't start a swipe.
function BookingStrip({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked — the code is on screen anyway */
    }
  };
  return (
    <div className="mt-2 flex items-center justify-between gap-2 rounded-xl border border-dashed border-ink/20 bg-ink/[0.04] px-3 py-1.5">
      <span className="min-w-0">
        <span className="block font-mono text-[9px] uppercase tracking-wide text-ink-mute">SportyBet code</span>
        <span className="block truncate font-disp text-[15px] font-extrabold leading-none tracking-[0.1em] text-flood-deep">{code}</span>
      </span>
      <button
        type="button"
        onClick={copy}
        onPointerDown={(e) => e.stopPropagation()}
        className="flex-none rounded-lg border border-ink/15 px-2.5 py-1 font-mono text-[11px] font-bold text-flood-deep transition hover:border-flood-deep/40"
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

function Card({ r, stake, locked, admin }: { r: SchoolRecord; stake: number; locked?: boolean; admin?: boolean }) {
  const pending = r.result === "pending";
  const won = r.result === "won";
  const dayPL = won ? stake * (r.combined - 1) : -stake;
  const toWin = stake * (r.combined - 1);
  const isLocked = pending && locked;
  // combined odds is an estimate until every leg has a real bookie price entered
  const estimated = r.legs.some((l) => !l.oddsReal);
  const anyLive = r.legs.some((l) => l.elapsed != null && !l.finished);
  const badge = pending
    ? anyLive
      ? "bg-brick/15 text-brick"
      : "bg-flood/15 text-flood-deep"
    : won
      ? "bg-grass/15 text-grass-deep"
      : "bg-brick/15 text-brick";
  const badgeText = pending ? (anyLive ? "Live" : "Not started") : won ? "Won" : "Lost";

  return (
    <div className="betslip betslip-chalk relative flex h-full w-full flex-col overflow-hidden rounded-2xl bg-chalk p-4 text-ink shadow-xl">
      <div className={`flex h-full flex-col ${isLocked ? "blur-[6px]" : ""}`}>
        <div className="flex items-center justify-between">
          <span className="font-mono text-[10.5px] uppercase tracking-wide text-ink-mute">
            {pending ? "Today" : day(r.date)}
          </span>
          <span className={`inline-flex items-center gap-1 rounded px-2 py-0.5 font-mono text-[11px] font-bold uppercase tracking-wide ${badge}`}>
            {anyLive && <span className="inline-block h-1.5 w-1.5 rounded-full bg-brick animate-pulse" />}
            {badgeText}
          </span>
        </div>

        <div className="my-3 flex flex-1 flex-col justify-center gap-2.5 border-y border-dashed border-ink/15 py-3">
          {r.legs.map((l, k) => (
            <div key={k} className="flex items-start justify-between gap-3">
              <span className="flex min-w-0 items-start gap-2">
                <span className="mt-0.5 flex-none">
                  <Flag url={l.flag} tier={l.tier} />
                </span>
                <span className="min-w-0">
                  <span className="block truncate text-[14px] font-bold leading-tight text-ink">{l.game}</span>
                  <span className="mt-0.5 block truncate text-[11px] leading-tight">
                    <span className="font-bold text-flood-deep">Over 2.5</span>
                    {l.league && <span className="text-ink-mute"> · {l.league}</span>}
                  </span>
                </span>
              </span>
              <span className="flex flex-none flex-col items-end gap-0.5">
                {l.score != null ? (
                  <span
                    className={`flex items-center gap-1 font-mono text-[13px] font-bold tabular-nums ${
                      l.hit === true ? "text-grass-deep" : l.hit === false ? "text-brick" : "text-ink"
                    }`}
                  >
                    {l.hit == null && l.elapsed != null && (
                      <span className="inline-block h-1.5 w-1.5 rounded-full bg-brick animate-pulse" />
                    )}
                    {l.score}
                    {l.hit === true ? " ✓" : l.hit == null && l.elapsed != null ? ` · ${l.elapsed}'` : ""}
                  </span>
                ) : l.kickoff ? (
                  <span className="font-mono text-[11px] tabular-nums text-ink-mute">{clock(l.kickoff)}</span>
                ) : null}
                {admin ? (
                  <OddsInput
                    fixtureId={l.fixtureId}
                    real={l.oddsReal ? l.odds : null}
                    estimate={l.oddsReal ? null : l.odds}
                  />
                ) : (
                  <span className="font-mono text-[13px] font-bold tabular-nums text-flood-deep">
                    {l.odds ? (l.oddsReal ? "" : "~") + l.odds.toFixed(2) : "—"}
                  </span>
                )}
              </span>
            </div>
          ))}
        </div>

        <div className="flex items-stretch gap-2">
          <div className="flex-1 rounded-xl bg-ink/[0.05] px-3 py-2">
            <div className="font-mono text-[10px] uppercase tracking-wide text-ink-mute">{pending ? "To win" : "Profit"}</div>
            <div className={`font-disp text-lg font-extrabold tabular-nums ${pending ? "text-ink" : dayPL >= 0 ? "text-grass-deep" : "text-brick"}`}>
              {pending ? naira(toWin) : naira(dayPL)}
            </div>
          </div>
          <div className="rounded-xl bg-ink/[0.05] px-3 py-2 text-right">
            <div className="font-mono text-[10px] uppercase tracking-wide text-ink-mute">Odds</div>
            <div className="font-disp text-lg font-extrabold tabular-nums text-ink">
              {estimated ? "~" : ""}
              {r.combined.toFixed(2)}
            </div>
          </div>
        </div>

        {/* SportyBet booking code printed on the slip (members/admin only — RLS gates the value) */}
        {r.code && <BookingStrip code={r.code} />}
      </div>

      {isLocked && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-chalk/40 p-4 text-center backdrop-blur-[3px]">
          <span className="text-2xl">🔒</span>
          <p className="max-w-[14rem] text-sm font-bold text-ink">Members see the founder&apos;s insight before kickoff.</p>
          <a href="#join" className="rounded-xl bg-flood px-4 py-2 font-disp text-sm font-bold text-pitch transition hover:bg-flood/90">
            Join Onside School
          </a>
        </div>
      )}
    </div>
  );
}

// Admin-only inline editor for a leg's REAL bookie odds. Saving upserts via the is_admin-gated RPC and
// refreshes the page so the card, profit and monthly totals recompute on real money. Empty/≤1 clears
// back to the model estimate. Pointer events are stopped so typing/tapping never starts a deck swipe.
function OddsInput({ fixtureId, real, estimate }: { fixtureId: number; real: number | null; estimate: number | null }) {
  const router = useRouter();
  const [v, setV] = useState(real != null ? String(real) : "");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setV(real != null ? String(real) : "");
  }, [real]);

  async function save() {
    const num = parseFloat(v);
    const next = Number.isFinite(num) && num > 1 ? Math.round(num * 100) / 100 : null;
    if ((next ?? null) === (real ?? null)) return; // unchanged — skip the write
    setBusy(true);
    const supabase = createClient();
    const { error } = await supabase.rpc("school_set_leg_odds", { p_fixture_id: fixtureId, p_odds: next });
    setBusy(false);
    if (!error) router.refresh();
  }

  return (
    <input
      inputMode="decimal"
      value={v}
      onChange={(e) => setV(e.target.value.replace(/[^\d.]/g, ""))}
      onBlur={save}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
      }}
      onPointerDown={(e) => e.stopPropagation()}
      placeholder={estimate != null ? "~" + estimate.toFixed(2) : "odds"}
      disabled={busy}
      aria-label="Real bookie odds for this leg"
      className={`w-16 rounded border px-1.5 py-0.5 text-right font-mono text-[13px] font-bold tabular-nums outline-none transition disabled:opacity-50 ${
        real != null ? "border-flood/40 bg-flood/5 text-flood-deep" : "border-ink/20 bg-ink/[0.03] text-ink-mute focus:border-flood"
      }`}
    />
  );
}

// "How much made each month" — groups the settled record by calendar month (newest first) with each
// month's profit, W–L and ROI at the current stake. Sits under the deck so members can see the run
// month by month, not just the all-time total in the sidebar.
function MonthlyBreakdown({ records, stake }: { records: SchoolRecord[]; stake: number }) {
  const months = useMemo(() => {
    const m = new Map<string, { key: string; wins: number; losses: number; profit: number; staked: number }>();
    for (const r of records) {
      const key = r.date.slice(0, 7); // YYYY-MM
      const cur = m.get(key) ?? { key, wins: 0, losses: 0, profit: 0, staked: 0 };
      const won = r.result === "won";
      cur.wins += won ? 1 : 0;
      cur.losses += won ? 0 : 1;
      cur.profit += won ? stake * (r.combined - 1) : -stake;
      cur.staked += stake;
      m.set(key, cur);
    }
    return [...m.values()].sort((a, b) => (a.key < b.key ? 1 : -1)); // newest month first
  }, [records, stake]);

  if (months.length === 0) return null;

  const label = (key: string) =>
    new Date(key + "-01T00:00:00Z").toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });

  return (
    <div className="mt-8">
      <p className="mb-2 px-1 font-mono text-[10.5px] uppercase tracking-[0.14em] text-onpitch-mute">By month</p>
      <div className="overflow-hidden rounded-2xl border border-white/10 bg-pitch-2">
        {months.map((mo, i) => {
          const roi = mo.staked ? Math.round((mo.profit / mo.staked) * 100) : 0;
          return (
            <div
              key={mo.key}
              className={`flex items-center justify-between gap-3 px-4 py-3 ${i > 0 ? "border-t border-white/10" : ""}`}
            >
              <div className="min-w-0">
                <div className="truncate text-sm font-bold text-chalk">{label(mo.key)}</div>
                <div className="mt-0.5 font-mono text-[11px] tabular-nums text-onpitch-mute">
                  {mo.wins}–{mo.losses} · {roi >= 0 ? "+" : "−"}
                  {Math.abs(roi)}%
                </div>
              </div>
              <div className={`font-disp text-lg font-extrabold tabular-nums ${mo.profit >= 0 ? "text-grass" : "text-brick"}`}>
                {naira(mo.profit)}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
