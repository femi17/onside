"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { type TrackedTicket, stateOf, liveTrack, groupOf, SCORE_GRADABLE, scoreGrade } from "@/lib/ticket";
import { useMinuteTick } from "@/lib/useMinuteTick";
import StickyHeader from "@/components/StickyHeader";
import MobileLogo from "@/components/MobileLogo";

type TeamForm5 = { w: number; d: number; l: number; gf: number; ga: number; n: number };
export type PickReasons = {
  home_form: TeamForm5 | null;
  away_form: TeamForm5 | null;
  h2h: { n: number; homeWins: number; draws: number; awayWins: number } | null;
  model: { home: number; draw: number; away: number; over25: number; btts: number } | null;
};

export type AgentPick = TrackedTicket & {
  agent_name: string;
  edge: number | null;
  delivered_at: string | null;
  period?: string | null;
  bet_value?: string | null;
  settle_score?: string | null;
  model_prob?: number | null;
  market_prob?: number | null;
  tier?: string | null;
  reasons?: PickReasons | null;
};

// "Why did the agent pick this" — narrates the REAL signals stored at pick time (each side's last-5
// form + goals, the head-to-head record, the model's probabilities) and how they point to the pick,
// then the edge/confidence. Falls back to the numbers-only explanation for older picks with no
// stored reasons.
function explainPick(p: AgentPick): { title: string; body: string[] } {
  const f = p.fixtures;
  const home = f?.home_team ?? "Home";
  const away = f?.away_team ?? "Away";
  const market = p.market_label ?? p.custom_market ?? "this market";
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  const r = p.reasons;
  const body: string[] = [`${p.agent_name} picked “${market}” in ${home} v ${away}. Here's why:`];

  if (r && (r.home_form || r.away_form || r.h2h || r.model)) {
    const formLine = (name: string, ff: TeamForm5 | null) =>
      ff && ff.n
        ? `${name} — last ${ff.n} games: won ${ff.w}, drew ${ff.d}, lost ${ff.l}. Scored ${ff.gf}, let in ${ff.ga}.`
        : null;
    for (const line of [formLine(home, r.home_form), formLine(away, r.away_form)]) if (line) body.push(line);

    const streak = (name: string, ff: TeamForm5 | null) => {
      if (!ff || !ff.n) return null;
      if (ff.l >= 3) return `${name} are struggling — ${ff.l} losses in their last ${ff.n}.`;
      if (ff.w >= 3) return `${name} are in form — ${ff.w} wins in their last ${ff.n}.`;
      return null;
    };
    for (const line of [streak(home, r.home_form), streak(away, r.away_form)]) if (line) body.push(line);

    if (r.h2h && r.h2h.n) {
      const s = (n: number) => (n === 1 ? "" : "s");
      body.push(`Head-to-head — last ${r.h2h.n} meeting${s(r.h2h.n)}: ${home} won ${r.h2h.homeWins}, ${away} won ${r.h2h.awayWins}, ${r.h2h.draws} draw${s(r.h2h.draws)}. Context only: old meetings between different squads say little, so the model rates the teams on their full recent seasons instead.`);
    }

    // Result-type markets get the 1X2 split (shows who's favoured / opponent strength). Every other
    // market (any goals line, BTTS, handicap, …) gets the model's probability for THAT exact pick,
    // labelled with its real market — never a hardcoded "over 2.5".
    const mk = p.market_key ?? "";
    const resultFam = ["home_win", "away_win", "draw", "result_1x2", "double_chance_1x", "double_chance_x2", "double_chance_12"];
    if (r.model && resultFam.includes(mk)) {
      body.push(`Our computer model's ratings: ${home} ${pct(r.model.home)}, draw ${pct(r.model.draw)}, ${away} ${pct(r.model.away)}.`);
    } else if (p.model_prob != null) {
      body.push(`Our computer model gives “${market}” about a ${pct(p.model_prob)} chance.`);
    } else if (r.model) {
      body.push(`Our computer model's ratings: ${home} ${pct(r.model.home)}, draw ${pct(r.model.draw)}, ${away} ${pct(r.model.away)}.`);
    }
    if (r.model) {
      body.push(`(The rating comes from a full year of each team's results — recent games count most — plus home advantage and how strong their opponents were. That's why a home team can still be favourite when both sides are struggling: it's about who's LESS weak, at home.)`);
    }
  }

  if (p.market_prob != null) body.push(`The bookies' odds say about ${pct(p.market_prob)} (their built-in profit removed, so it's a fair comparison).`);
  if (p.edge != null) {
    // p.edge is ALREADY a percentage here (the page converts the stored fraction once)
    body.push(`So the model sees a better chance than the odds are paying for — about ${p.edge > 0 ? "+" : ""}${p.edge.toFixed(1)}% in your favour.`);
    if (p.model_prob != null && p.market_prob != null && p.model_prob > 0 && p.market_prob > 0) {
      body.push(`In odds terms: the model's fair price for this is ≈${(1 / p.model_prob).toFixed(2)}, while the bookies are paying ≈${(1 / p.market_prob).toFixed(2)}.`);
    }
  } else if (!r) {
    body.push(`No odds were available for this game, so the agent went on its model and your rules alone. Treat this one as lower confidence.`);
  }

  // Confidence tail is graded per pick — no boilerplate; each tier says what THIS grade means,
  // and an implausibly large edge explains why it was marked cautious rather than celebrated.
  if (p.tier === "elite") {
    body.push(`Confidence: 🟢 strong — ${p.edge != null ? `a +${p.edge.toFixed(1)}% edge clears the bar with room to spare` : "clears the bar with room to spare"}.`);
  } else if (p.tier === "strong") {
    body.push(`Confidence: 🟡 solid — a real but modest edge; this grade pays off across many picks rather than any single one.`);
  } else if (p.tier === "wide") {
    body.push(
      p.edge != null && p.edge > 15
        ? `Confidence: 🟠 cautious — the edge looks too big to fully trust. Odds this far from the model usually mean the bookies know something it can't see (line-ups, motivation, a B-team), so it's graded down, not up.`
        : `Confidence: 🟠 thin — a small or uncertain edge; expect bigger swings on picks like this.`,
    );
  } else if (p.model_prob != null) {
    body.push(`Confidence: 🟠 model-only — no odds to check the model against on this one.`);
  }
  return { title: "Why the agent picked this", body };
}

