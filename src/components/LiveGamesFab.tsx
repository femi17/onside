"use client";

// Floating games peek. Always present on signed-in pages (except the tracker itself) as a small
// tracker glyph that STAYS PUT — pop it open mid-flow (e.g. while building an agent) for a quick
// look and close it again. It never navigates you away; only the explicit footer links do. It
// surfaces BOTH your tracked bets (tickets) and your agent's picks (deliveries), and the glyph
// lights up into a pulsing "N live" pill the moment any of them kick off.
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { useMinuteTick } from "@/lib/useMinuteTick";
import { type MatchState } from "@/lib/matchState";
import { type TrackedTicket, stateOf, groupOf, betSignal, type Signal } from "@/lib/ticket";

// the fixture sub-select is shared by both sources so the live logic sees an identical shape
const FIXTURE_SELECT =
  "fixtures(home_team, away_team, kickoff_utc, status, elapsed, home_goals, away_goals, extra, events, updated_at, leagues(name, flag_url, tier), fixture_stats(momentum, corners_home, corners_away))";
const TICKET_SELECT =
  `id, fixture_id, market_key, market_label, custom_market, line, side, bet_value, status, current_value, tracker_hidden, ${FIXTURE_SELECT}`;
const DELIVERY_SELECT =
  `id, fixture_id, market_key, market_label, line, side, bet_value, result, current_value, delivered_at, strategies(name), ${FIXTURE_SELECT}`;

// live win/lose read → a dot colour. Green = winning now, amber = in the balance, red = losing.
// (Red here is real-time bet status — it means this bet is behind — not a "confidence" grade.)
const SIGNAL_DOT: Record<Signal, string> = {
  green: "bg-emerald-400",
  yellow: "bg-amber-400",
  red: "bg-rose-400",
};

type RawTicket = TrackedTicket & { fixture_id?: number | null; tracker_hidden?: boolean };
type RawDelivery = {
  id: string; fixture_id: number | null; market_key: string | null; market_label: string | null;
  line: number | null; side: string | null; bet_value: string | null; result: string;
  current_value: number | null; delivered_at: string | null;
  strategies?: { name: string | null } | { name: string | null }[] | null;
  fixtures: TrackedTicket["fixtures"];
};

type PeekItem = { id: string; t: TrackedTicket; ms: MatchState | null; source: "tracker" | "agent"; agent: string | null; more: number };

// a delivery grades on `result`; map it onto the ticket shape's `status` so stateOf/groupOf/betSignal work
function deliveryAsTicket(d: RawDelivery): TrackedTicket {
  return {
    id: d.id, market_key: d.market_key, market_label: d.market_label, custom_market: null,
    line: d.line, side: d.side, bet_value: d.bet_value, status: d.result,
    current_value: d.current_value, created_at: d.delivered_at, settled_at: null, fixtures: d.fixtures,
  };
}
const dedupKey = (fixtureId: number | null | undefined, mk: string | null, side: string | null) => `${fixtureId ?? "?"}|${mk ?? ""}|${side ?? ""}`;

