"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { useMinuteTick } from "@/lib/useMinuteTick";
import { usePulse } from "@/lib/usePulse";
import StickyHeader from "@/components/StickyHeader";
import MobileLogo from "@/components/MobileLogo";
import { useConfirm } from "@/components/ConfirmDialog";
import {
  type TrackedTicket,
  type Group,
  oneStat,
  stateOf,
  eventMinute,
  betSignal,
  type Signal,
  type GoalEvent,
  groupOf,
  liveTrack,
  teamCode,
  backedSide,
  resultStanding,
  goalRuns,
  goalRunsFor,
  leadStats,
  cardTally,
  firstCardSide,
  ticketDate,
  SCORE_GRADABLE,
  scoreGrade,
} from "@/lib/ticket";

export type Ticket = TrackedTicket;

// past this many live games, the bright-card treatment stops being a signal,
// so we switch live to a tighter, glanceable layout.
const LIVE_COMPACT_AT = 6;

function League({ f }: { f: Ticket["fixtures"] }) {
  const lg = f?.leagues;
  return (
    <div className="flex min-w-0 items-center gap-1.5 font-mono text-[10.5px] uppercase tracking-wide text-ink-mute">
      {/* UEFA competitions get the cup; domestic leagues show their country flag */}
      {lg?.tier === "uefa" ? (
        <span className="text-sm leading-none">🏆</span>
      ) : lg?.flag_url ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={lg.flag_url} alt="" className="h-3 w-4 flex-none rounded-[2px] object-cover" />
      ) : (
        <span className="text-sm leading-none">⚽</span>
      )}
      <span className="truncate">{lg?.name ?? ""}</span>
    </div>
  );
}

// remove-from-tracker (×) — every card carries it
function RemoveBtn({ id, busy, onRemove }: { id: string; busy: boolean; onRemove: (id: string) => void }) {
  return (
    <button
      disabled={busy}
      onClick={() => onRemove(id)}
      aria-label="Remove from tracker"
      title="Remove from tracker"
      className="grid h-6 w-6 flex-none place-items-center rounded-md text-ink-mute transition-colors hover:bg-brick/10 hover:text-brick disabled:opacity-40"
    >
      ×
    </button>
  );
}

// live traffic light for the bet: green on course, amber in the balance, red off course.
// This is the one place hue carries meaning (bet state), and it changes as the score moves.
function TrafficDot({ signal }: { signal: Signal | null }) {
  if (!signal) return null;
  const color = signal === "green" ? "#2FA84F" : signal === "yellow" ? "#E0A81E" : "#D0432B";
  const label = signal === "green" ? "On course" : signal === "yellow" ? "In the balance" : "Off course";
  return <span className="h-2.5 w-2.5 flex-none rounded-full" style={{ background: color }} title={label} aria-label={label} />;
}

// One colourless convention for "which team": home is a filled ink dot, away a hollow
// ring. It's introduced beside the team names (a self-evident legend) and then reused on
// every event marker — goals, tally, scoreline — so attribution reads at a glance without
// a palette of hues. Match STATE (win/lose progress) uses the traffic light above.
function SideDot({ side, className = "" }: { side: "home" | "away"; className?: string }) {
  return (
    <span
      aria-hidden
      className={`inline-block h-2.5 w-2.5 flex-none rounded-full ${
        side === "home" ? "bg-ink" : "border-[1.5px] border-ink"
      } ${className}`}
    />
  );
}

// the fixture's two teams, always on one line; the home/away dot beside each name doubles
// as the legend for the event markers below. Long names ellipsize (each shrinks as needed)
// rather than wrapping, so the card keeps a stable one-line header.
function Teams({ f, size }: { f: Ticket["fixtures"]; size: "lg" | "sm" }) {
  if (!f) return <>Match</>;
  const cls =
    size === "lg"
      ? "font-disp font-bold leading-tight text-ink"
      : "font-disp font-bold leading-tight text-[15px] text-ink";
  return (
    <div className={`flex min-w-0 items-center gap-x-1.5 ${cls}`}>
      <SideDot side="home" />
      <span className="min-w-0 truncate" title={f.home_team}>{f.home_team}</span>
      <span className="flex-none text-base font-semibold text-ink-mute">v</span>
      <SideDot side="away" />
      <span className="min-w-0 truncate" title={f.away_team}>{f.away_team}</span>
    </div>
  );
}

// a single team's goal tally, sized by whether the user backed it (T5); the side dot marks
// whose goals these are, ink for the backed side and muted otherwise
function Tally({ n, side, big, compact, bonus }: { n: number; side: "home" | "away"; big: boolean; compact?: boolean; bonus?: number }) {
  const size = big ? (compact ? 34 : 46) : compact ? 18 : 22;
  const dot = <SideDot side={side} className="mb-1" />;
  // handicap line as a raise-to-power exponent at the TOP-outer edge; the sign faces the
  // scoreline (home reads 1⁺0 / 1·5⁻0, away reads 0⁺1 / 0⁻·5) — small and black
  const supText =
    bonus != null
      ? side === "home"
        ? `${Math.abs(bonus)}${bonus < 0 ? "-" : "+"}`
        : `${bonus < 0 ? "-" : "+"}${Math.abs(bonus)}`
      : null;
  const sup = supText != null ? (
    <span className="align-top font-bold text-ink" style={{ fontSize: "9px" }}>{supText}</span>
  ) : null;
  const num = (
    <span className={`font-mono font-bold tabular-nums leading-none ${big ? "text-ink" : "text-ink-mute"}`} style={{ fontSize: size }}>
      {side === "home" && sup}{n}{side === "away" && sup}
    </span>
  );
  // home marker leads, away marker trails — so a scoreline reads [home] n : n [away]
  return (
    <span className="inline-flex items-end gap-1.5 leading-none">
      {side === "home" ? <>{dot}{num}</> : <>{num}{dot}</>}
    </span>
  );
}

// the live blinking "counting" pulse — reassures the clock isn't stuck (T3)
function LiveClock({ label }: { label: string }) {
  return (
    <span className="flex flex-none items-center gap-1.5 font-mono text-xs font-bold text-flood-deep">
      <span className="h-1.5 w-1.5 rounded-full bg-flood-deep animate-blink motion-reduce:animate-none" />
      {label}
    </span>
  );
}

