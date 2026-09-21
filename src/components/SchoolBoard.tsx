"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

export type SchoolLeg = {
  game: string;
  fixtureId: number;
  market: string; // over_1_5 | over_2_5 | over_3_5 | over_4_5 (admin-settable line)
  odds: number | null;
  oddsReal: boolean; // true = real bookie odds an admin typed; false = model estimate (shown "~")
  score: string | null; // current score (live or final), e.g. "2-1"
  hit: boolean | null; // line cleared? true once the goals land, false only at FT under, null pending
  elapsed: number | null;
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
  code?: string | null; // SportyBet booking code for the day (members/admin only)
};

const MARKETS: Array<[string, string]> = [
  ["over_1_5", "Over 1.5"],
  ["over_2_5", "Over 2.5"],
  ["over_3_5", "Over 3.5"],
  ["over_4_5", "Over 4.5"],
];
const MARKET_LABEL: Record<string, string> = Object.fromEntries(MARKETS);

const naira = (n: number) => (n < 0 ? "−₦" : "₦") + Math.round(Math.abs(n)).toLocaleString("en-US");
const short = (n: number) => (n >= 1000 ? "₦" + Math.round(n / 1000) + "k" : "₦" + n);
const day = (iso: string) =>
  new Date(iso + "T00:00:00Z").toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
const monthLabel = (key: string) =>
  new Date(key + "-01T00:00:00Z").toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });
const clock = (iso: string) =>
  new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Africa/Lagos" });

function Flag({ url, tier }: { url: string | null; tier: string | null }) {
  if (tier === "uefa") return <span className="text-[13px] leading-none">🏆</span>;
  if (url)
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={url} alt="" className="h-3 w-4 flex-none rounded-[2px] object-cover" />;
  return <span className="text-[13px] leading-none">⚽</span>;
}

/* ------------------------------------------------------------------ shared slip + admin editor */

// Admin-only per-leg control: swap the LINE (over 1.5/2.5/3.5/4.5) + type the real odds taken. Saves via
// the is_admin-gated RPC and refreshes so the card + record re-grade. Invisible to members. Pointer
// events are stopped so tapping never starts a deck swipe.
function LegEditor({ fixtureId, market, odds }: { fixtureId: number; market: string; odds: number | null }) {
  const router = useRouter();
  const [mkt, setMkt] = useState(market);
  const [v, setV] = useState(odds != null ? String(odds) : "");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setMkt(market);
    setV(odds != null ? String(odds) : "");
  }, [market, odds]);

  async function save(nextMkt: string, nextOddsRaw: string) {
    const num = parseFloat(nextOddsRaw);
    const nextOdds = Number.isFinite(num) && num > 1 ? Math.round(num * 100) / 100 : null;
    if (nextMkt === market && (nextOdds ?? null) === (odds ?? null)) return;
    setBusy(true);
    const supabase = createClient();
    const { error } = await supabase.rpc("school_set_leg_pick", { p_fixture_id: fixtureId, p_market: nextMkt, p_odds: nextOdds });
    setBusy(false);
    if (!error) router.refresh();
  }

  return (
    <span className="flex items-center gap-1.5" onPointerDown={(e) => e.stopPropagation()}>
      <select
        value={mkt}
        disabled={busy}
        onChange={(e) => {
          setMkt(e.target.value);
          save(e.target.value, v);
        }}
        aria-label="Line"
        className="rounded border border-ink/20 bg-ink/[0.04] py-0.5 pl-1.5 pr-0.5 font-mono text-[11px] font-bold text-flood-deep outline-none focus:border-flood disabled:opacity-50"
      >
        {MARKETS.map(([k, lbl]) => (
          <option key={k} value={k}>
            {lbl}
          </option>
        ))}
      </select>
      <input
        inputMode="decimal"
        value={v}
        onChange={(e) => setV(e.target.value.replace(/[^\d.]/g, ""))}
        onBlur={() => save(mkt, v)}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
        }}
        placeholder="odds"
        disabled={busy}
        aria-label="Real odds"
        className={`w-14 rounded border px-1.5 py-0.5 text-right font-mono text-[13px] font-bold tabular-nums outline-none focus:border-flood disabled:opacity-50 ${
          odds != null ? "border-flood/40 bg-flood/5 text-flood-deep" : "border-ink/20 bg-ink/[0.03] text-ink-mute"
        }`}
      />
    </span>
  );
}