function dayOf(iso: string | null) {
  const now = new Date();
  const wat = (d: Date) => d.toLocaleDateString("en-CA", { timeZone: "Africa/Lagos" });
  if (!iso) return { key: "0000", label: "Earlier" };
  const d = new Date(iso);
  const today = wat(now);
  const yday = wat(new Date(now.getTime() - 86400000));
  const k = wat(d);
  const label = k === today ? "Today" : k === yday ? "Yesterday" : d.toLocaleDateString("en-GB", { timeZone: "Africa/Lagos", weekday: "short", day: "2-digit", month: "short" });
  return { key: k, label };
}

function League({ f }: { f: AgentPick["fixtures"] }) {
  const lg = f?.leagues;
  if (!lg?.name) return null;
  return (
    <span className="flex min-w-0 items-center gap-1 font-mono text-[10px] uppercase tracking-wide text-ink-mute">
      {lg.tier === "uefa" ? (
        <span className="text-[11px] leading-none">🏆</span>
      ) : lg.flag_url ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={lg.flag_url} alt="" className="h-2.5 w-3.5 flex-none rounded-[1px] object-cover" />
      ) : (
        <span className="text-[11px] leading-none">⚽</span>
      )}
      <span className="truncate">{lg.name}</span>
    </span>
  );
}

function Marker({ cat }: { cat: "won" | "lost" | "live" | "pend" }) {
  const map = {
    won: { g: "✓", c: "bg-grass/15 text-grass-deep" },
    lost: { g: "✕", c: "bg-brick/15 text-brick" },
    live: { g: "●", c: "bg-flood/20 text-flood-deep" },
    pend: { g: "◷", c: "bg-ink/[0.07] text-ink-mute" },
  }[cat];
  return <span className={`grid h-[34px] w-[34px] flex-none place-items-center rounded-[9px] font-mono text-[13px] font-bold ${map.c}`}>{map.g}</span>;
}

// compact icons for the card's right-hand control (keeps the row tight on mobile)
function PlusIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" className="h-4 w-4" aria-hidden="true">
      <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  );
}
function CheckIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4" aria-hidden="true">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}
function FlagIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4" aria-hidden="true">
      <path d="M4 21V4h12l-2 3.5L16 11H4" />
    </svg>
  );
}
function XIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" className="h-4 w-4" aria-hidden="true">
      <line x1="6" y1="6" x2="18" y2="18" /><line x1="18" y1="6" x2="6" y2="18" />
    </svg>
  );
}