// Events as a matchday scoresheet: home on the left, away on the right — split like the
// scoreline. Every entry stays visible in bounded height (rows = events for the busier side),
// column side attributes the team; a goal shows the home/away dot, a card its own colour.
const isCard = (e: GoalEvent) => e.kind === "yellow" || e.kind === "red";
function EventLine({ e, side }: { e: GoalEvent; side: "home" | "away" }) {
  const card = isCard(e);
  const suffix = e.kind === "pen" ? " (P)" : e.kind === "og" ? " (OG)" : "";
  return (
    <li className={`flex w-full min-w-0 items-center gap-1.5 ${side === "away" ? "flex-row-reverse" : ""}`} title={e.player ?? undefined}>
      {card ? (
        <span className="h-3 w-[9px] flex-none rounded-[1.5px]" style={{ background: e.kind === "red" ? "#C0392B" : "#E8B22E" }} />
      ) : (
        <SideDot side={side} className="!h-1.5 !w-1.5" />
      )}
      <span className="min-w-0 truncate text-ink">{e.player ?? (card ? "Booking" : "Goal")}</span>
      <span className="flex-none font-medium text-ink-mute">{eventMinute(e)}{suffix}</span>
    </li>
  );
}
function EventSheet({ label, events, compact }: { label: string; events: GoalEvent[]; compact?: boolean }) {
  const home = events.filter((e) => e.side === "home");
  const away = events.filter((e) => e.side === "away");
  return (
    <div className={compact ? "mt-3" : "mt-4"}>
      <div className="mb-1.5 flex items-center gap-2">
        <span className="flex-none font-mono text-[10px] uppercase tracking-wide text-ink-mute">{label}</span>
        <span className="h-px flex-1 bg-ink/10" />
      </div>
      <div className="flex items-start gap-3 font-mono text-[10.5px] font-bold">
        <ul className="flex min-w-0 flex-1 flex-col gap-1">
          {home.map((e, i) => <EventLine key={i} e={e} side="home" />)}
        </ul>
        <span className="w-px self-stretch bg-ink/10" />
        <ul className="flex min-w-0 flex-1 flex-col items-end gap-1 text-right">
          {away.map((e, i) => <EventLine key={i} e={e} side="away" />)}
        </ul>
      </div>
    </div>
  );
}

// A count-type stat (corners now; shots, cards-count later) laid out exactly like the goal/card
// scoresheet: a label + rule, then a home | away split with the vertical divider between the two
// teams. Same dot attribution as the event sheets (home left, away right) — a tally, not a list.
function StatSplit({ label, home, away, compact }: { label: string; home: number; away: number; compact?: boolean }) {
  return (
    <div className={compact ? "mt-3" : "mt-4"}>
      <div className="mb-1.5 flex items-center gap-2">
        <span className="flex-none font-mono text-[10px] uppercase tracking-wide text-ink-mute">{label}</span>
        <span className="h-px flex-1 bg-ink/10" />
      </div>
      <div className="flex items-stretch gap-3 font-mono text-[10.5px] font-bold text-ink">
        <div className="flex min-w-0 flex-1 items-center gap-1.5">
          <SideDot side="home" className="!h-1.5 !w-1.5" />{home}
        </div>
        <span className="w-px self-stretch bg-ink/10" />
        <div className="flex min-w-0 flex-1 items-center justify-end gap-1.5 text-right">
          {away}<SideDot side="away" className="!h-1.5 !w-1.5" />
        </div>
      </div>
    </div>
  );
}

/* stuck / free-text bets: goal-based markets settle from the final score the user enters (the app
   grades it); everything else (or a push) falls back to a plain Landed / Missed pick */