export default function LiveGamesFab() {
  const pathname = usePathname();
  const now = useMinuteTick();
  const [tickets, setTickets] = useState<RawTicket[]>([]);
  const [deliveries, setDeliveries] = useState<RawDelivery[]>([]);
  const [open, setOpen] = useState(false);

  // no peek on the tracker (you're already there). Elsewhere it's centered on mobile so it clears
  // the bottom-right slip button that some pages (add / agent builder) float.
  const hidden = pathname === "/tracker";

  useEffect(() => {
    if (hidden) return;
    const supabase = createClient();
    let alive = true;
    const load = async () => {
      // RLS scopes both tables to the current user; only unsettled bets can be live
      const [tk, dl] = await Promise.all([
        supabase.from("tickets").select(TICKET_SELECT).in("status", ["pending", "live"]),
        supabase.from("deliveries").select(DELIVERY_SELECT).eq("result", "pending"),
      ]);
      if (!alive) return;
      setTickets((tk.data as unknown as RawTicket[]) ?? []);
      setDeliveries((dl.data as unknown as RawDelivery[]) ?? []);
    };
    load();
    // refresh scores every 30s + react instantly to the user's own ticket/delivery changes.
    // We deliberately DON'T bind the global fixtures feed (that's a refresh storm); the poll keeps
    // live scores fresh enough for a glanceable peek.
    const poll = setInterval(load, 30_000);
    const channel = supabase
      .channel("onside-live-fab")
      .on("postgres_changes", { event: "*", schema: "public", table: "tickets" }, load)
      .on("postgres_changes", { event: "*", schema: "public", table: "deliveries" }, load)
      .subscribe();
    return () => {
      alive = false;
      clearInterval(poll);
      supabase.removeChannel(channel);
    };
  }, [hidden]);

  const { live, upcoming } = useMemo(() => {
    // ONE ROW PER GAME. Several of your bets can sit on the same fixture (a tracked pick plus
    // other agents' markets on that game) — the peek collapses them into a single row with a
    // "+N more" note instead of listing the match twice. The exact-bet key still dedups a
    // tracked agent pick against its source delivery, so tracking a pick never adds a row OR
    // a "+1 more" of itself. The pill therefore counts live GAMES, not bets.
    const rows = new Map<number | string, PeekItem>();
    const seenBets = new Set<string>();
    const upFx = new Set<number | string>();

    const add = (fxKey: number | string, betKey: string, make: () => PeekItem) => {
      if (seenBets.has(betKey)) return; // same bet from the other source
      seenBets.add(betKey);
      const cur = rows.get(fxKey);
      if (cur) cur.more++;
      else rows.set(fxKey, make());
    };

    for (const t of tickets ?? []) {
      if (t.tracker_hidden || !t.fixtures) continue;
      const ms = stateOf(t, now);
      const g = groupOf(t, ms);
      const fxKey = t.fixture_id ?? `tk-${t.id}`;
      const betKey = dedupKey(t.fixture_id, t.market_key, t.side ?? null);
      if (g === "live") add(fxKey, betKey, () => ({ id: `tk-${t.id}`, t, ms, source: "tracker", agent: null, more: 0 }));
      else if (g === "upcoming") { seenBets.add(betKey); upFx.add(fxKey); }
    }
    for (const d of deliveries ?? []) {
      if (!d.fixtures) continue;
      const t = deliveryAsTicket(d);
      const ms = stateOf(t, now);
      const g = groupOf(t, ms);
      const fxKey = d.fixture_id ?? `ag-${d.id}`;
      const betKey = dedupKey(d.fixture_id, d.market_key, d.side);
      if (g === "live") {
        const agent = Array.isArray(d.strategies) ? d.strategies[0]?.name ?? null : d.strategies?.name ?? null;
        add(fxKey, betKey, () => ({ id: `ag-${d.id}`, t, ms, source: "agent", agent, more: 0 }));
      } else if (g === "upcoming" && !seenBets.has(betKey)) { seenBets.add(betKey); upFx.add(fxKey); }
    }
    return { live: Array.from(rows.values()), upcoming: upFx.size };
  }, [tickets, deliveries, now]);

  if (hidden) return null;
  const isLive = live.length > 0;
  // every live row from the agent (nothing tracked by hand) → say so up front and point the
  // footer at /agent first, so following the pulse never lands on an empty tracker page
  const allAgent = isLive && live.every((i) => i.source === "agent");
  const links = allAgent
    ? [{ href: "/agent", label: "Agent" }, { href: "/tracker", label: "Tracker" }]
    : [{ href: "/tracker", label: "Tracker" }, { href: "/agent", label: "Agent" }];

  return (
    // mobile: centered above the tab bar (clears the bottom-right slip button); desktop: bottom-right
    // but lifted clear of the footer (which sits at the very bottom with a top border)
    <div className="fixed bottom-[calc(84px+env(safe-area-inset-bottom))] left-1/2 z-40 flex -translate-x-1/2 flex-col items-center md:bottom-20 md:left-auto md:right-6 md:translate-x-0 md:items-end">
      {/* click-away layer while expanded — closes the peek, never navigates */}
      {open && <button aria-label="Close peek" onClick={() => setOpen(false)} className="fixed inset-0 -z-10 cursor-default" />}

      {open && (
        <div className="mb-3 w-[min(88vw,20rem)] overflow-hidden rounded-2xl border border-white/10 bg-pitch/95 shadow-2xl backdrop-blur">
          <div className="flex items-center justify-between border-b border-white/10 px-4 py-2.5">
            <div className="flex items-center gap-2">
              {isLive ? <LivePulse /> : <span className="h-2.5 w-2.5 flex-none rounded-full bg-white/25" />}
              <span className="font-mono text-[11px] uppercase tracking-wide text-chalk">
                {isLive ? (allAgent ? `Agent picks live · ${live.length}` : `Live now · ${live.length}`) : "Your games"}
              </span>
            </div>
            <button
              onClick={() => setOpen(false)}
              aria-label="Close"
              className="flex h-6 w-6 items-center justify-center rounded-md text-onpitch-mute transition-colors hover:text-chalk"
            >
              ×
            </button>
          </div>

          {isLive ? (
            <div className="no-scrollbar max-h-[min(60vh,26rem)] divide-y divide-white/5 overflow-y-auto">
              {live.map(({ id, t, ms, source, agent, more }) => {
                const f = t.fixtures!;
                const hg = f.home_goals ?? 0, ag = f.away_goals ?? 0;
                const sig = betSignal(t, hg, ag);
                const pick = t.market_label ?? t.custom_market ?? t.market_key ?? "";
                return (
                  // rows are read-only — the peek is for glancing, not navigating
                  <div key={id} className="flex items-center gap-2.5 px-4 py-2.5">
                    <span className={`h-2 w-2 flex-none rounded-full ${sig ? SIGNAL_DOT[sig] : "bg-white/30"}`} />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="min-w-0 flex-1 truncate text-sm text-chalk">
                          {f.home_team} <span className="text-onpitch-mute">v</span> {f.away_team}
                        </span>
                        <span className="flex-none font-mono text-sm font-bold tabular-nums text-chalk">{hg}–{ag}</span>
                      </div>
                      <div className="mt-0.5 flex items-center gap-1.5 truncate font-mono text-[10.5px] uppercase tracking-wide text-onpitch-mute">
                        <span className="flex-none text-flood">{ms?.label ?? "Live"}</span>
                        {source === "agent" && (
                          <span className="flex-none rounded-sm bg-flood/15 px-1 text-flood" title={agent ? `Agent: ${agent}` : "Agent pick"}>
                            🤖{agent ? ` ${agent}` : ""}
                          </span>
                        )}
                        {pick && <><span className="opacity-40">·</span><span className="truncate">{pick}</span></>}
                        {more > 0 && <span className="flex-none text-onpitch-mute/70">+{more} more</span>}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="px-4 py-6 text-center">
              <div className="font-mono text-[11px] uppercase tracking-wide text-onpitch-mute">No games live right now</div>
              <div className="mt-1 text-xs text-onpitch-mute">{upcoming > 0 ? `${upcoming} coming up later` : "Nothing scheduled"}</div>
            </div>
          )}

          {/* the only navigation — explicit opt-out to the full views (ordered so the first
              link is where the live games actually are) */}
          <div className="flex divide-x divide-white/10 border-t border-white/10">
            {links.map((l) => (
              <Link key={l.href} href={l.href} onClick={() => setOpen(false)} className="flex-1 px-4 py-2.5 text-center font-mono text-[11px] font-bold uppercase tracking-wide text-flood transition-colors hover:bg-white/5">
                {l.label} &rarr;
              </Link>
            ))}
          </div>
        </div>
      )}

      {/* the toggle: dimmed tracker glyph when idle, pulsing "N live" pill when live — tapping only
          opens/closes the peek, it does not navigate */}
      <button
        onClick={() => setOpen((v) => !v)}
        aria-label={isLive ? `${live.length} live game${live.length === 1 ? "" : "s"} — open peek` : "Open games peek"}
        className={
          isLive
            ? "flex items-center gap-2 rounded-full border border-white/10 bg-pitch/95 py-2.5 pl-3 pr-4 shadow-2xl backdrop-blur transition-transform hover:scale-[1.03] active:scale-95"
            : `flex h-11 w-11 items-center justify-center rounded-full border border-white/10 bg-pitch/80 shadow-lg backdrop-blur transition-all active:scale-95 ${open ? "text-chalk opacity-100" : "text-onpitch-mute opacity-60 hover:opacity-100 hover:text-chalk"}`
        }
      >
        {isLive ? (
          <>
            <LivePulse />
            <span className="font-mono text-xs font-bold uppercase tracking-wide text-chalk">{live.length} live</span>
          </>
        ) : (
          <TrackerIcon />
        )}
      </button>
    </div>
  );
}

// tracker glyph for the idle state (mirrors the mobile tab bar's tracker icon)
function TrackerIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="h-5 w-5" aria-hidden="true">
      <rect x="4" y="4" width="16" height="6" rx="2" />
      <rect x="4" y="14" width="16" height="6" rx="2" />
    </svg>
  );
}

// pulsing live indicator (brand accent, not red — red is reserved for a bet that's losing)
function LivePulse() {
  return (
    <span className="relative flex h-2.5 w-2.5 flex-none">
      <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-flood opacity-75 motion-reduce:hidden" />
      <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-flood" />
    </span>
  );
}