function Item({
  p,
  nowMs,
  onTrack,
  tracked,
  busy,
  onSettle,
  settling,
  onExplain,
}: {
  p: AgentPick;
  nowMs: number;
  onTrack: (p: AgentPick) => void;
  tracked: boolean;
  busy: boolean;
  onSettle: (id: string, result: "won" | "lost", score?: string) => void;
  settling: boolean;
  onExplain: () => void;
}) {
  const f = p.fixtures;
  const ms = stateOf(p, nowMs);
  const grp = groupOf(p, ms);
  const won = p.status === "won";
  const lost = p.status === "lost";
  const cat = won ? "won" : lost ? "lost" : grp === "live" ? "live" : "pend";
  const settled = won || lost;
  const track = liveTrack(p);
  const market = p.market_label ?? p.custom_market ?? "Tracked market";

  // past kickoff but still not-started: briefly "awaiting feed" (provider catching up), then — well
  // past kickoff with still nothing — "no feed data" (the provider never covered this match)
  const pastKO = !settled && cat !== "live" && !!f?.kickoff_utc && Date.parse(f.kickoff_utc) < nowMs;
  const staleFeed = pastKO && Date.parse(f!.kickoff_utc!) < nowMs - 2.5 * 3600 * 1000;
  const awaitingFeed = pastKO && !staleFeed;

  const [settleOpen, setSettleOpen] = useState(false);
  const [homeStr, setHomeStr] = useState("");
  const [awayStr, setAwayStr] = useState("");
  const canScore = SCORE_GRADABLE.has(p.market_key ?? "");
  const h = Number(homeStr), a = Number(awayStr);
  const scoreValid = homeStr !== "" && awayStr !== "" && Number.isFinite(h) && Number.isFinite(a) && h >= 0 && a >= 0;
  const scored = scoreValid ? scoreGrade(p.market_key ?? null, p.side ?? null, p.line ?? null, h, a) : null;

  // result/status chip — on mobile it stays short (scoreline; the left Marker carries the
  // won/lost/live icon), on desktop it spells the result out ("Landed 2–1"). Frees room for teams.
  const score = ms?.score ?? p.settle_score ?? null;
  const liveMin = ms?.label?.split("·").pop()?.trim() ?? "";
  let chipMobile = "";
  let chipDesktop = "";
  let chipCls = "text-ink-mute";
  if (won) { chipCls = "text-grass-deep"; chipMobile = score ?? "Landed"; chipDesktop = ["Landed", score].filter(Boolean).join(" "); }
  else if (lost) { chipCls = "text-brick"; chipMobile = score ?? "Missed"; chipDesktop = ["Missed", score].filter(Boolean).join(" "); }
  else if (cat === "live") { chipCls = "text-flood-deep"; chipMobile = chipDesktop = [score, liveMin].filter(Boolean).join("  ") || "Live"; }
  else if (awaitingFeed) { chipCls = "text-flood-deep"; chipMobile = chipDesktop = "Awaiting"; }
  else if (staleFeed) { chipMobile = chipDesktop = "No data"; }
  else { chipMobile = chipDesktop = ms?.label ?? "Upcoming"; }

  const settleBtn = "rounded-lg px-2.5 py-1 font-mono text-[10px] font-bold uppercase disabled:opacity-50";

  return (
    <div className="rounded-xl bg-chalk text-ink shadow-lg">
      <div className="flex items-center gap-3 px-3.5 py-3 md:gap-4 md:px-4 md:py-3.5">
        <Marker cat={cat} />
        <div className="min-w-0 flex-1">
          <League f={f} />
          <div className="flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate text-[14.5px] font-bold text-ink">
              {f ? (<>{f.home_team} <span className="font-semibold text-ink-mute">v</span> {f.away_team}</>) : "Match"}
            </span>
            <span className={`flex-none font-mono text-[12px] font-bold tabular-nums ${chipCls}`}>
              <span className="md:hidden">{chipMobile}</span>
              <span className="hidden md:inline">{chipDesktop}</span>
            </span>
          </div>
          <div className="mt-0.5 min-w-0">
            <div className="flex items-center gap-1.5">
              <span className="min-w-0 truncate font-mono text-[11px] text-ink-mute">
                {market}<b className="hidden text-flood-deep md:inline"> · {p.agent_name}</b>{p.edge != null ? ` · ${p.edge > 0 ? "+" : ""}${p.edge}%` : ""}
              </span>
              <button
                onClick={onExplain}
                aria-label="Why the agent picked this"
                title="Why the agent picked this"
                className="grid h-4 w-4 flex-none place-items-center rounded-full border border-ink/15 font-mono text-[10px] font-bold leading-none text-ink-mute transition-colors hover:border-ink/40 hover:text-ink"
              >
                ?
              </button>
            </div>
            {/* on mobile the agent name drops to its own line so it isn't truncated off the row */}
            <div className="truncate font-mono text-[11px] font-bold text-flood-deep md:hidden">{p.agent_name}</div>
          </div>
        </div>
        {/* right control: icon on mobile (keeps the row compact), full-text button on desktop.
            On tracker = green check; addable = outline plus; no feed data = a settle toggle. */}
        {!settled && !staleFeed && f ? (
          tracked ? (
            <span aria-label="On tracker" title="On tracker" className="flex h-9 w-9 flex-none items-center justify-center rounded-lg bg-grass/15 font-mono text-[11px] font-bold text-grass-deep md:h-auto md:w-auto md:px-2.5 md:py-2">
              <span className="md:hidden"><CheckIcon /></span>
              <span className="hidden md:inline">On tracker</span>
            </span>
          ) : (
            <button
              onClick={() => onTrack(p)}
              disabled={busy}
              aria-label="Add to tracker"
              title="Add to tracker"
              className="flex h-9 w-9 flex-none items-center justify-center rounded-lg border border-ink/20 font-mono text-[11px] font-bold text-ink transition-colors hover:border-ink/40 disabled:opacity-50 md:h-auto md:w-auto md:px-2.5 md:py-2"
            >
              <span className="md:hidden"><PlusIcon /></span>
              <span className="hidden md:inline">{busy ? "…" : "+ Track"}</span>
            </button>
          )
        ) : staleFeed ? (
          <button
            onClick={() => setSettleOpen((v) => !v)}
            aria-label="No feed data — settle"
            title="No feed data — settle"
            className={`flex h-9 w-9 flex-none items-center justify-center rounded-lg border font-mono text-[11px] font-bold transition-colors md:h-auto md:w-auto md:px-2.5 md:py-2 ${settleOpen ? "border-ink/40 text-ink" : "border-ink/20 text-ink-mute hover:border-ink/40 hover:text-ink"}`}
          >
            <span className="md:hidden">{settleOpen ? <XIcon /> : <FlagIcon />}</span>
            <span className="hidden md:inline">{settleOpen ? "Close" : "No data · settle"}</span>
          </button>
        ) : null}
      </div>

      {staleFeed && settleOpen && (
        <div className="border-t border-dashed border-ink/15 px-4 py-3">
          {canScore ? (
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-[10px] uppercase tracking-wide text-ink-mute">Final score</span>
              <input type="number" min={0} inputMode="numeric" value={homeStr} onChange={(e) => setHomeStr(e.target.value)} placeholder="H" className="w-12 rounded-lg border border-ink/20 bg-white px-2 py-1 text-center font-mono text-sm text-ink" />
              <span className="font-mono text-ink-mute">–</span>
              <input type="number" min={0} inputMode="numeric" value={awayStr} onChange={(e) => setAwayStr(e.target.value)} placeholder="A" className="w-12 rounded-lg border border-ink/20 bg-white px-2 py-1 text-center font-mono text-sm text-ink" />
              {scoreValid && scored == null ? (
                <>
                  <span className="font-mono text-[10px] text-ink-mute">push/void —</span>
                  <button disabled={settling} onClick={() => onSettle(p.id, "won", `${h}-${a}`)} className={`${settleBtn} bg-grass/20 text-grass-deep`}>Landed</button>
                  <button disabled={settling} onClick={() => onSettle(p.id, "lost", `${h}-${a}`)} className={`${settleBtn} bg-brick/20 text-brick`}>Missed</button>
                </>
              ) : (
                <button
                  disabled={settling || !scored}
                  onClick={() => scored && onSettle(p.id, scored, `${h}-${a}`)}
                  className={`ml-auto ${settleBtn} ${scored === "won" ? "bg-grass/20 text-grass-deep" : scored === "lost" ? "bg-brick/20 text-brick" : "bg-ink/10 text-ink-mute"}`}
                >
                  {scored === "won" ? "Landed ✓" : scored === "lost" ? "Missed ✕" : "Settle"}
                </button>
              )}
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <span className="mr-auto font-mono text-[10px] uppercase tracking-wide text-ink-mute">Mark result</span>
              <button disabled={settling} onClick={() => onSettle(p.id, "won")} className={`${settleBtn} bg-grass/20 text-grass-deep`}>Landed</button>
              <button disabled={settling} onClick={() => onSettle(p.id, "lost")} className={`${settleBtn} bg-brick/20 text-brick`}>Missed</button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export type AgentEmptyRun = { id: string; agent_name: string; ran_at: string };

export default function AgentBoard({ picks, userId, initialTracked = [], emptyRuns = [] }: { picks: AgentPick[]; userId: string; initialTracked?: string[]; emptyRuns?: AgentEmptyRun[] }) {
  const nowMs = useMinuteTick();
  const supabase = createClient();
  const router = useRouter();
  const [agent, setAgent] = useState<string | null>(null);
  const [tracked, setTracked] = useState<Set<string>>(() => new Set(initialTracked));
  const [busyId, setBusyId] = useState<string | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [settlingId, setSettlingId] = useState<string | null>(null);
  const [explain, setExplain] = useState<AgentPick | null>(null); // which pick's "why" modal is open

  // settle a no-data delivery (provider never covered the game) so it stops showing "no feed data".
  // Goes through an RPC that only flips result + stores the entered score for the caller's own
  // pending delivery.
  async function settleDelivery(id: string, result: "won" | "lost", score?: string) {
    setSettlingId(id);
    const { error } = await supabase.rpc("settle_delivery", { p_id: id, p_result: result, p_score: score ?? null });
    setSettlingId(null);
    if (error) {
      // surface it instead of silently doing nothing
      if (typeof window !== "undefined") window.alert(`Couldn't settle this pick: ${error.message}`);
      return;
    }
    router.refresh();
  }

  // merge in server-known tracked picks after a refresh (e.g. realtime), keeping session adds
  const initKey = initialTracked.join(",");
  useEffect(() => {
    setTracked((prev) => {
      const next = new Set(prev);
      initialTracked.forEach((id) => next.add(id));
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initKey]);

  const fixtureId = (p: AgentPick) => (p.fixtures as { id?: number } | null)?.id ?? null;
  const isTrackable = (p: AgentPick) => p.status !== "won" && p.status !== "lost" && !!fixtureId(p) && !tracked.has(p.id);
  const dupKey = (fx: number, mk: string | null | undefined, side: string | null | undefined) => `${fx}:${mk ?? ""}:${side ?? ""}`;
  const ticketRow = (p: AgentPick, fx: number) => ({
    user_id: userId, accumulator_id: null, fixture_id: fx,
    market_key: p.market_key, market_label: p.market_label, custom_market: p.custom_market,
    line: p.line, side: p.side, period: p.period ?? "ft", bet_value: p.bet_value ?? null,
    source: "agent", status: "pending",
  });

  // copy one agent pick onto the user's own tracker as a standalone bet (de-duped so tapping twice —
  // or an existing manual bet — won't double up)
  async function addToTracker(p: AgentPick) {
    const fx = fixtureId(p);
    if (!fx || tracked.has(p.id)) return;
    setBusyId(p.id);
    const { data: existing } = await supabase
      .from("tickets").select("id")
      .eq("user_id", userId).eq("fixture_id", fx).eq("market_key", p.market_key).eq("side", p.side ?? "")
      .in("status", ["pending", "live"]).limit(1);
    if (!existing?.length) await supabase.from("tickets").insert(ticketRow(p, fx));
    setTracked((s) => new Set(s).add(p.id));
    setBusyId(null);
  }

  // add every still-trackable pick in the current view at once, de-duped in a single query
  async function addAllToTracker(list: AgentPick[]) {
    const candidates = list.filter(isTrackable);
    if (!candidates.length) return;
    setBulkBusy(true);
    const fxIds = Array.from(new Set(candidates.map((p) => fixtureId(p)!)));
    const { data: existing } = await supabase
      .from("tickets").select("fixture_id, market_key, side")
      .eq("user_id", userId).in("status", ["pending", "live"]).in("fixture_id", fxIds);
    const taken = new Set((existing ?? []).map((r) => dupKey(r.fixture_id as number, r.market_key as string, r.side as string)));
    const rows = candidates
      .filter((p) => !taken.has(dupKey(fixtureId(p)!, p.market_key, p.side)))
      .map((p) => ticketRow(p, fixtureId(p)!));
    if (rows.length) await supabase.from("tickets").insert(rows);
    setTracked((s) => { const n = new Set(s); candidates.forEach((p) => n.add(p.id)); return n; });
    setBulkBusy(false);
  }

  const agents = useMemo(() => Array.from(new Set(picks.map((p) => p.agent_name))), [picks]);
  const filtered = agent ? picks.filter((p) => p.agent_name === agent) : picks;
  const emptyForView = agent ? emptyRuns.filter((e) => e.agent_name === agent) : emptyRuns;

  // stable ordering: within each day, sort by match kickoff time (chronological), with deterministic
  // tiebreakers (delivery time, then id) so a card never jumps when a pick settles or the feed refreshes.
  const koMs = (p: AgentPick) => {
    const k = (p.fixtures as { kickoff_utc?: string | null } | null)?.kickoff_utc;
    const t = k ? Date.parse(k) : NaN;
    return Number.isNaN(t) ? Number.POSITIVE_INFINITY : t;
  };
  const orderInDay = (a: AgentPick, b: AgentPick) =>
    koMs(a) - koMs(b) ||
    (a.delivered_at ?? "").localeCompare(b.delivered_at ?? "") ||
    a.id.localeCompare(b.id);

  const days = useMemo(() => {
    const map = new Map<string, { label: string; items: AgentPick[] }>();
    for (const p of filtered) {
      const { key, label } = dayOf(p.delivered_at);
      if (!map.has(key)) map.set(key, { label, items: [] });
      map.get(key)!.items.push(p);
    }
    const entries = Array.from(map.entries());
    entries.forEach(([, day]) => day.items.sort(orderInDay));
    return entries.sort((a, b) => b[0].localeCompare(a[0]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filtered]);

  return (
    <div>
      {/* fixed header on every width; transparent at rest, fills in only when scrolled */}
      <StickyHeader>
        <div className="mx-auto max-w-3xl px-5 pb-3 pt-6 md:px-8">
          <MobileLogo />
          <div className="flex items-end justify-between gap-3">
            <div>
              <p className="font-mono text-[11px] uppercase tracking-[0.25em] text-flood">Everything your agents sent</p>
              <h1 className="mt-2 font-disp text-3xl font-bold tracking-tight text-chalk sm:text-4xl">
                Agent <span className="text-onpitch-mute">feed.</span>
              </h1>
            </div>
            {/* new agent: compact icon on mobile, full-text button on desktop */}
            <Link
              href="/strategies/new"
              aria-label="New agent"
              title="New agent"
              className="flex h-11 w-11 flex-none items-center justify-center rounded-xl bg-flood font-bold text-ink shadow-lg transition-transform hover:-translate-y-0.5 md:h-auto md:w-auto md:px-4 md:py-3"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" className="h-5 w-5 md:hidden" aria-hidden="true">
                <line x1="12" y1="5" x2="12" y2="19" />
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
              <span className="hidden md:inline">+ New agent</span>
            </Link>
          </div>
        </div>
      </StickyHeader>
      <div className="mx-auto max-w-3xl px-5 pb-10 pt-2 md:px-8">

      {picks.length === 0 && emptyRuns.length === 0 ? (
        <div className="mt-10 rounded-2xl border border-dashed border-ink/15 bg-chalk p-12 text-center shadow-xl">
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-flood/15 font-mono text-xl text-flood-deep">◆</div>
          <h2 className="font-disp text-xl font-bold text-ink">No agents running yet.</h2>
          <p className="mx-auto mt-2 max-w-sm text-sm text-ink-mute">
            Agents scan the day&apos;s fixtures and deliver picks that match your strategy — straight to this feed. Build one to start.
          </p>
          <Link href="/strategies/new" className="mt-5 inline-block rounded-xl bg-flood px-5 py-3 font-bold text-ink">
            Build your first agent
          </Link>
        </div>
      ) : (
        <>
          {agents.length > 1 && (
            <div className="mt-6 flex flex-wrap gap-2">
              <Chip on={agent === null} onClick={() => setAgent(null)}>All agents</Chip>
              {agents.map((a) => (
                <Chip key={a} on={agent === a} onClick={() => setAgent(a)}>{a}</Chip>
              ))}
            </div>
          )}
          {/* in-app "no games" note — mirrors the Telegram note so a run that found nothing reads
              as "ran, nothing cleared" instead of just an empty feed */}
          {emptyForView.length > 0 && (
            <div className="mt-5 flex flex-col gap-2">
              {emptyForView.map((e) => (
                <div key={e.id} className="flex items-center gap-3 rounded-xl border border-dashed border-ink/15 bg-chalk px-4 py-3 text-ink shadow-lg">
                  <span className="grid h-[34px] w-[34px] flex-none place-items-center rounded-[9px] bg-ink/[0.06] font-mono text-[13px] text-ink-mute">◷</span>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[14px] font-bold text-ink">{e.agent_name}</div>
                    <div className="mt-0.5 font-mono text-[11px] text-ink-mute">Ran today — no games cleared your criteria. It&apos;ll look again next run.</div>
                  </div>
                </div>
              ))}
            </div>
          )}
          {/* bulk action — add every still-trackable pick in view at once */}
          {filtered.some(isTrackable) && (
            <div className="mt-5 flex items-center justify-between gap-3 rounded-xl border border-dashed border-ink/15 bg-chalk px-4 py-3 text-ink shadow-lg">
              <span className="min-w-0 text-[13px] text-ink-mute">Put {agent ? "this agent's" : "these"} picks on your tracker in one go.</span>
              <button
                onClick={() => addAllToTracker(filtered)}
                disabled={bulkBusy}
                className="flex-none rounded-lg bg-flood px-3.5 py-2 font-mono text-[12px] font-bold text-ink transition-transform hover:-translate-y-0.5 disabled:opacity-50"
              >
                {bulkBusy ? "Adding…" : `+ Track all (${filtered.filter(isTrackable).length})`}
              </button>
            </div>
          )}
          <div className="mt-6 flex flex-col gap-7">
            {days.map(([key, day]) => (
              <section key={key}>
                <div className="mb-2.5 font-mono text-[11px] font-bold uppercase tracking-[0.15em] text-onpitch-mute">
                  {day.label} · {day.items.length}
                </div>
                <div className="flex flex-col gap-2">
                  {day.items.map((p) => (
                    <Item key={p.id} p={p} nowMs={nowMs} onTrack={addToTracker} tracked={tracked.has(p.id)} busy={busyId === p.id} onSettle={settleDelivery} settling={settlingId === p.id} onExplain={() => setExplain(p)} />
                  ))}
                </div>
              </section>
            ))}
          </div>
        </>
      )}
      </div>

      {/* per-pick explainer: how the agent reached this decision */}
      {explain && (
        <div className="fixed inset-0 z-[70] flex items-end justify-center sm:items-center sm:p-4">
          <div onClick={() => setExplain(null)} className="absolute inset-0 bg-ink/60" />
          <div role="dialog" aria-modal="true" aria-label="Why the agent picked this" className="relative w-full max-w-md rounded-t-2xl bg-chalk p-5 text-ink shadow-2xl sm:rounded-2xl">
            <div className="flex items-start justify-between gap-3">
              <h3 className="font-disp text-lg font-extrabold text-ink">{explainPick(explain).title}</h3>
              <button onClick={() => setExplain(null)} aria-label="Close" className="grid h-8 w-8 flex-none place-items-center rounded-lg bg-ink/5 font-mono text-lg text-ink-mute transition-colors hover:text-ink">×</button>
            </div>
            <div className="mt-3 flex flex-col gap-2.5">
              {explainPick(explain).body.map((line, i) => (
                <p key={i} className="text-[13.5px] leading-relaxed text-ink-mute">{line}</p>
              ))}
            </div>
            <button onClick={() => setExplain(null)} className="mt-4 w-full rounded-xl bg-flood py-2.5 font-bold text-ink">Got it</button>
          </div>
        </div>
      )}
    </div>
  );
}

function Chip({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`rounded-full border px-3.5 py-2 font-mono text-[11.5px] tracking-wide transition-colors ${
        on ? "border-flood bg-flood text-ink" : "border-white/15 text-onpitch-mute hover:border-white/30"
      }`}
    >
      {children}
    </button>
  );
}