function ManualSettle({
  t,
  busy,
  onSettle,
}: {
  t: Ticket;
  busy: boolean;
  onSettle: (id: string, result: "won" | "lost" | "void") => void;
}) {
  const [homeStr, setHomeStr] = useState("");
  const [awayStr, setAwayStr] = useState("");
  const fromScore = SCORE_GRADABLE.has(t.market_key ?? "");

  if (fromScore) {
    const h = Number(homeStr), a = Number(awayStr);
    const valid = homeStr !== "" && awayStr !== "" && Number.isFinite(h) && Number.isFinite(a) && h >= 0 && a >= 0;
    const result = valid ? scoreGrade(t.market_key ?? null, t.side ?? null, t.line ?? null, h, a) : null;
    return (
      <div className="mt-3 border-t border-dashed border-ink/15 pt-3">
        <div className="mb-1.5 font-mono text-[10px] uppercase tracking-wide text-ink-mute">Enter the final score to settle</div>
        <div className="flex items-center gap-2">
          <input type="number" min={0} inputMode="numeric" value={homeStr} onChange={(e) => setHomeStr(e.target.value)} placeholder="H" className="w-14 rounded-lg border border-ink/20 bg-white px-2 py-1.5 text-center font-mono text-sm text-ink" />
          <span className="font-mono text-ink-mute">–</span>
          <input type="number" min={0} inputMode="numeric" value={awayStr} onChange={(e) => setAwayStr(e.target.value)} placeholder="A" className="w-14 rounded-lg border border-ink/20 bg-white px-2 py-1.5 text-center font-mono text-sm text-ink" />
          <button
            disabled={busy || !valid || result == null}
            onClick={() => result && onSettle(t.id, result)}
            className={`ml-auto rounded-lg px-3 py-1.5 font-mono text-[11px] font-bold uppercase transition-colors disabled:opacity-40 ${
              result === "won" ? "bg-grass/20 text-grass-deep hover:bg-grass/30" : result === "lost" ? "bg-brick/20 text-brick hover:bg-brick/30" : "bg-ink/10 text-ink-mute"
            }`}
          >
            {result === "won" ? "Landed ✓" : result === "lost" ? "Missed ✕" : "Settle"}
          </button>
        </div>
        {/* game didn't happen (postponed/abandoned)? void it — no score needed */}
        <button
          disabled={busy}
          onClick={() => onSettle(t.id, "void")}
          className="mt-2 font-mono text-[10.5px] font-bold uppercase tracking-wide text-ink-mute underline decoration-ink/30 underline-offset-2 transition-colors hover:text-ink disabled:opacity-50"
        >
          Game off? Void it
        </button>
        {valid && result == null && (
          <div className="mt-2 flex items-center gap-2">
            <span className="mr-auto font-mono text-[10.5px] text-ink-mute">Push / void for this market — mark it:</span>
            <button disabled={busy} onClick={() => onSettle(t.id, "won")} className="rounded-lg bg-grass/20 px-2.5 py-1 font-mono text-[10px] font-bold uppercase text-grass-deep disabled:opacity-50">Landed</button>
            <button disabled={busy} onClick={() => onSettle(t.id, "lost")} className="rounded-lg bg-brick/20 px-2.5 py-1 font-mono text-[10px] font-bold uppercase text-brick disabled:opacity-50">Missed</button>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="mt-3 flex items-center gap-2 border-t border-dashed border-ink/15 pt-3">
      <span className="mr-auto font-mono text-[10px] uppercase tracking-wide text-ink-mute">Mark result</span>
      <button
        disabled={busy}
        onClick={() => onSettle(t.id, "won")}
        className="rounded-lg bg-grass/20 px-2.5 py-1 font-mono text-[10px] font-bold uppercase text-grass-deep transition-colors hover:bg-grass/30 disabled:opacity-50"
      >
        Landed
      </button>
      <button
        disabled={busy}
        onClick={() => onSettle(t.id, "lost")}
        className="rounded-lg bg-brick/20 px-2.5 py-1 font-mono text-[10px] font-bold uppercase text-brick transition-colors hover:bg-brick/30 disabled:opacity-50"
      >
        Missed
      </button>
      {/* postponed / abandoned → void (stake back, leg drops out of an acca) */}
      <button
        disabled={busy}
        onClick={() => onSettle(t.id, "void")}
        title="Game off (postponed/abandoned) — void it"
        className="rounded-lg bg-ink/10 px-2.5 py-1 font-mono text-[10px] font-bold uppercase text-ink-mute transition-colors hover:bg-ink/20 disabled:opacity-50"
      >
        Void
      </button>
    </div>
  );
}

/* ---- one card, styled by group so hierarchy reads at a glance ---- */
function Card({
  t,
  compact,
  busy,
  onSettle,
  onRemove,
  nowMs,
}: {
  t: Ticket;
  compact?: boolean;
  busy: boolean;
  onSettle: (id: string, result: "won" | "lost" | "void") => void;
  onRemove: (id: string) => void;
  nowMs?: number;
}) {
  const f = t.fixtures;
  const ms = stateOf(t, nowMs);
  const group = groupOf(t, ms);
  const mk = t.market_key ?? "";
  // bookings-family bets redraw (and pop) on a new card, not just on score/current_value moves
  const isCardsFamily = mk.includes("cards") || mk === "booking_points_ou" || mk === "first_booking";
  const cardsPulseN = isCardsFamily
    ? ((f?.events ?? []) as GoalEvent[]).filter((e) => e.kind === "yellow" || e.kind === "red").length
    : "";
  const pulse = usePulse(`${t.current_value ?? ""}|${ms?.score ?? ""}|${cardsPulseN}`);
  const marketName = t.market_label ?? t.custom_market ?? "Tracked market";
  // Yes/No markets (GG 2+, N in a row, lead by N…): show the pick as a pill so it's unmistakable
  // (the "— No" in the label truncates, and the see-saw looks the same for Yes and No)
  const yesNoPick: "yes" | "no" | null = t.side === "yes" || t.side === "no" ? t.side : null;
  const shownMarket = yesNoPick ? marketName.replace(/\s*—\s*(yes|no)\s*$/i, "") : marketName;
  const backed = backedSide(t.market_key, t.side);
  const homeBig = backed !== "away"; // particular about home when it's ambiguous
  const hg = f?.home_goals ?? 0;
  const ag = f?.away_goals ?? 0;
  // 1X2-family live verdict — "on course / not yet" against the 90-minute result
  const standing = resultStanding(t.market_key, t.side, hg, ag);
  // BTTS (and GG/NG 2+) read as a scoreline (both teams matter equally), not a backed side
  const isBtts = t.market_key === "btts";
  const isBtts2 = t.market_key === "btts_2plus"; // both teams to score 2+
  // handicap exponent on the score: European = head-start "H:A" on the advantaged team;
  // Asian = the signed ± line on the picked team
  const hcap = t.market_key === "handicap_eu" ? (t.bet_value ?? "").match(/(\d+)\s*:\s*(\d+)/) : null;
  let homeBonus = hcap && Number(hcap[1]) > 0 ? Number(hcap[1]) : undefined;
  let awayBonus = hcap && Number(hcap[2]) > 0 ? Number(hcap[2]) : undefined;
  if ((t.market_key === "handicap" || t.market_key === "cards_handicap") && t.line != null) {
    if (t.side === "home") homeBonus = t.line;
    else if (t.side === "away") awayBonus = t.line;
  }
  // bookings markets with no line track (1X2 / handicap / 1st booking): the big figures are the
  // live CARD COUNTS (YC=1, RC=2 — as settlement counts them), never the goal scoreline
  const isCardsScore = mk === "cards_1x2" || mk === "cards_handicap" || mk === "first_booking";
  const cardsH = isCardsScore ? cardTally(t, "home") : 0;
  const cardsA = isCardsScore ? cardTally(t, "away") : 0;
  const firstCard = mk === "first_booking" ? firstCardSide(t) : null;
  // which side reads big: the picked side; draw/none weighs both equally
  const cardsBigH = isCardsScore && t.side !== "away";
  const cardsBigA = isCardsScore && t.side !== "home";
  const cardsReadout = !isCardsScore
    ? null
    : mk === "cards_1x2"
      ? { top: "most bookings", bottom: t.side === "draw" ? "backing level" : `backing ${(t.side === "home" ? f?.home_team : f?.away_team) ?? ""}` }
      : mk === "cards_handicap"
        ? { top: "bookings", bottom: `backing ${(t.side === "home" ? f?.home_team : f?.away_team) ?? ""}` }
        : firstCard
          ? { top: "1st booking", bottom: (firstCard === "home" ? f?.home_team : f?.away_team) ?? "" }
          : { top: "1st booking?", bottom: t.side === "none" ? "backing no card" : `backing ${(t.side === "home" ? f?.home_team : f?.away_team) ?? ""}` };
  // stats the live feed doesn't carry (shots / SOT / fouls / offsides): no goal scoreline —
  // an honest placeholder; the settlement engine grades them from full-time match stats
  const isStatNoFeed = /(?:^|_)(shots|sot|fouls|offsides)_(?:ou|1x2)$/.test(mk);
  // live traffic-light status for the whole bet (green/amber/red), updates as the score moves
  const signal = betSignal(t, hg, ag);
  // draw / double-chance-12 are about the balance, not a side — a see-saw: the leader rises
  // (big), the trailing side drops (small); level = both up.
  const isSeesaw = t.market_key === "draw" || t.market_key === "double_chance_12";
  const level = hg === ag;
  const seesaw = isSeesaw
    ? t.market_key === "draw"
      ? level
        ? { top: "Draw", bottom: "" }
        : { top: (hg < ag ? f?.home_team : f?.away_team) ?? "", bottom: "to level up" }
      : level
        ? { top: "Home or away", bottom: "needs a winner" }
        : { top: "Home or away", bottom: "" }
    : null;
  // "N goals in a row" markets — a see-saw driven by the consecutive-goal run. ANY-team: the
  // current run holder rises (trolly). HOME/AWAY-team: that team is fixed big, readout tracks
  // only their run. level / no run = both up.
  const runTeam: "home" | "away" | null =
    t.market_key?.startsWith("home_goals_in_row") ? "home" : t.market_key?.startsWith("away_goals_in_row") ? "away" : null;
  const isRunStreak = t.market_key === "goals_in_row_2" || t.market_key === "goals_in_row_3" || runTeam != null;
  const runNeed = t.market_key?.endsWith("3") ? 3 : 2;
  const anyRuns = isRunStreak && runTeam == null ? goalRuns(t) : null;
  const teamRuns = isRunStreak && runTeam ? goalRunsFor(t, runTeam) : null;
  const runHomeUp = runTeam === "home" ? true : runTeam === "away" ? false : !anyRuns?.curTeam || anyRuns.curTeam === "home";
  const runAwayUp = runTeam === "away" ? true : runTeam === "home" ? false : !anyRuns?.curTeam || anyRuns.curTeam === "away";
  const runMax = teamRuns ? teamRuns.maxRun : anyRuns?.maxRun ?? 0;
  const runCur = teamRuns ? teamRuns.curRun : anyRuns?.curRun ?? 0;
  const runLabelTeam = runTeam
    ? (runTeam === "home" ? f?.home_team : f?.away_team)
    : anyRuns?.curTeam
      ? anyRuns.curTeam === "home"
        ? f?.home_team
        : f?.away_team
      : null;
  const runReadout = isRunStreak
    ? runMax >= runNeed
      ? { top: `${runNeed} in a row`, bottom: "done" }
      : runCur >= 1 && runLabelTeam
        ? {
            top: `${runLabelTeam} ×${runCur}`,
            bottom: runNeed - runCur === 1 ? "1 more in a row" : `${runNeed - runCur} more in a row`,
          }
        : { top: `${runNeed} in a row?`, bottom: runTeam ? runLabelTeam ?? "" : "any team" }
    : null;
  // "lead by N goals at any time" — a see-saw on the biggest lead reached. ANY-team: the current
  // leader rises (big), the other drops. HOME/AWAY-team: that team is fixed big and the readout
  // tracks only their signed lead. level (0-0/draw) = both up. Locks Yes once the lead hits N.
  const leadTeam: "home" | "away" | null =
    t.market_key?.startsWith("home_lead_by") ? "home" : t.market_key?.startsWith("away_lead_by") ? "away" : null;
  const isLeadBy =
    t.market_key === "lead_by_1" || t.market_key === "lead_by_2" || t.market_key === "lead_by_3" || leadTeam != null;
  const leadNeed = t.market_key?.endsWith("3") ? 3 : t.market_key?.endsWith("2") ? 2 : 1;
  const lead = isLeadBy ? leadStats(t, leadTeam ?? undefined) : null;
  const leadHomeUp = leadTeam === "home" ? true : leadTeam === "away" ? false : !lead?.leader || lead.leader === "home";
  const leadAwayUp = leadTeam === "away" ? true : leadTeam === "home" ? false : !lead?.leader || lead.leader === "away";
  // readout perspective: team markets name that team; any-team names the current leader
  const leadName = leadTeam
    ? (leadTeam === "home" ? f?.home_team : f?.away_team)
    : lead?.leader
      ? lead.leader === "home"
        ? f?.home_team
        : f?.away_team
      : null;
  const leadShowing = leadTeam ? (lead?.curLead ?? 0) >= 1 : !!lead?.leader && (lead?.curLead ?? 0) >= 1;
  const leadReadout = lead
    ? lead.maxLead >= leadNeed
      ? { top: `led by ${leadNeed}`, bottom: "done" }
      : leadShowing && leadName
        ? { top: `${leadName} +${lead.curLead}`, bottom: leadNeed - lead.curLead === 1 ? `1 more to +${leadNeed}` : `${leadNeed - lead.curLead} more` }
        : { top: `lead by ${leadNeed}?`, bottom: leadTeam ? leadName ?? "" : "either team" }
    : null;
  // the goal/card breakdown stays folded so the card is short; the user draws it out on tap
  const [showEvents, setShowEvents] = useState(false);
  // custom (free-text) bets the engine can't grade get manual controls until resolved
  const needsManual = t.market_key === "custom" && t.status !== "won" && t.status !== "lost" && t.status !== "void";
  // a game long past kickoff with no live/finished status = the data provider isn't
  // covering it — let the user settle it themselves instead of waiting forever
  const overdue = !!f?.kickoff_utc && Date.parse(f.kickoff_utc) < (nowMs ?? Date.now()) - 2.5 * 3600 * 1000;
  const stuck = group === "upcoming" && overdue && (t.status === "pending" || t.status === "live");
  const showManual = needsManual || stuck;
  // past kickoff but the feed still says not-started — we're waiting on the data provider to flip it live
  const awaitingFeed = group === "upcoming" && !stuck && !!f?.kickoff_utc && Date.parse(f.kickoff_utc) < (nowMs ?? Date.now());

  // LIVE + SETTLED — the same full betslip ticket (with the events drawer); a settled card just
  // swaps the live clock for a Landed/Missed badge and drops the live-only momentum meter.
  if (group === "live" || group === "settled") {
    const settled = group === "settled";
    const won = t.status === "won";
    const lost = t.status === "lost";
    const voided = t.status === "void"; // game postponed/cancelled — auto-settled, stake back
    const track = liveTrack(t);
    // one stored timeline holds goals and cards; split them into their own scoresheets
    const timeline = (f?.events ?? []) as GoalEvent[];
    const goals = timeline.filter((e) => !isCard(e));
    const cardEvents = timeline.filter(isCard);
    // the scoreline is authoritative — a goal counts the moment the score moves, even before its
    // scorer/minute is fetched. Pad each side up to the real score with placeholder goals so the
    // summary count AND the drawer always match hg–ag while the events endpoint catches up.
    const homeGoalEvents = goals.filter((e) => e.side === "home").length;
    const awayGoalEvents = goals.filter((e) => e.side === "away").length;
    const paddedGoals: GoalEvent[] = [...goals];
    for (let i = homeGoalEvents; i < hg; i++) paddedGoals.push({ side: "home", kind: "goal", min: null, player: null });
    for (let i = awayGoalEvents; i < ag; i++) paddedGoals.push({ side: "away", kind: "goal", min: null, player: null });
    const goalCount = paddedGoals.length;
    const fs = oneStat(f?.fixture_stats ?? null);
    const pressing = fs?.momentum?.pressing;
    const lean = pressing === "home" ? 64 : pressing === "away" ? 36 : 52;
    const pressLabel =
      pressing === "home" ? `${f?.home_team} pressing` : pressing === "away" ? `${f?.away_team} pressing` : "Even";

    // Corners belong to THIS card only when the bet is a corner market — otherwise a corner bet on
    // the fixture would leak its corner split onto a sibling goals/result bet (they share fixture
    // stats). Every corner market key contains "corner". Momentum is a general live read (any bet).
    const isCornerMarket = (t.market_key ?? "").includes("corner");
    const showCorners = isCornerMarket && !!fs && (fs.corners_home != null || fs.corners_away != null);
    const cornerTotal = (fs?.corners_home ?? 0) + (fs?.corners_away ?? 0);
    const showMomentum = !settled && !!pressing;
    // collapsed drawer summary + whether there's anything to reveal
    const drawerParts = [
      goalCount > 0 ? `${goalCount} goal${goalCount === 1 ? "" : "s"}` : "",
      cardEvents.length > 0 ? `${cardEvents.length} card${cardEvents.length === 1 ? "" : "s"}` : "",
      showCorners ? `${cornerTotal} corner${cornerTotal === 1 ? "" : "s"}` : "",
    ].filter(Boolean);
    const hasDrawerContent = goalCount > 0 || cardEvents.length > 0 || showCorners || showMomentum;
    const drawerSummary = drawerParts.length ? drawerParts.join(" · ") : showMomentum ? "Live stats" : "No events yet";

    return (
      <div
        className={`betslip betslip-chalk rounded-2xl bg-chalk text-ink shadow-xl transition-transform duration-200 hover:-translate-y-0.5 ${
          compact ? "p-4" : "p-5"
        }`}
      >
        <div className="flex items-center justify-between gap-2">
          <League f={f} />
          <div className="flex flex-none items-center gap-1.5">
            {settled ? (
              <span
                className={`rounded-full px-2.5 py-1 font-mono text-[10px] font-bold uppercase ${
                  won ? "bg-grass/15 text-grass-deep" : lost ? "bg-brick/15 text-brick" : "bg-ink/5 text-ink-mute"
                }`}
              >
                {won ? "Landed" : lost ? "Missed" : voided ? "Void — game off" : "Full-time"}
              </span>
            ) : (
              <LiveClock label={ms?.label ?? "Live"} />
            )}
            <RemoveBtn id={t.id} busy={busy} onRemove={onRemove} />
          </div>
        </div>

        <div className={`mt-3 min-w-0 ${compact ? "text-lg" : "text-xl"}`}>
          <Teams f={f} size="lg" />
        </div>
        <div className="mt-1 flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate font-mono text-[11px] font-bold uppercase tracking-wide text-flood-deep">{shownMarket}</span>
          {yesNoPick && (
            <span
              className={`flex-none rounded px-1.5 py-0.5 font-mono text-[9px] font-bold uppercase tracking-wide ${
                yesNoPick === "no" ? "bg-brick/15 text-brick" : "bg-grass/15 text-grass-deep"
              }`}
            >
              {yesNoPick}
            </span>
          )}
          <TrafficDot signal={signal} />
        </div>

        {isStatNoFeed ? (
          <div className="mt-4 flex items-end justify-between gap-3">
            <div className="font-mono font-bold leading-none tracking-tight text-ink-mute" style={{ fontSize: compact ? "34px" : "46px" }}>
              —
            </div>
            <div className="text-right text-[11px] leading-snug text-ink-mute">
              no live count for this stat
              <br />
              graded at full-time
            </div>
          </div>
        ) : track ? (
          <div className="mt-4 flex items-end justify-between gap-3">
            <div
              className={`font-mono font-bold leading-none tracking-tight ${pulse ? "pop " : ""}${
                track.busted ? "text-brick" : track.hit ? "text-grass-deep" : pulse ? "text-flood-deep" : "text-ink"
              }`}
              style={{ fontSize: compact ? "34px" : "46px" }}
            >
              {track.big}
              <span className="text-ink-mute" style={{ fontSize: compact ? "15px" : "19px" }}>{track.of}</span>
            </div>
            <div className="text-right">
              {settled && !track.hit ? (
                // the game's over — the "X more to clear" nudge no longer applies
                <div className="font-mono text-[11px] font-bold uppercase tracking-wide text-ink-mute">final</div>
              ) : (
                <>
                  <div className={`font-mono text-sm font-bold ${track.busted ? "text-brick" : track.hit ? "text-grass-deep" : "text-ink"}`}>{track.needN}</div>
                  <div className="mt-0.5 text-[11px] text-ink-mute">{track.needT}</div>
                </>
              )}
            </div>
          </div>
        ) : (
          // result / BTTS scoreline: [home] n – n [away]. Backed side is the dominant figure
          // (T5); BTTS weighs both teams equally since both must score.
          <div className={`mt-4 flex items-end gap-3 ${pulse ? "pop" : ""}`}>
            <Tally n={isCardsScore ? cardsH : hg} side="home" big={isCardsScore ? cardsBigH : isLeadBy ? leadHomeUp : isRunStreak ? runHomeUp : isBtts || isBtts2 || (isSeesaw ? hg >= ag : homeBig)} compact={compact} bonus={homeBonus} />
            <span className="pb-1.5 font-mono text-lg text-ink-mute">–</span>
            <Tally n={isCardsScore ? cardsA : ag} side="away" big={isCardsScore ? cardsBigA : isLeadBy ? leadAwayUp : isRunStreak ? runAwayUp : isBtts || isBtts2 || (isSeesaw ? ag >= hg : !homeBig)} compact={compact} bonus={awayBonus} />
            {cardsReadout ? (
              <div className="ml-auto pb-1 text-right font-mono text-[9.5px] font-bold uppercase tracking-wide text-ink-mute">
                {cardsReadout.top}
                {cardsReadout.bottom && <><br />{cardsReadout.bottom}</>}
              </div>
            ) : isBtts ? (
              <div className="ml-auto pb-1 text-right font-mono text-[9.5px] font-bold uppercase tracking-wide text-ink-mute">
                {hg > 0 && ag > 0 ? "both scored" : hg > 0 ? <>{f?.away_team}<br />to score</> : ag > 0 ? <>{f?.home_team}<br />to score</> : "both to score"}
              </div>
            ) : isBtts2 ? (
              <div className="ml-auto pb-1 text-right font-mono text-[9.5px] font-bold uppercase tracking-wide text-ink-mute">
                {hg >= 2 && ag >= 2 ? "both hit 2" : hg < 2 && ag < 2 ? "both to 2+" : hg < 2 ? <>{f?.home_team}<br />to 2</> : <>{f?.away_team}<br />to 2</>}
              </div>
            ) : runReadout ? (
              <div className="ml-auto pb-1 text-right font-mono text-[9.5px] font-bold uppercase tracking-wide text-ink-mute">
                {runReadout.top}
                {runReadout.bottom && <><br />{runReadout.bottom}</>}
              </div>
            ) : leadReadout ? (
              <div className="ml-auto pb-1 text-right font-mono text-[9.5px] font-bold uppercase tracking-wide text-ink-mute">
                {leadReadout.top}
                {leadReadout.bottom && <><br />{leadReadout.bottom}</>}
              </div>
            ) : seesaw ? (
              <div className="ml-auto pb-1 text-right font-mono text-[9.5px] font-bold uppercase tracking-wide text-ink-mute">
                {seesaw.top}
                {seesaw.bottom && <><br />{seesaw.bottom}</>}
              </div>
            ) : standing ? (
              <div className="ml-auto pb-1 text-right font-mono text-[9.5px] font-bold uppercase tracking-wide text-ink-mute">
                {/* name the actual team, e.g. "Arsenal or draw" / "draw or Chelsea" instead of
                    "Home or draw" / "Draw or away" (case-insensitive so X2's lowercase "away" is caught) */}
                {standing.pick.replace(/home/gi, f?.home_team ?? "Home").replace(/away/gi, f?.away_team ?? "Away")}
              </div>
            ) : backed ? (
              <div className="ml-auto pb-1 text-right font-mono text-[9.5px] font-bold uppercase tracking-wide text-ink-mute">
                backing<br />{backed === "home" ? f?.home_team : f?.away_team}
              </div>
            ) : null}
          </div>
        )}

        {/* match-detail drawer — folds away so the card stays short; the chevron always shows so you
            can draw it out. Goals & cards always; corners only on a corner bet (they're irrelevant to
            a goals/result bet on the same fixture); the live momentum read while the game is on. */}
        <div className={compact ? "mt-3" : "mt-4"}>
          <button
            type="button"
            onClick={() => setShowEvents((v) => !v)}
            aria-expanded={showEvents}
            className="flex w-full items-center gap-2 font-mono text-[10px] uppercase tracking-wide text-ink-mute transition-colors hover:text-ink"
          >
            <span className="flex-none">{drawerSummary}</span>
            <span className="h-px flex-1 bg-ink/10" />
            <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2" className={`h-3 w-3 flex-none transition-transform duration-200 ${showEvents ? "rotate-180" : ""}`}>
              <path d="M3 4.5 6 7.5 9 4.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
          {showEvents &&
            (hasDrawerContent ? (
              <>
                {goalCount > 0 && <EventSheet label="Goals" events={paddedGoals} compact={compact} />}
                {cardEvents.length > 0 && <EventSheet label="Cards" events={cardEvents} compact={compact} />}
                {showCorners && (
                  <StatSplit label="Corners" home={fs!.corners_home ?? 0} away={fs!.corners_away ?? 0} compact={compact} />
                )}
                {showMomentum && (
                  <div className="mt-4 border-t border-dashed border-ink/15 pt-3">
                    <div className="flex justify-between font-mono text-[10.5px] uppercase tracking-wide text-ink-mute">
                      <span>Momentum · last 10&prime;</span>
                      <span className="font-bold text-flood-deep">{pressLabel}</span>
                    </div>
                    <div className="relative mt-2 flex h-6 items-center overflow-hidden rounded-lg bg-ink/[0.06]">
                      <span className="absolute left-1/2 top-0 bottom-0 w-px bg-ink/20" />
                      <span className="absolute left-0 top-0 bottom-0 border-r-2 border-flood-deep bg-flood/20" style={{ width: `${lean}%` }} />
                      <span className="relative z-10 flex items-center gap-1.5 px-2.5 font-mono text-[11px] font-bold text-ink"><SideDot side="home" className="!h-2 !w-2" />{teamCode(f?.home_team)}</span>
                      <span className="relative z-10 ml-auto flex items-center gap-1.5 px-2.5 font-mono text-[11px] font-bold text-ink">{teamCode(f?.away_team)}<SideDot side="away" className="!h-2 !w-2" /></span>
                    </div>
                  </div>
                )}
              </>
            ) : (
              <p className="mt-2 font-mono text-[10.5px] text-ink-mute">No match events yet.</p>
            ))}
        </div>

        {showManual && <ManualSettle t={t} busy={busy} onSettle={onSettle} />}
      </div>
    );
  }


  // UPCOMING — betslip, kickoff-forward; tracking hasn't started
  return (
    <div className="betslip betslip-chalk rounded-2xl bg-chalk p-5 text-ink shadow-lg transition-transform hover:-translate-y-0.5">
      <div className="flex items-center justify-between gap-2">
        <League f={f} />
        <div className="flex flex-none items-center gap-1.5">
          {awaitingFeed ? (
            <span className="flex items-center gap-1.5 font-mono text-xs font-bold text-flood-deep">
              <span className="h-1.5 w-1.5 rounded-full bg-flood-deep animate-blink motion-reduce:animate-none" />
              awaiting feed
            </span>
          ) : (
            <span className="font-mono text-xs text-ink-mute">◷ {ms?.label ?? "Upcoming"}</span>
          )}
          <RemoveBtn id={t.id} busy={busy} onRemove={onRemove} />
        </div>
      </div>
      <div className="mt-3 min-w-0 text-xl">
        <Teams f={f} size="lg" />
      </div>
      <div className="mt-0.5 truncate font-mono text-[11px] font-bold uppercase tracking-wide text-flood-deep">{marketName}</div>
      <div className="mt-4 flex items-end justify-between gap-3">
        <div className="font-mono text-4xl font-bold leading-none tracking-tight text-ink-mute">—</div>
        <div className={`text-right text-[11px] leading-snug ${awaitingFeed ? "text-flood-deep" : "text-ink-mute"}`}>
          {stuck ? (
            <>
              no result from
              <br />
              the data feed yet
            </>
          ) : awaitingFeed ? (
            <>
              kicked off · waiting
              <br />
              on live data
            </>
          ) : (
            <>
              tracking starts
              <br />
              at kickoff
            </>
          )}
        </div>
      </div>
      {showManual && <ManualSettle t={t} busy={busy} onSettle={onSettle} />}
    </div>
  );
}

type Filter = "all" | "live" | "upcoming" | "landed" | "missed";

const TABS: { key: Filter; label: string; tone?: string }[] = [
  { key: "all", label: "All" },
  { key: "live", label: "Live" },
  { key: "upcoming", label: "Upcoming" },
  { key: "landed", label: "Landed" },
  { key: "missed", label: "Missed" },
];

const SECTION: Record<Group, { label: string; dot: string }> = {
  live: { label: "Live now", dot: "bg-flood" },
  upcoming: { label: "Upcoming", dot: "bg-onpitch-mute" },
  settled: { label: "Settled", dot: "bg-onpitch-mute" },
};

export default function TrackerBoard({ tickets, since }: { tickets: Ticket[]; since?: string }) {
  const [filter, setFilter] = useState<Filter>("all");
  const [busyId, setBusyId] = useState<string | null>(null);
  const nowMs = useMinuteTick(); // ticks the live clock every minute
  const router = useRouter();
  const supabase = createClient();
  const confirm = useConfirm();

  async function manualSettle(id: string, result: "won" | "lost" | "void") {
    setBusyId(id);
    const { error } = await supabase
      .from("tickets")
      .update({ status: result, settled_at: new Date().toISOString() })
      .eq("id", id);
    setBusyId(null);
    if (!error) router.refresh();
  }

  async function remove(id: string) {
    // an acca leg is part of a slip — removing it from the tracker must NOT delete it from the
    // accumulator, so we just hide it here; a standalone bet is deleted outright
    const leg = tickets.find((x) => x.id === id);
    const isAccaLeg = !!leg?.accumulator_id;
    const ok = isAccaLeg
      ? await confirm({ title: "Hide this leg?", body: "It stays part of your accumulator — this only hides it from your tracker.", confirmLabel: "Hide" })
      : await confirm({ title: "Remove this bet?", body: "This removes the bet from your tracker.", confirmLabel: "Remove", tone: "danger" });
    if (!ok) return;
    setBusyId(id);
    const { error } = isAccaLeg
      ? await supabase.from("tickets").update({ tracker_hidden: true }).eq("id", id)
      : await supabase.from("tickets").delete().eq("id", id);
    setBusyId(null);
    if (!error) router.refresh();
  }

  // wipe the whole tracker in one go — same rules as single remove: acca legs are only hidden
  // (the slip stays intact), standalone bets are deleted
  async function clearAll() {
    const ok = await confirm({
      title: "Clear all tracked games?",
      body: `Removes all ${tickets.length} game${tickets.length === 1 ? "" : "s"} from your tracker. Accumulator legs are only hidden — your slips stay intact.`,
      confirmLabel: "Clear all",
      tone: "danger",
    });
    if (!ok) return;
    setBusyId("__all__");
    const accaIds = tickets.filter((t) => t.accumulator_id).map((t) => t.id);
    const soloIds = tickets.filter((t) => !t.accumulator_id).map((t) => t.id);
    if (accaIds.length) await supabase.from("tickets").update({ tracker_hidden: true }).in("id", accaIds);
    if (soloIds.length) await supabase.from("tickets").delete().in("id", soloIds);
    setBusyId(null);
    router.refresh();
  }

  const grouped = useMemo(() => {
    const g: Record<Group, Ticket[]> = { live: [], upcoming: [], settled: [] };
    for (const t of tickets) g[groupOf(t, stateOf(t))].push(t);
    // keep the tracker to today's slate — older settled games live in History
    if (since) {
      g.settled = g.settled.filter((t) => {
        const d = ticketDate(t);
        return !d || d >= since;
      });
    }
    // STABLE order everywhere: acca legs share a created_at, and Postgres returns tied rows
    // in arbitrary order each refresh — so tiebreak on id (unique) or cards keep swapping,
    // live AND settled. newest added first; upcoming by soonest kickoff.
    const byCreated = (a: Ticket, b: Ticket) =>
      (b.created_at ?? "").localeCompare(a.created_at ?? "") || a.id.localeCompare(b.id);
    g.live.sort(byCreated);
    g.settled.sort(byCreated);
    g.upcoming.sort(
      (a, b) => (a.fixtures?.kickoff_utc ?? "").localeCompare(b.fixtures?.kickoff_utc ?? "") || a.id.localeCompare(b.id)
    );
    return g;
  }, [tickets, since]);

  const landed = useMemo(() => grouped.settled.filter((t) => t.status === "won"), [grouped]);
  const missed = useMemo(() => grouped.settled.filter((t) => t.status === "lost"), [grouped]);

  const compactLive = grouped.live.length > LIVE_COMPACT_AT;

  const counts = {
    all: grouped.live.length + grouped.upcoming.length + grouped.settled.length,
    live: grouped.live.length,
    upcoming: grouped.upcoming.length,
    landed: landed.length,
    missed: missed.length,
  };

  // when a game newly lands/misses it leaves the Live tab — flash the tab it moved into so
  // the user sees where it went instead of watching it just vanish
  const prevStatus = useRef<Map<string, string> | null>(null);
  const [flash, setFlash] = useState<{ landed: boolean; missed: boolean }>({ landed: false, missed: false });
  useEffect(() => {
    const prev = prevStatus.current;
    const next = new Map<string, string>();
    let landedNow = false;
    let missedNow = false;
    for (const t of tickets) {
      next.set(t.id, t.status);
      const was = prev?.get(t.id);
      if (prev && was && was !== t.status) {
        if (t.status === "won") landedNow = true;
        if (t.status === "lost") missedNow = true;
      }
    }
    prevStatus.current = next; // first run just seeds the map (no flash on mount)
    if (landedNow || missedNow) setFlash((f) => ({ landed: f.landed || landedNow, missed: f.missed || missedNow }));
  }, [tickets]);
  useEffect(() => {
    if (!flash.landed && !flash.missed) return;
    const tm = setTimeout(() => setFlash({ landed: false, missed: false }), 3200);
    return () => clearTimeout(tm);
  }, [flash]);

  const allView = filter === "all";
  const sections: Group[] = (["live", "upcoming", "settled"] as Group[]).filter((s) => grouped[s].length);
  const filteredList =
    filter === "live" ? grouped.live : filter === "upcoming" ? grouped.upcoming : filter === "landed" ? landed : filter === "missed" ? missed : [];

  return (
    <div>
      {/* fixed header on every width; transparent at rest, fills in only when scrolled */}
      <StickyHeader>
        <div className="mx-auto max-w-5xl px-5 pb-3 pt-6 md:px-8">
          <MobileLogo />
          <div className="flex items-end justify-between gap-4">
            <div className="min-w-0">
              <p className="font-mono text-[11px] uppercase tracking-[0.25em] text-flood">{counts.all} tracking</p>
              <h1 className="mt-2 font-disp text-3xl font-bold tracking-tight text-chalk sm:text-4xl">
                Your slips, <span className="text-onpitch-mute">live.</span>
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

          {counts.all > 0 && (
            <div className="no-scrollbar mt-5 flex gap-1.5 overflow-x-auto">
              {TABS.map((tab) => {
                const active = filter === tab.key;
                const n = counts[tab.key];
                const isLive = tab.key === "live" && n > 0;
                // a game just moved here — flash a coloured dot on the tab (like Live), so the user
                // sees where it went. green for Landed, red for Missed.
                const flashing = (tab.key === "landed" && flash.landed) || (tab.key === "missed" && flash.missed);
                const dotColor = tab.key === "landed" ? "bg-grass" : tab.key === "missed" ? "bg-brick" : "bg-flood";
                const showDot = !active && (isLive || flashing);
                return (
                  <button
                    key={tab.key}
                    onClick={() => setFilter(tab.key)}
                    className={`flex flex-none items-center gap-2 rounded-full border px-3.5 py-2 font-mono text-[11px] font-bold uppercase tracking-wide transition-colors ${
                      active
                        ? "border-flood bg-flood text-ink"
                        : "border-white/10 bg-pitch-2 text-onpitch-mute hover:border-white/25 hover:text-chalk"
                    }`}
                  >
                    {showDot && <span className={`h-1.5 w-1.5 animate-pulse rounded-full motion-reduce:animate-none ${dotColor}`} />}
                    {tab.label}
                    <span className={`font-bold tabular-nums ${active ? "text-ink/70" : tab.tone ?? "text-chalk"}`}>{n}</span>
                  </button>
                );
              })}
              <button
                onClick={clearAll}
                disabled={busyId === "__all__"}
                className="flex flex-none items-center gap-1.5 rounded-full border border-white/10 bg-pitch-2 px-3.5 py-2 font-mono text-[11px] font-bold uppercase tracking-wide text-brick transition-colors hover:border-brick/50 disabled:opacity-50"
              >
                ✕ Clear all
              </button>
            </div>
          )}
        </div>
      </StickyHeader>

      <div className="mx-auto max-w-5xl px-5 pb-10 pt-5 md:px-8">
        {counts.all === 0 ? (
          <div className="mt-10 rounded-2xl border border-dashed border-ink/15 bg-chalk p-12 text-center shadow-xl">
            <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-flood/15 font-mono text-xl text-flood-deep">+</div>
            <h2 className="font-disp text-xl font-bold text-ink">Nothing tracked today.</h2>
            <p className="mx-auto mt-2 max-w-sm text-sm text-ink-mute">
              Add a game and the market you bet — Onside tracks it live through to settlement.
            </p>
            <div className="mt-5 flex flex-wrap justify-center gap-3">
              <Link href="/add" className="inline-block rounded-xl bg-flood px-5 py-3 font-bold text-ink">
                Add a bet
              </Link>
            </div>
          </div>
        ) : allView ? (
          <div className="flex flex-col gap-8">
            {sections.map((s) => (
              <section key={s}>
                <div className="mb-3 flex items-center gap-2">
                  <span className={`h-2 w-2 rounded-sm ${SECTION[s].dot} ${s === "live" ? "animate-pulse motion-reduce:animate-none" : ""}`} />
                  <h2 className="font-mono text-[11px] font-bold uppercase tracking-[0.2em] text-onpitch">{SECTION[s].label}</h2>
                  <span className="font-mono text-[11px] text-onpitch-mute">· {grouped[s].length}</span>
                </div>
                <div className="grid grid-cols-1 items-start gap-3 sm:grid-cols-2 xl:grid-cols-3">
                  {grouped[s].map((t) => (
                    <Card key={t.id} t={t} compact={s === "live" && compactLive} busy={busyId === t.id} onSettle={manualSettle} onRemove={remove} nowMs={nowMs} />
                  ))}
                </div>
              </section>
            ))}
          </div>
        ) : filteredList.length === 0 ? (
          <div className="mt-10 rounded-2xl border border-dashed border-ink/15 bg-chalk p-10 text-center shadow-xl">
            <p className="text-sm text-ink-mute">No {filter} bets right now.</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 items-start gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {filteredList.map((t) => (
              <Card key={t.id} t={t} compact={filter === "live" && compactLive} busy={busyId === t.id} onSettle={manualSettle} onRemove={remove} nowMs={nowMs} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