// One day's slip (settled or today's pick), on cream betting-slip paper. `admin` swaps each leg's line
// display for the editor; members only ever see the final line + odds.
function Slip({ r, stake, admin, locked }: { r: SchoolRecord; stake: number; admin: boolean; locked?: boolean }) {
  const pending = r.result === "pending";
  const won = r.result === "won";
  const dayPL = won ? stake * (r.combined - 1) : -stake;
  const toWin = stake * (r.combined - 1);
  const anyLive = r.legs.some((l) => l.elapsed != null && !l.finished);
  const estimated = r.legs.some((l) => !l.oddsReal);
  const badge = pending
    ? anyLive
      ? "bg-brick/15 text-brick"
      : "bg-flood/15 text-flood-deep"
    : won
      ? "bg-grass/15 text-grass-deep"
      : "bg-brick/15 text-brick";
  const badgeText = pending ? (anyLive ? "Live" : "Not started") : won ? "Won" : "Lost";

  return (
    <div className="betslip betslip-chalk relative flex w-full flex-col overflow-hidden rounded-2xl bg-chalk p-4 text-ink shadow-xl">
      <div className={locked ? "blur-[6px]" : ""}>
        <div className="flex items-center justify-between">
          <span className="font-mono text-[10.5px] uppercase tracking-wide text-ink-mute">{pending ? "Today" : day(r.date)}</span>
          <span className={`inline-flex items-center gap-1 rounded px-2 py-0.5 font-mono text-[11px] font-bold uppercase tracking-wide ${badge}`}>
            {anyLive && <span className="inline-block h-1.5 w-1.5 rounded-full bg-brick" />}
            {badgeText}
          </span>
        </div>

        <div className="my-3 flex flex-col gap-2.5 border-y border-dashed border-ink/15 py-3">
          {r.legs.map((l, k) => (
            <div key={k} className="flex items-start justify-between gap-3">
              <span className="flex min-w-0 items-start gap-2">
                <span className="mt-0.5 flex-none">
                  <Flag url={l.flag} tier={l.tier} />
                </span>
                <span className="min-w-0">
                  <span className="block truncate text-[14px] font-bold leading-tight text-ink">{l.game}</span>
                  <span className="mt-0.5 block truncate text-[11px] leading-tight">
                    {!admin && <span className="font-bold text-flood-deep">{MARKET_LABEL[l.market] ?? "Over 2.5"}</span>}
                    {l.league && <span className="text-ink-mute">{admin ? "" : " · "}{l.league}</span>}
                  </span>
                </span>
              </span>
              <span className="flex flex-none flex-col items-end gap-1">
                {l.score != null ? (
                  <span
                    className={`flex items-center gap-1 font-mono text-[13px] font-bold tabular-nums ${
                      l.hit === true ? "text-grass-deep" : l.hit === false ? "text-brick" : "text-ink"
                    }`}
                  >
                    {l.hit == null && l.elapsed != null && <span className="inline-block h-1.5 w-1.5 rounded-full bg-brick" />}
                    {l.score}
                    {l.hit === true ? " ✓" : l.hit == null && l.elapsed != null ? ` · ${l.elapsed}'` : ""}
                  </span>
                ) : l.kickoff ? (
                  <span className="font-mono text-[11px] tabular-nums text-ink-mute">{clock(l.kickoff)}</span>
                ) : null}
                {admin ? (
                  <LegEditor fixtureId={l.fixtureId} market={l.market} odds={l.oddsReal ? l.odds : null} />
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

        {r.code && (
          <div className="mt-2 flex items-center justify-between gap-2 rounded-xl border border-dashed border-ink/20 bg-ink/[0.04] px-3 py-1.5">
            <span className="min-w-0">
              <span className="block font-mono text-[9px] uppercase tracking-wide text-ink-mute">SportyBet code</span>
              <span className="block truncate font-disp text-[15px] font-extrabold leading-none tracking-[0.1em] text-flood-deep">{r.code}</span>
            </span>
          </div>
        )}
      </div>

      {locked && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-chalk/40 p-4 text-center backdrop-blur-[3px]">
          <span className="text-2xl">🔒</span>
          <p className="max-w-[14rem] text-sm font-bold text-ink">Members see the founder&apos;s insight before kickoff.</p>
        </div>
      )}
    </div>
  );
}

// A swipeable deck of settled slips — one at a time, so a 30-ticket month never lengthens the page.
function Deck({ records, stake, admin }: { records: SchoolRecord[]; stake: number; admin: boolean }) {
  const [i, setI] = useState(0);
  const drag = useRef({ x: 0, active: false });
  useEffect(() => {
    setI(0);
  }, [records]);
  if (records.length === 0)
    return (
      <p className="rounded-2xl border border-dashed border-white/15 bg-pitch-2 p-6 text-center text-sm text-onpitch-mute">
        No settled doubles this month yet.
      </p>
    );
  const idx = Math.min(i, records.length - 1);
  const r = records[idx];
  const go = (n: number) => setI((v) => Math.min(records.length - 1, Math.max(0, v + n)));
  return (
    <div>
      <div className="mb-2 flex items-center justify-between px-1 font-mono text-[10.5px] uppercase tracking-[0.12em] text-onpitch-mute">
        <span>
          {idx + 1} / {records.length}
        </span>
        <span>swipe →</span>
      </div>
      <div
        className="select-none"
        style={{ touchAction: "pan-y" }}
        onPointerDown={(e) => {
          e.stopPropagation();
          drag.current = { x: e.clientX, active: true };
        }}
        onPointerUp={(e) => {
          e.stopPropagation();
          if (!drag.current.active) return;
          drag.current.active = false;
          const dx = e.clientX - drag.current.x;
          if (Math.abs(dx) > 60) go(dx < 0 ? 1 : -1);
        }}
      >
        <Slip r={r} stake={stake} admin={admin} />
      </div>
      <div className="mt-4 flex gap-2">
        <button onClick={() => go(-1)} disabled={idx === 0} className="h-10 flex-1 rounded-xl border border-white/10 bg-pitch-2 text-sm font-bold text-chalk disabled:opacity-40">
          ‹
        </button>
        <button onClick={() => go(1)} disabled={idx >= records.length - 1} className="h-10 flex-1 rounded-xl border border-white/10 bg-pitch-2 text-sm font-bold text-chalk disabled:opacity-40">
          ›
        </button>
      </div>
    </div>
  );
}

const CHIPS = [5000, 10000, 20000, 50000];
function StakeRow({ stake, setStake }: { stake: number; setStake: (n: number) => void }) {
  return (
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
  );
}

/* ------------------------------------------------------------------ member dashboard */

// The record, browsable by month — shown to members AND visitors (the record is what convinces).
// Month chips → a one-at-a-time swipe deck for the chosen month. Pointer events are stopped inside
// the deck so it can live inside the funnel's own swipe without flipping the wizard page.
function RecordBrowser({ records, stake, admin }: { records: SchoolRecord[]; stake: number; admin: boolean }) {
  const months = useMemo(() => {
    const m = new Map<string, SchoolRecord[]>();
    for (const r of records) {
      const key = r.date.slice(0, 7);
      const arr = m.get(key);
      if (arr) arr.push(r);
      else m.set(key, [r]);
    }
    return [...m.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1)); // newest first
  }, [records]);
  const [sel, setSel] = useState(0);
  const selKey = months[Math.min(sel, Math.max(0, months.length - 1))]?.[0] ?? "";
  const selRecords = useMemo(() => (months.find(([k]) => k === selKey)?.[1] ?? []).slice().reverse(), [months, selKey]);
  const monthStat = (recs: SchoolRecord[]) => {
    const wins = recs.filter((r) => r.result === "won").length;
    const profit = recs.reduce((a, r) => a + (r.result === "won" ? stake * (r.combined - 1) : -stake), 0);
    const staked = stake * recs.length;
    return { wins, losses: recs.length - wins, profit, roi: staked ? Math.round((profit / staked) * 100) : 0 };
  };
  const selStat = monthStat(months.find(([k]) => k === selKey)?.[1] ?? []);
  if (months.length === 0)
    return <p className="rounded-2xl border border-dashed border-white/15 bg-pitch-2 p-6 text-center text-sm text-onpitch-mute">No settled doubles yet.</p>;
  return (
    <div>
      <div className="no-scrollbar -mx-1 flex gap-2 overflow-x-auto px-1 pb-1">
        {months.map(([key, recs], k) => {
          const st = monthStat(recs);
          return (
            <button
              key={key}
              type="button"
              onClick={() => setSel(k)}
              className={`flex-none rounded-xl border px-3.5 py-2.5 text-left leading-tight transition ${
                k === Math.min(sel, months.length - 1) ? "border-flood bg-flood/[0.12] text-chalk" : "border-white/10 bg-pitch-2 text-onpitch-mute"
              }`}
            >
              <span className="block font-mono text-[11px] font-bold">{monthLabel(key)}</span>
              <span className={`mt-1 block font-mono text-[13px] font-bold tabular-nums ${st.profit >= 0 ? "text-grass" : "text-brick"}`}>{naira(st.profit)}</span>
            </button>
          );
        })}
      </div>
      <p className="my-3 px-1 font-mono text-[12px] text-onpitch-mute">
        {monthLabel(selKey)} ·{" "}
        <b className={`font-disp text-[15px] ${selStat.profit >= 0 ? "text-grass" : "text-brick"}`}>{naira(selStat.profit)}</b> · {selStat.wins}–{selStat.losses} ·{" "}
        {selStat.roi >= 0 ? "+" : "−"}
        {Math.abs(selStat.roi)}% ROI
      </p>
      <Deck records={selRecords} stake={stake} admin={admin} />
    </div>
  );
}

export function SchoolMember({ records, upcoming, admin }: { records: SchoolRecord[]; upcoming: SchoolRecord | null; admin: boolean }) {
  const [stake, setStake] = useState(20000);
  const all = useMemo(() => {
    const wins = records.filter((r) => r.result === "won").length;
    const total = records.reduce((a, r) => a + (r.result === "won" ? stake * (r.combined - 1) : -stake), 0);
    const staked = stake * records.length;
    return {
      wins,
      losses: records.length - wins,
      total,
      staked,
      roi: staked ? Math.round((total / staked) * 100) : 0,
      strike: records.length ? Math.round((wins / records.length) * 100) : 0,
    };
  }, [records, stake]);
  // today's double is the headline above; keep it out of the month browser so it isn't listed twice
  const history = upcoming ? records.filter((r) => r.date !== upcoming.date) : records;

  return (
    <div className="mx-auto max-w-[960px] px-5 pt-6 md:px-8">
      <p className="font-mono text-[11px] uppercase tracking-[0.22em] text-flood">Onside School · Member</p>
      <h1 className="mt-1 font-disp text-2xl font-bold tracking-tight text-chalk">Welcome back.</h1>

      {/* stake control */}
      <div className="mt-4">
        <StakeRow stake={stake} setStake={setStake} />
      </div>

      {/* the amount won — the motivation, big up top */}
      <div className="mt-4 rounded-2xl border border-flood/30 bg-gradient-to-br from-flood/[0.14] to-flood/[0.03] p-5">
        <div className="font-mono text-[10.5px] uppercase tracking-[0.12em] text-flood">Won at {short(stake)}/day · {records.length} days</div>
        <div className={`mt-2 font-disp text-[clamp(2.6rem,11vw,3.75rem)] font-extrabold leading-none tracking-tight tabular-nums ${all.total >= 0 ? "text-flood" : "text-brick"}`}>
          {naira(all.total)}
        </div>
        <p className="mt-2 max-w-[34ch] text-[13.5px] text-onpitch">Roll it into a bigger unit and the same record pays more. That&apos;s the business.</p>
        <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
          {([
            ["Record", `${all.wins}–${all.losses}`, ""],
            ["Strike rate", `${all.strike}%`, ""],
            ["ROI", `${all.roi >= 0 ? "+" : "−"}${Math.abs(all.roi)}%`, all.roi >= 0 ? "text-grass" : "text-brick"],
            ["Staked", naira(all.staked), ""],
          ] as const).map(([k, v, cls]) => (
            <div key={k} className="rounded-xl border border-flood/15 bg-pitch/40 px-3.5 py-2.5">
              <div className="font-mono text-[9.5px] uppercase tracking-wide text-onpitch-mute">{k}</div>
              <div className={`mt-1 font-disp text-lg font-extrabold tabular-nums ${cls || "text-chalk"}`}>{v}</div>
            </div>
          ))}
        </div>
      </div>

      {/* two columns: today's game | the record. Stacks on mobile. */}
      <div className="mt-5 grid grid-cols-1 gap-5 md:grid-cols-2 md:items-start md:gap-6">
        {/* today's game */}
        <div>
          <p className="mb-2 px-1 font-mono text-[10.5px] uppercase tracking-[0.12em] text-onpitch-mute">Today&apos;s double</p>
          {upcoming ? (
            <Slip r={upcoming} stake={stake} admin={admin} />
          ) : (
            <p className="rounded-2xl border border-dashed border-white/15 bg-pitch-2 p-6 text-center text-sm text-onpitch-mute">
              Today&apos;s double isn&apos;t set yet — check back before kickoff.
            </p>
          )}
        </div>

        {/* the record */}
        <div>
          <p className="mb-2 px-1 font-mono text-[10.5px] uppercase tracking-[0.12em] text-onpitch-mute">The record — tap a month</p>
          <RecordBrowser records={history} stake={stake} admin={admin} />
        </div>
      </div>

      <p className="mt-8 text-center font-mono text-[10.5px] uppercase tracking-[0.12em] text-onpitch-mute">
        Real record · flat stakes · odds are the price we took · 18+
      </p>
    </div>
  );
}

/* ------------------------------------------------------------------ visitor induction funnel */

export function SchoolFunnel({
  wins,
  losses,
  roi,
  days,
  records,
  price,
  bank,
  enroll,
}: {
  wins: number;
  losses: number;
  roi: number;
  days: number;
  records: SchoolRecord[];
  price: number;
  bank: { bank: string; account: string; name: string };
  enroll: ReactNode;
}) {
  const [i, setI] = useState(0);
  const [stake, setStake] = useState(20000);
  const drag = useRef({ x: 0, active: false });
  const strike = days ? Math.round((wins / days) * 100) : 0;
  // what the whole real record would have paid at their stake — nothing hidden
  const wouldMake = records.reduce((a, r) => a + (r.result === "won" ? stake * (r.combined - 1) : -stake), 0);

  const pages: ReactNode[] = [
    // 0 · cover
    <div key="c">
      <div className="mb-4 font-mono text-[11px] uppercase tracking-[0.18em] text-onpitch-mute">
        <span className="font-bold text-flood">VVIP</span> · The induction
      </div>
      <h1 className="font-disp text-[clamp(2.1rem,9vw,2.9rem)] font-extrabold leading-[1.02] tracking-tight text-chalk">
        Treat it like a business. Not a bet.
      </h1>
      <p className="mt-4 max-w-[42ch] text-[17px] text-onpitch">
        One banker double a day. A public record that logs every result — wins <span className="text-grass">and</span> losses. And the discipline to
        turn a small daily stake into a serious month.
      </p>
      <div className="mt-6 grid grid-cols-3 gap-2.5">
        {[
          ["Record", `${wins}–${losses}`, ""],
          ["Strike", `${strike}%`, ""],
          ["ROI", `${roi >= 0 ? "+" : "−"}${Math.abs(roi)}%`, roi >= 0 ? "text-grass" : "text-brick"],
        ].map(([k, v, cls]) => (
          <div key={k} className="rounded-2xl border border-white/10 bg-pitch-2 p-3.5">
            <div className="font-mono text-[10px] uppercase tracking-wide text-onpitch-mute">{k}</div>
            <div className={`mt-1 font-disp text-2xl font-extrabold tabular-nums ${cls || "text-chalk"}`}>{v}</div>
          </div>
        ))}
      </div>
    </div>,
    // 1 · what — the founder's insight, the proven record, the goal: grow your money
    <div key="w">
      <Eyebrow n="01" t="What this is" />
      <H2>
        The founder&apos;s insight. Built to <span className="text-flood">grow your money.</span>
      </H2>
      <p className="mb-4 max-w-[46ch] text-onpitch">
        Every morning you get one call — the single bet the founder stakes real money on, in your hands before kickoff. Not tips for the thrill: a
        disciplined play off a record that&apos;s public, proven, and yours to check any day.
      </p>
      <RuleCard t="Here to make you money" d="A small flat stake, one call a day, compounding over a proven month — grown like a business, not gambled." />
      <RuleCard t="A proven, public record" d="Every result logged where anyone can see it — the wins and the losses. Nothing hidden, nothing rewritten." />
      <RuleCard t="The same edge as the founder" d="No inside tier, no VIP-of-the-VIP. You bet exactly what the founder bets, at the same price." />
    </div>,
    // 2 · rules
    <div key="r">
      <Eyebrow n="02" t="The rules of the business" />
      <H2>Four rules. Break one and it stops working.</H2>
      {[
        ["Flat stakes", "The same amount every day. Winning days don't earn a bigger bet; losing days don't earn a smaller one."],
        ["One bet a day", "The double. Nothing else on the slip — no 'just one more' to spice it up."],
        ["Never chase", "A losing day is data, not a reason to double up. The edge shows over the month, not the match."],
        ["Bankroll before profit", "You protect the pool first. Profit is what's left after you've survived the bad runs."],
      ].map(([t, d], k) => (
        <RuleCard key={t} n={String(k + 1)} t={t} d={d} />
      ))}
    </div>,
    // 3 · bankroll
    <div key="b">
      <Eyebrow n="03" t="Your bankroll is the business" />
      <H2>Never stake your wallet. Stake a unit.</H2>
      <p className="mb-4 max-w-[46ch] text-onpitch">
        Set one daily unit, then keep a pool of <b className="text-flood">at least 3× that</b> behind it. The pool absorbs the losing runs that <i>will</i>{" "}
        come — so one bad week never ends you.
      </p>
      <Bankroll stake={stake} setStake={setStake} />
    </div>,
    // 4 · proof — the visitor sets their stake and sees what the whole record would have paid
    <div key="p">
      <Eyebrow n="04" t="The proof" />
      <H2>Put in your stake. Nothing hidden.</H2>
      <p className="mb-4 max-w-[46ch] text-onpitch">
        This is the real record — every double, win and loss. Set your daily stake and see exactly what it would have paid you across every month
        we&apos;ve covered.
      </p>
      <StakeRow stake={stake} setStake={setStake} />
      <div className="my-4 rounded-2xl border border-flood/30 bg-gradient-to-br from-flood/[0.14] to-flood/[0.03] p-5">
        <div className="font-mono text-[10.5px] uppercase tracking-[0.12em] text-flood">
          At {short(stake)}/day · {days} days, you&apos;d have made
        </div>
        <div className={`mt-2 font-disp text-[clamp(2.4rem,10vw,3.4rem)] font-extrabold leading-none tracking-tight tabular-nums ${wouldMake >= 0 ? "text-flood" : "text-brick"}`}>
          {naira(wouldMake)}
        </div>
        <p className="mt-2 text-[13px] text-onpitch-mute">Flat stakes, one double a day. The losing days are in here too.</p>
      </div>
      {records.length ? (
        <RecordBrowser records={records} stake={stake} admin={false} />
      ) : (
        <p className="text-onpitch-mute">The record starts filling this week.</p>
      )}
    </div>,
    // 5 · join
    <div key="j">
      <Eyebrow n="05" t="Take your seat" />
      <H2>Join the room. See tomorrow first.</H2>
      <p className="mb-4 max-w-[46ch] text-onpitch">
        Members get the next day&apos;s double <b>before kickoff</b>, every day, plus the SportyBet code to load it in one tap — and the full record,
        month by month.
      </p>
      {enroll}
    </div>,
  ];
  const N = pages.length;
  const labels = ["Start the induction →", "Next: the rules →", "Next: your bankroll →", "Next: the proof →", "Next: join →", "Read again"];
  const go = (n: number) => setI((v) => Math.max(0, Math.min(N - 1, v + n)));

  return (
    <div className="mx-auto max-w-[520px] px-5 pt-6">
      {/* progress rail */}
      <div className="mb-6 flex items-center gap-2">
        <span className="whitespace-nowrap font-mono text-[11px] font-bold uppercase tracking-[0.2em] text-flood">⚡ Onside School</span>
        <div className="flex flex-1 justify-end gap-1.5">
          {pages.map((_, k) => (
            <span key={k} className={`h-[3px] rounded-full transition-all ${k === i ? "w-[30px] bg-flood" : k < i ? "w-[22px] bg-onpitch-mute" : "w-[22px] bg-white/10"}`} />
          ))}
        </div>
      </div>

      <div
        className="min-h-[62vh] select-none"
        style={{ touchAction: "pan-y" }}
        onPointerDown={(e) => (drag.current = { x: e.clientX, active: true })}
        onPointerUp={(e) => {
          if (!drag.current.active) return;
          drag.current.active = false;
          const dx = e.clientX - drag.current.x;
          if (Math.abs(dx) > 70) go(dx < 0 ? 1 : -1);
        }}
      >
        {pages[i]}
      </div>

      <div className="mt-7 flex items-center gap-2.5">
        <button
          onClick={() => go(-1)}
          disabled={i === 0}
          aria-label="Previous page"
          className="h-[54px] w-[54px] flex-none rounded-2xl border border-white/10 bg-pitch-2 text-xl font-bold text-chalk disabled:opacity-30"
        >
          ‹
        </button>
        <button
          onClick={() => (i < N - 1 ? go(1) : setI(0))}
          className="h-[54px] flex-1 rounded-2xl bg-flood font-disp text-base font-extrabold text-ink transition hover:brightness-105"
        >
          {labels[i]}
        </button>
      </div>
      <div className="mt-3.5 text-center font-mono text-[11px] tracking-[0.05em] text-onpitch-mute">
        Page {i + 1} of {N}
      </div>
      <p className="mt-5 text-center font-mono text-[10.5px] uppercase tracking-[0.08em] text-onpitch-mute">
        18+ · stake only what your pool allows
      </p>
    </div>
  );
}

function Eyebrow({ n, t }: { n: string; t: string }) {
  return (
    <div className="mb-4 flex items-center gap-2.5 font-mono text-[11px] uppercase tracking-[0.14em] text-onpitch-mute">
      <span className="rounded border border-flood px-1.5 py-0.5 tracking-[0.1em] text-flood">{n}</span>
      {t}
    </div>
  );
}
function H2({ children }: { children: ReactNode }) {
  return <h2 className="mb-3.5 font-disp text-[clamp(1.7rem,7vw,2.1rem)] font-extrabold leading-[1.05] tracking-tight text-chalk">{children}</h2>;
}
function RuleCard({ n, t, d }: { n?: string; t: string; d: string }) {
  return (
    <div className="mt-3 flex gap-3.5 rounded-2xl border border-white/10 bg-pitch-2 p-4">
      <span className="min-w-[22px] font-mono text-[15px] font-bold tabular-nums text-flood">{n ?? "→"}</span>
      <div>
        <div className="font-disp text-base font-bold text-chalk">{t}</div>
        <div className="mt-0.5 text-[13.5px] text-onpitch-mute">{d}</div>
      </div>
    </div>
  );
}
function Bankroll({ stake, setStake }: { stake: number; setStake: (n: number) => void }) {
  const pool = stake * 3;
  return (
    <div className="rounded-2xl border border-white/10 bg-pitch-2 p-5">
      <label htmlFor="bk" className="mb-2 block font-mono text-[10.5px] uppercase tracking-[0.12em] text-onpitch-mute">
        Your daily stake
      </label>
      <div className="flex h-14 items-center gap-2 rounded-xl border border-white/10 bg-pitch px-3.5">
        <span className="font-disp text-xl font-extrabold text-onpitch-mute">₦</span>
        <input
          id="bk"
          inputMode="numeric"
          value={stake.toLocaleString("en-US")}
          onChange={(e) => setStake(Math.max(0, Number(e.target.value.replace(/[^\d]/g, "")) || 0))}
          className="w-full bg-transparent font-disp text-2xl font-extrabold tabular-nums text-chalk outline-none"
          aria-label="Daily stake"
        />
      </div>
      <div className="mt-2.5 flex gap-1.5">
        {CHIPS.map((c) => (
          <button
            key={c}
            type="button"
            onClick={() => setStake(c)}
            className={`h-9 flex-1 rounded-lg border font-mono text-[12px] font-bold transition ${
              stake === c ? "border-flood bg-flood/10 text-flood" : "border-white/10 bg-pitch text-onpitch-mute"
            }`}
          >
            {short(c)}
          </button>
        ))}
      </div>
      <div className="mt-4 flex gap-3">
        <div className="flex-1 rounded-xl border border-flood/40 bg-flood/[0.08] p-3.5 text-center">
          <div className="font-mono text-[9.5px] uppercase tracking-wide text-onpitch-mute">Pool you need</div>
          <div className="mt-1 font-disp text-[22px] font-extrabold tabular-nums text-flood">{naira(pool)}</div>
        </div>
        <div className="flex-1 rounded-xl border border-white/10 bg-pitch p-3.5 text-center">
          <div className="font-mono text-[9.5px] uppercase tracking-wide text-onpitch-mute">A 3-loss run costs</div>
          <div className="mt-1 font-disp text-[22px] font-extrabold tabular-nums text-chalk">{naira(pool)}</div>
        </div>
      </div>
      <p className="mt-3.5 text-[13px] leading-relaxed text-onpitch-mute">
        <b className="text-chalk">Stake {naira(stake)}, hold {naira(pool)}.</b> Three losses in a row would clear your whole pool — that&apos;s exactly why
        it&apos;s the floor you keep, never the amount you bet. Bet the unit; guard the pool.
      </p>
    </div>
  );
}
