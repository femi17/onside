"use client";

// Performance page — mirrors design-reference/performance.html. "Is it actually working?"
// Grades your agents' settled picks against the market: hit rate, value vs market, paper P/L,
// calibration, by-league / by-tier breakdowns, and data-derived "what's working" insights.
// Everything is computed client-side from the delivered picks (no schema changes).
import { useMemo, useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import StickyHeader from "@/components/StickyHeader";
import MobileLogo from "@/components/MobileLogo";

export type PerfPick = {
  id: string;
  strategy_id: string | null;
  result: string; // won | lost | void | pending
  model_prob: number | null;
  market_prob: number | null;
  edge: number | null; // fraction (0.05 = +5%)
  tier: string | null;
  clv: number | null; // closing-line value = our de-vigged prob − the closing de-vigged prob (fraction)
  market_key: string | null;
  market_label: string | null;
  delivered_at: string | null;
  strategies: { name: string | null } | { name: string | null }[] | null;
  fixtures: { leagues: { name: string | null; flag_url: string | null; tier: string | null } | null } | null;
};

const agentOf = (p: PerfPick) => (Array.isArray(p.strategies) ? p.strategies[0]?.name : p.strategies?.name) ?? "Agent";
const leagueOf = (p: PerfPick) => p.fixtures?.leagues?.name ?? "Other";
const pct = (x: number) => `${Math.round(x * 100)}%`;
const signed = (x: number) => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(1)}%`;
// start of the ISO week (Mon) for a date, as a yyyy-mm-dd key
function weekKey(iso: string): string {
  const d = new Date(iso);
  const day = (d.getUTCDay() + 6) % 7; // Mon=0
  d.setUTCDate(d.getUTCDate() - day);
  return d.toISOString().slice(0, 10);
}
const weekLabel = (key: string) => new Date(key).toLocaleDateString("en-GB", { day: "2-digit", month: "short" });

export type LearningEvent = {
  id: string;
  strategy_id: string | null;
  prev_min_edge: number | null;
  new_min_edge: number | null;
  avg_roi: number | null;
  avg_clv: number | null;
  basis: string | null; // 'clv' | 'roi' | 'cross_agent' — which signal drove the adjustment
  sample_size: number | null;
  created_at: string | null;
  strategies: { name: string | null } | { name: string | null }[] | null;
};
const evAgent = (e: LearningEvent) => (Array.isArray(e.strategies) ? e.strategies[0]?.name : e.strategies?.name) ?? "Agent";

// the user's agents (for the per-tab 🛡️ Onside Shield toggle)
export type PerfStrategy = { id: string; name: string | null; shield: boolean | null; status: string | null };

// 🛡️ Shield rule — MUST mirror the engine (run-strategies): a league is "failing" for an agent
// when it has ≥5 settled picks there and under 45% won. Shown next to the badge so the user sees
// exactly what the shield is blocking right now.
const SHIELD_MIN_SETTLED = 5;
const SHIELD_FAIL_RATE = 0.45;

// plain-language explanations for the top KPI cards (opened via the ? button on each card)
type HelpKey = "landed" | "vsmarket" | "clv" | "pnl" | "green";
const HELP: Record<HelpKey, { title: string; body: string[] }> = {
  landed: {
    title: "Picks that landed",
    body: [
      "Out of all your finished picks, how many won.",
      "Example: 50 games finished, 31 won → 62%.",
      "Games still playing don’t count yet.",
      "Winning often is nice, but it doesn’t mean you made money — cheap favourites win a lot and pay little. For the money question, check “vs market implied”.",
    ],
  },
  vsmarket: {
    title: "vs market implied",
    body: [
      "Did your picks win MORE often than the odds said they would?",
      "Odds are the bookie’s guess of the chance. Odds of 2.00 = a 50-50 shot. Odds of 1.72 = about a 58% chance.",
      "Say the odds on your picks added up to “these should win 58% of the time” — but yours actually won 62%. You beat the bookie by +4%.",
      "Plus number = you’re getting bargains. Minus number = you’re overpaying.",
    ],
  },
  clv: {
    title: "Value vs closing line",
    body: [
      "The best sign your agent is genuinely good — this is the number professionals watch.",
      "Odds move all day. The last price just before kick-off is called “the close” — it’s the smartest price, because by then everyone’s money and information is in.",
      "If the odds on your pick got SHORTER after your agent took them, the market ended up agreeing with your agent. That’s called “beating the close”.",
      "Example: your agent took a price that said 55% chance; by kick-off the price said 56%. That’s +1% CLV. Small numbers are normal.",
      "Why it matters: winning games needs some luck. Beating the close doesn’t. Keep beating the close and you have a real edge — even before many games finish.",
    ],
  },
  pnl: {
    title: "Paper P/L",
    body: [
      "Pretend money — nothing was actually staked.",
      "Imagine putting 1 unit on every pick. A unit is any amount you like — ₦100, ₦1,000, whatever.",
      "+3.4u means you’d be up 3.4 stakes. −2u means down 2 stakes.",
      "We count it at fair prices with the bookie’s cut removed, so this number shows skill — not their margin.",
    ],
  },
  green: {
    title: "Strike on 🟢 picks",
    body: [
      "Your win rate counting ONLY the picks your agent was most sure about (🟢).",
      "🟢 means the agent thinks the odds are paying at least 5% too much. 🟡 a bit too much. 🟠 only slightly.",
      "This number should be HIGHER than “Picks that landed”.",
      "If it is, it means: when your agent is confident, it’s right more often. That’s what you want.",
    ],
  },
};

export type Discovery = {
  id: string; title: string; detail: string; rule_text: string;
  market_key: string; side: string | null; line: number | null;
  score: number; train_n: number; holdout_n: number; status: string;
  grade?: string; shadow_n?: number; shadow_hits?: number;
};
const DISC_MK: Record<string, string> = {
  double_chance_1x: "Home or draw (1X)", double_chance_x2: "Draw or away (X2)", home_win: "Home win",
  over_1_5: "Over 1.5 goals", over_2_5: "Over 2.5 goals", under_2_5: "Under 2.5 goals", under_3_5: "Under 3.5 goals",
  btts: "Both teams to score", home_to_score: "Home to score", away_to_score: "Away to score", home_goals_ou: "Home team goals",
};

export default function PerformanceBoard({ picks, events, learningAgents = [], strategies = [], discoveries = [], hideHeader = false }: { picks: PerfPick[]; events: LearningEvent[]; learningAgents?: string[]; strategies?: PerfStrategy[]; discoveries?: Discovery[]; hideHeader?: boolean }) {
  const [agent, setAgent] = useState<string | null>(null);
  const [days, setDays] = useState<14 | null>(null); // null = this season (all)
  const [help, setHelp] = useState<HelpKey | null>(null); // which KPI explainer modal is open
  const [copiedDisc, setCopiedDisc] = useState<string | null>(null); // discovery whose rule was just copied

  const agents = useMemo(() => Array.from(new Set(picks.map(agentOf))).sort(), [picks]);

  // 🛡️ Onside Shield — per-agent, opt-in. Local state seeds from the DB and updates optimistically.
  const [shieldOn, setShieldOn] = useState<Record<string, boolean>>(() => {
    const m: Record<string, boolean> = {};
    for (const s of strategies) if (s.name) m[s.name] = m[s.name] || s.shield === true;
    return m;
  });
  const [shieldBusy, setShieldBusy] = useState(false);
  // ALL-TIME per-league record for the selected agent (not timeframe-filtered — the engine judges
  // on full history too), evaluated with the exact engine rule.
  const shieldLeagues = useMemo(() => {
    if (!agent) return [];
    const m = new Map<string, { n: number; w: number }>();
    for (const p of picks) {
      if (agentOf(p) !== agent || (p.result !== "won" && p.result !== "lost")) continue;
      const k = leagueOf(p);
      const b = m.get(k) ?? { n: 0, w: 0 };
      b.n++; if (p.result === "won") b.w++;
      m.set(k, b);
    }
    return Array.from(m.entries())
      .filter(([, b]) => b.n >= SHIELD_MIN_SETTLED && b.w / b.n < SHIELD_FAIL_RATE)
      .map(([name, b]) => ({ name, n: b.n, rate: b.w / b.n }))
      .sort((a, b) => a.rate - b.rate);
  }, [picks, agent]);
  async function toggleShield() {
    if (!agent || shieldBusy) return;
    const ids = strategies.filter((s) => s.name === agent).map((s) => s.id);
    if (!ids.length) return;
    const next = !shieldOn[agent];
    setShieldBusy(true);
    setShieldOn((m) => ({ ...m, [agent]: next })); // optimistic — badge lights up immediately
    const supabase = createClient();
    const { error } = await supabase.from("strategies").update({ shield: next }).in("id", ids);
    if (error) setShieldOn((m) => ({ ...m, [agent]: !next })); // revert on failure
    setShieldBusy(false);
  }

  const d = useMemo(() => {
    const floor = days ? Date.now() - days * 86400000 : 0;
    const inScope = picks.filter((p) => {
      if (agent && agentOf(p) !== agent) return false;
      if (floor && (!p.delivered_at || Date.parse(p.delivered_at) < floor)) return false;
      return true;
    });
    const settled = inScope.filter((p) => p.result === "won" || p.result === "lost");
    const won = settled.filter((p) => p.result === "won").length;
    const total = settled.length;
    const winRate = total ? won / total : 0;

    // priced = settled picks that carry a de-vigged market probability (used for value + P/L)
    const priced = settled.filter((p) => p.market_prob != null && p.market_prob > 0 && p.market_prob < 1);
    const pricedWon = priced.filter((p) => p.result === "won").length;
    const winRatePriced = priced.length ? pricedWon / priced.length : 0;
    const avgMarket = priced.length ? priced.reduce((s, p) => s + (p.market_prob as number), 0) / priced.length : 0;
    const vsMarket = winRatePriced - avgMarket;
    // paper P/L in units: 1u flat stakes at fair (de-vigged) odds
    const pnl = priced.reduce((s, p) => s + (p.result === "won" ? 1 / (p.market_prob as number) - 1 : -1), 0);

    // closing-line value — the north-star skill metric. Available on any priced pick whose closing
    // price was snapshotted (capture-closing), settled or not, so it reads across ALL in-scope picks.
    const clvPicks = inScope.filter((p) => p.clv != null && Number.isFinite(p.clv));
    const avgClv = clvPicks.length ? clvPicks.reduce((s, p) => s + (p.clv as number), 0) / clvPicks.length : 0;
    const beatClose = clvPicks.filter((p) => (p.clv as number) > 0).length;
    const beatCloseRate = clvPicks.length ? beatClose / clvPicks.length : 0;

    // CLV by league — where the agents beat the closing line (avg CLV + beat-rate per league)
    const clvLgMap = new Map<string, { sum: number; n: number; beat: number }>();
    for (const p of clvPicks) {
      const k = leagueOf(p);
      const b = clvLgMap.get(k) ?? { sum: 0, n: 0, beat: 0 };
      b.sum += p.clv as number; b.n++; if ((p.clv as number) > 0) b.beat++;
      clvLgMap.set(k, b);
    }
    const clvLeagues = Array.from(clvLgMap.entries())
      .map(([name, b]) => ({ name, avg: b.sum / b.n, n: b.n, beatRate: b.beat / b.n }))
      .sort((a, b) => b.avg - a.avg);

    // strike on the greenest picks (edge ≥ 5%)
    const green = settled.filter((p) => (p.edge ?? -1) >= 0.05);
    const greenWon = green.filter((p) => p.result === "won").length;
    const greenStrike = green.length ? greenWon / green.length : 0;

    // hit rate vs market, by week
    const wkMap = new Map<string, { won: number; total: number; mkt: number; priced: number }>();
    for (const p of settled) {
      if (!p.delivered_at) continue;
      const k = weekKey(p.delivered_at);
      const b = wkMap.get(k) ?? { won: 0, total: 0, mkt: 0, priced: 0 };
      b.total++; if (p.result === "won") b.won++;
      if (p.market_prob != null && p.market_prob > 0 && p.market_prob < 1) { b.mkt += p.market_prob; b.priced++; }
      wkMap.set(k, b);
    }
    const weeks = Array.from(wkMap.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .slice(-6)
      .map(([k, b]) => ({ label: weekLabel(k), actual: b.total ? b.won / b.total : 0, market: b.priced ? b.mkt / b.priced : 0 }));

    // calibration — the ONE card for it (owner-ruled 2026-08-20): every % claim singled out
    // per bet type at the EXACT integer % ("80-90% won't make us know if 82-84 is failing"),
    // the same (family × exact %) cells the engine's bandVeto studies. A cell that has proven
    // to land far under its claim (25+ settled) gets skipped by the engine before delivery.
    const famOf = (mk: string | null): string => {
      const k = mk ?? "";
      if (/corner/.test(k)) return "Corners";
      if (/card|booking/.test(k)) return "Cards";
      if (/1up|2up|never_down/.test(k)) return "Early pay";
      if (/^(home_win|away_win|draw$|result_1x2|double_chance|dnb|handicap)/.test(k)) return "Result";
      if (/^(home_to_score|away_to_score|btts|home_clean_sheet|away_clean_sheet|home_win_to_nil|away_win_to_nil)/.test(k)) return "To score";
      return "Goals";
    };
    const calMap = new Map<string, { n: number; won: number; probSum: number }>();
    for (const p of settled) {
      if (p.model_prob == null || !(p.model_prob > 0 && p.model_prob < 1)) continue;
      const k = `${famOf(p.market_key)}|${Math.round(p.model_prob * 100)}`;
      const c = calMap.get(k) ?? { n: 0, won: 0, probSum: 0 };
      c.n++; if (p.result === "won") c.won++; c.probSum += p.model_prob;
      calMap.set(k, c);
    }
    const bands = Array.from(calMap.entries())
      .map(([k, c]) => {
        const [fam, pctStr] = k.split("|");
        const actual = c.won / c.n, predicted = c.probSum / c.n;
        return {
          fam, pct: Number(pctStr), n: c.n, actual, predicted,
          // the engine's own skip rule (BAND_MIN_N/SLACK/FLOOR in run-strategies) — a row this
          // flag marks is being kicked out of deliveries automatically
          blocked: c.n >= 25 && (actual < predicted - 0.15 || actual < 0.45),
        };
      })
      // high-confidence claims first — that's where betting decisions are made
      .sort((a, b) => a.fam.localeCompare(b.fam) || b.pct - a.pct);

    // by league — where the edge is real
    const lgMap = new Map<string, { won: number; total: number; mkt: number; priced: number; pricedWon: number }>();
    for (const p of settled) {
      const k = leagueOf(p);
      const b = lgMap.get(k) ?? { won: 0, total: 0, mkt: 0, priced: 0, pricedWon: 0 };
      b.total++; if (p.result === "won") b.won++;
      if (p.market_prob != null && p.market_prob > 0 && p.market_prob < 1) { b.mkt += p.market_prob; b.priced++; if (p.result === "won") b.pricedWon++; }
      lgMap.set(k, b);
    }
    const leagues = Array.from(lgMap.entries()).map(([name, b]) => ({
      name, won: b.won, total: b.total,
      edgePct: b.priced ? b.pricedWon / b.priced - b.mkt / b.priced : null,
    })).sort((a, b) => (b.edgePct ?? -1) - (a.edgePct ?? -1));

    // by edge tier (matches the confidence dots: 🟢 ≥5%, 🟡 3–5%, 🟠 <3%)
    const tierBand = (lo: number, hi: number) => {
      const inT = settled.filter((p) => (p.edge ?? -1) >= lo && (p.edge ?? -1) < hi);
      const w = inT.filter((p) => p.result === "won").length;
      return { n: inT.length, rate: inT.length ? w / inT.length : 0 };
    };
    const tiers = [
      { key: "🟢 Strong (edge ≥5%)", ...tierBand(0.05, 99) },
      { key: "🟡 Solid (3–5%)", ...tierBand(0.03, 0.05) },
      { key: "🟠 Marginal (<3%)", ...tierBand(-99, 0.03) },
    ];
    const tierHolds = tiers[0].n > 0 && tiers[2].n > 0 && tiers[0].rate >= tiers[1].rate && tiers[1].rate >= tiers[2].rate;

    // insights (Phase 1: data-derived; Phase 2 will fold in the learning-change log)
    const graded = leagues.filter((l) => l.total >= 4 && l.edgePct != null);
    const best = graded.find((l) => (l.edgePct as number) > 0.02) ?? null;
    const worst = [...graded].reverse().find((l) => (l.edgePct as number) < -0.02) ?? null;

    return { inScope, settled, won, total, winRate, priced, avgMarket, vsMarket, clvPicks, avgClv, beatCloseRate, clvLeagues, pnl, green, greenStrike, weeks, bands, leagues, tiers, tierHolds, best, worst };
  }, [picks, agent, days]);

  // self-tuning log (Pro Max learning agents), filtered to the same agent + timeframe
  const tunes = useMemo(() => {
    const floor = days ? Date.now() - days * 86400000 : 0;
    const filtered = (events ?? []).filter((e) => {
      if (agent && evAgent(e) !== agent) return false;
      if (floor && (!e.created_at || Date.parse(e.created_at) < floor)) return false;
      return true;
    });
    // a re-run can log the SAME adjustment twice (same agent + before→after + basis); collapse
    // those so the log never shows a repeat. Genuine step-by-step tunes differ, so they're kept.
    // events arrive newest-first, so the first occurrence we keep is the most recent.
    const seen = new Set<string>();
    return filtered.filter((e) => {
      const key = `${evAgent(e)}|${e.prev_min_edge ?? ""}|${e.new_min_edge ?? ""}|${e.basis ?? ""}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }, [events, agent, days]);

  const hasData = d.total > 0;

  return (
    <div className="pb-24">
      {!hideHeader && (
        <StickyHeader>
          <div className="mx-auto max-w-5xl px-5 pb-3 pt-6 md:px-8">
            <MobileLogo />
            <p className="font-mono text-[11px] uppercase tracking-[0.25em] text-flood">Is it actually working?</p>
            <h1 className="mt-2 font-disp text-3xl font-bold tracking-tight text-chalk sm:text-4xl">Performance.</h1>
          </div>
        </StickyHeader>
      )}

      <div className="mx-auto max-w-5xl px-5 pt-2 md:px-8">
        {/* filter bar: agents + timeframe */}
        <div className="flex flex-wrap items-center gap-2">
          {agents.length > 1 && (
            <>
              <Chip on={agent === null} onClick={() => setAgent(null)}>All agents</Chip>
              {agents.map((a) => (
                <Chip key={a} on={agent === a} onClick={() => setAgent(a)}>{a}</Chip>
              ))}
            </>
          )}
          <span className="flex-1" />
          <Chip on={days === 14} onClick={() => setDays(14)}>14 days</Chip>
          <Chip on={days === null} onClick={() => setDays(null)}>This season</Chip>
        </div>

        {/* 🛡️ Onside Shield — per-agent only (never on the All tab). When ON, this agent stops
            picking games from leagues it's measurably failing in (≥5 settled, under 45% won —
            re-checked every run, so a league can earn its way back). The badge is the switch. */}
        {agent && strategies.some((s) => s.name === agent) && (
          <div className={`mt-4 flex items-center gap-4 rounded-2xl border p-4 shadow-xl transition-colors ${
            shieldOn[agent] ? "border-flood/50 bg-flood/[0.08]" : "border-white/10 bg-white/[0.03]"
          }`}>
            <button
              onClick={toggleShield}
              disabled={shieldBusy}
              aria-pressed={!!shieldOn[agent]}
              aria-label={`Onside Shield ${shieldOn[agent] ? "on" : "off"} — tap to ${shieldOn[agent] ? "turn off" : "turn on"}`}
              title={shieldOn[agent] ? "Shield is ON — tap to turn off" : "Shield is OFF — tap to turn on"}
              className={`grid h-14 w-14 flex-none place-items-center rounded-full border-2 text-2xl transition-all duration-300 disabled:opacity-60 ${
                shieldOn[agent]
                  ? "border-flood bg-flood/20 shadow-[0_0_18px_rgba(255,183,3,0.45)]"
                  : "border-white/20 bg-white/[0.04] opacity-50 grayscale"
              }`}
            >
              🛡️
            </button>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="font-disp text-[15px] font-extrabold text-chalk">Onside Shield</span>
                <span className={`rounded-full px-2 py-0.5 font-mono text-[9.5px] font-bold uppercase tracking-wide ${
                  shieldOn[agent] ? "bg-flood/20 text-flood" : "bg-white/10 text-onpitch-mute"
                }`}>
                  {shieldOn[agent] ? "Active" : "Off"}
                </span>
              </div>
              <p className="mt-1 text-[12.5px] leading-snug text-onpitch-mute">
                {shieldOn[agent]
                  ? shieldLeagues.length
                    ? <>Blocking <b className="text-chalk">{shieldLeagues.map((l) => l.name).join(", ")}</b> — {agent} is under {Math.round(SHIELD_FAIL_RATE * 100)}% there ({shieldLeagues.map((l) => `${Math.round(l.rate * 100)}% of ${l.n}`).join(" · ")}). Re-checked every run; a league earns its way back by the record improving.</>
                    : <>No failing leagues right now — the shield is standing guard and will block any league where {agent} drops under {Math.round(SHIELD_FAIL_RATE * 100)}% over {SHIELD_MIN_SETTLED}+ settled picks.</>
                  : <>Off — {agent} can pick from any of its leagues. Turn on to auto-block leagues it&apos;s failing in (under {Math.round(SHIELD_FAIL_RATE * 100)}% won over {SHIELD_MIN_SETTLED}+ settled picks).</>}
              </p>
            </div>
          </div>
        )}

        {!hasData ? (
          <div className="mt-10 rounded-2xl border border-dashed border-white/15 bg-chalk p-12 text-center text-ink shadow-xl">
            <div className="mx-auto mb-4 grid h-12 w-12 place-items-center rounded-xl bg-flood/15 font-mono text-xl text-flood-deep">📊</div>
            <h2 className="font-disp text-xl font-bold text-ink">No settled picks yet.</h2>
            <p className="mx-auto mt-2 max-w-sm text-sm text-ink-mute">
              Once your agents&apos; games finish, this is where you&apos;ll see whether they&apos;re beating the market —
              hit rate, value vs price, and where your edge is real.
            </p>
            <Link href="/strategies/new" className="mt-5 inline-block rounded-xl bg-flood px-5 py-3 font-bold text-ink">Build an agent</Link>
          </div>
        ) : (
          <>
            {/* KPIs */}
            <div className="mt-4 grid grid-cols-2 gap-3.5 md:grid-cols-3 lg:grid-cols-5">
              <Kpi k="Picks that landed" v={pct(d.winRate)} d={`${d.won} of ${d.total} settled`} onHelp={() => setHelp("landed")} />
              <Kpi k="vs market implied" v={d.priced.length ? signed(d.vsMarket) : "—"} tone={d.vsMarket >= 0 ? "up" : "down"} d={d.priced.length ? `market expected ${pct(d.avgMarket)}` : "no priced picks"} onHelp={() => setHelp("vsmarket")} />
              <Kpi k="vs closing line" v={d.clvPicks.length ? signed(d.avgClv) : "—"} tone={d.avgClv >= 0 ? "up" : "down"} d={d.clvPicks.length ? `${pct(d.beatCloseRate)} beat the close · ${d.clvPicks.length}` : "no close data yet"} onHelp={() => setHelp("clv")} />
              <Kpi k="Paper P/L" v={d.priced.length ? `${d.pnl >= 0 ? "+" : ""}${d.pnl.toFixed(1)}u` : "—"} tone={d.pnl >= 0 ? "up" : "down"} d="1u flat, fair odds" onHelp={() => setHelp("pnl")} />
              <Kpi k="Strike on 🟢 picks" v={d.green.length ? pct(d.greenStrike) : "—"} tone="amber" d={d.green.length ? `${d.green.length} strong-edge` : "none yet"} onHelp={() => setHelp("green")} />
            </div>

            <div className="mt-4 grid gap-4 lg:grid-cols-[1.4fr_1fr]">
              {/* hit rate vs market */}
              <Panel title="Hit rate vs the market" sub="Your settled picks against what the bookmakers priced, by week">
                {d.weeks.length ? (
                  <>
                    <div className="mt-5 flex h-[180px] items-end gap-4 border-b border-ink/10 pb-0.5">
                      {d.weeks.map((w) => (
                        <div key={w.label} className="flex h-full flex-1 flex-col items-center justify-end gap-1.5">
                          <div className="flex h-full w-full items-end justify-center gap-1">
                            <div className="w-[26%] rounded-t bg-flood-deep" style={{ height: `${Math.max(2, w.actual * 100)}%` }} title={`Actual ${pct(w.actual)}`} />
                            <div className="w-[26%] rounded-t bg-ink/20" style={{ height: `${Math.max(2, w.market * 100)}%` }} title={`Market ${pct(w.market)}`} />
                          </div>
                          <span className="font-mono text-[10.5px] text-ink-mute">{w.label}</span>
                        </div>
                      ))}
                    </div>
                    <div className="mt-3 flex gap-4 font-mono text-[11px] text-ink-mute">
                      <span className="flex items-center gap-1.5"><i className="h-2.5 w-2.5 rounded-[3px] bg-flood-deep" /> Your actual</span>
                      <span className="flex items-center gap-1.5"><i className="h-2.5 w-2.5 rounded-[3px] bg-ink/25" /> Market implied</span>
                    </div>
                  </>
                ) : <Empty>Not enough settled weeks yet.</Empty>}
              </Panel>

              {/* calibration — every % singled out per bet type (the engine's exact cells) */}
              <Panel title="Calibration" sub="Every % claim, singled out — does an 81% land 81%? (tick = claimed)">
                {d.bands.length ? (
                  <div className="no-scrollbar mt-1 flex max-h-[280px] flex-col overflow-y-auto">
                    {d.bands.map((b) => (
                      <div key={`${b.fam}${b.pct}`} className="mt-3 flex items-center gap-3">
                        <span className="w-[104px] flex-none truncate font-mono text-[11px] text-ink">
                          {b.blocked ? "🚫 " : ""}{b.fam} {b.pct}%
                        </span>
                        <div className="relative h-2.5 flex-1 rounded-[5px] bg-ink/[0.08]">
                          <div className={`absolute inset-y-0 left-0 rounded-[5px] ${b.blocked ? "bg-brick" : "bg-grass"}`} style={{ width: `${b.actual * 100}%` }} />
                          <div className="absolute -top-[3px] h-[15px] w-0.5 bg-ink/50" style={{ left: `${b.predicted * 100}%` }} />
                        </div>
                        <span className="w-14 flex-none text-right font-mono text-[11px] text-ink-mute">{pct(b.actual)} · {b.n}</span>
                      </div>
                    ))}
                    <p className="mt-3 text-[11.5px] leading-snug text-ink-mute">
                      🚫 = this exact % has proven to land far under its claim (25+ settled), so the engine now skips it before delivery.
                    </p>
                  </div>
                ) : <Empty>Priced picks needed to calibrate.</Empty>}
              </Panel>
            </div>

            <div className="mt-4 grid gap-4 lg:grid-cols-2">
              {/* by league */}
              <Panel title="By league" sub="Where your edge is real — and where it isn't">
                {/* fixed height ~6 rows; extra leagues scroll (invisible scrollbar) */}
                <div className="no-scrollbar mt-3.5 flex max-h-[212px] flex-col gap-2 overflow-y-auto">
                  {d.leagues.map((l) => (
                    <div key={l.name} className="flex items-center justify-between text-[13.5px]">
                      <span className="min-w-0 truncate pr-3 font-semibold text-ink">{l.name}</span>
                      <span className={`flex-none font-mono font-bold ${l.edgePct == null ? "text-ink-mute" : l.edgePct > 0.005 ? "text-grass-deep" : l.edgePct < -0.005 ? "text-brick" : "text-ink-mute"}`}>
                        {l.won}/{l.total}{l.edgePct != null ? ` · ${l.edgePct > 0.005 ? signed(l.edgePct) : l.edgePct < -0.005 ? signed(l.edgePct) : "≈ even"}` : ""}
                      </span>
                    </div>
                  ))}
                </div>
              </Panel>

              {/* by tier */}
              <Panel title="By tier" sub="Do the greenest picks really hit more?">
                <div className="mt-3.5 flex flex-col gap-2">
                  {d.tiers.map((t) => (
                    <div key={t.key} className="flex items-center justify-between text-[13.5px]">
                      <span className="font-semibold text-ink">{t.key}</span>
                      <span className={`flex-none font-mono font-bold ${t.n ? "text-grass-deep" : "text-ink-mute"}`}>{t.n ? `${pct(t.rate)} · ${t.n}` : "—"}</span>
                    </div>
                  ))}
                </div>
                <p className="mt-3.5 font-mono text-[11px] text-ink-mute">
                  {d.tierHolds ? "Tier order holds — stake heavier on green." : "Tier order is mixed so far — needs more settled picks."}
                </p>
              </Panel>
            </div>

            {/* CLV by league — reads across ALL priced picks with a captured close (not just settled) */}
            <div className="mt-4">
              <Panel title="CLV by league" sub="Where your agents beat the closing line — the sharpest read on edge">
                {d.clvLeagues.length ? (
                  <div className="no-scrollbar mt-3.5 grid max-h-[220px] grid-cols-1 gap-x-8 gap-y-2.5 overflow-y-auto sm:grid-cols-2">
                    {d.clvLeagues.map((l) => (
                      <div key={l.name} className="flex items-center gap-3 text-[13.5px]">
                        <span className="min-w-0 flex-1 truncate font-semibold text-ink">{l.name}</span>
                        {/* diverging bar, centred at zero: green right = beat the close, red left = worse */}
                        <div className="relative h-2 w-14 flex-none rounded-full bg-ink/[0.08]">
                          <span className="absolute inset-y-0 left-1/2 w-px bg-ink/20" />
                          <span
                            className={`absolute inset-y-0 rounded-full ${l.avg >= 0 ? "bg-grass" : "bg-brick"}`}
                            style={l.avg >= 0
                              ? { left: "50%", width: `${Math.min(50, Math.abs(l.avg) * 1000)}%` }
                              : { right: "50%", width: `${Math.min(50, Math.abs(l.avg) * 1000)}%` }}
                          />
                        </div>
                        <span className={`w-[68px] flex-none text-right font-mono font-bold ${l.avg > 0.0005 ? "text-grass-deep" : l.avg < -0.0005 ? "text-brick" : "text-ink-mute"}`}>
                          {signed(l.avg)} · {l.n}
                        </span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <Empty>No closing-line snapshots yet — CLV fills in as your agents&apos; games approach kick-off.</Empty>
                )}
              </Panel>
            </div>

            {/* what your agent learned (Phase 1: derived from results) */}
            <div className="mt-8 mb-2 flex items-center gap-3">
              <span className="font-mono text-[11px] font-bold uppercase tracking-[0.15em] text-onpitch-mute">What&apos;s working</span>
              <div className="h-px flex-1 bg-white/10" />
            </div>
            {d.best || d.worst ? (
              <div className="flex flex-col gap-3">
                {d.best && (
                  <Insight tone="good" title={`Your ${d.best.name} picks are the engine.`}>
                    {d.best.won}/{d.best.total} landed at {signed(d.best.edgePct as number)} over the market — your cleanest edge this run.
                  </Insight>
                )}
                {d.worst && (
                  <Insight tone="warn" title={`${d.worst.name} keeps letting you down.`}>
                    {d.worst.won}/{d.worst.total}, {signed(d.worst.edgePct as number)} vs their price. Consider tightening the bar there or dropping that market.{" "}
                    <Link href="/strategies" className="text-flood">Review your agents →</Link>
                  </Insight>
                )}
              </div>
            ) : (
              <p className="rounded-2xl border border-white/10 bg-pitch-2 p-5 text-[13.5px] text-onpitch-mute">
                Gathering results — clear insights appear once an agent has ~20 settled picks in a league.
              </p>
            )}

            {/* Phase 2: the agent's real self-tuning log (Pro Max learning) — scoped to the
                selected tab: an agent's tab talks ONLY about that agent, never its siblings */}
            <div className="mt-8 mb-2 flex items-center gap-3">
              <span className="font-mono text-[11px] font-bold uppercase tracking-[0.15em] text-onpitch-mute">
                {agent ? `How ${agent} tuned itself` : "How your agents tuned themselves"}
              </span>
              <div className="h-px flex-1 bg-white/10" />
            </div>
            {tunes.length ? (
              <div className="flex flex-col gap-2.5">
                {tunes.map((e) => {
                  const prev = e.prev_min_edge ?? 0, next = e.new_min_edge ?? 0;
                  const tightened = next > prev;
                  // cross_agent = a new agent seeded from the COMMUNITY's record on its market
                  // family (metric lives in avg_clv, same units) — not its own ROI
                  const basis = e.basis === "clv" || e.basis === "cross_agent" ? e.basis : "roi";
                  const metric = basis === "roi" ? (e.avg_roi ?? 0) : (e.avg_clv ?? 0);
                  return (
                    <div key={e.id} className="flex items-center gap-3 rounded-xl border border-white/10 bg-pitch-2 p-4">
                      <span className={`grid h-8 w-8 flex-none place-items-center rounded-lg font-mono text-base font-bold ${tightened ? "bg-flood/15 text-flood-deep" : "bg-grass/15 text-grass-deep"}`}>
                        {tightened ? "↑" : "↓"}
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="text-[13.5px] text-chalk">
                          <b>{evAgent(e)}</b> {tightened ? "tightened" : "loosened"} its bar {signed(prev)} → {signed(next)}
                        </div>
                        <div className="mt-0.5 font-mono text-[11px] text-onpitch-mute">
                          {metric >= 0 ? "+" : ""}{(metric * 100).toFixed(1)}%{" "}
                          {basis === "clv" ? "CLV" : basis === "cross_agent" ? "community record on its market" : "ROI"} over {e.sample_size ?? 0}{" "}
                          {basis === "roi" ? "settled" : "picks"}
                          {e.created_at ? ` · ${new Date(e.created_at).toLocaleDateString("en-GB", { day: "2-digit", month: "short" })}` : ""}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (agent ? learningAgents.filter((n) => n === agent) : learningAgents).length ? (
              // learning IS on — show honest progress toward the first adjustment instead of
              // wrongly telling the user to go turn it on. On an agent tab, ONLY that agent's
              // progress card shows — never the siblings'.
              <div className="flex flex-col gap-2.5">
                {(agent ? learningAgents.filter((n) => n === agent) : learningAgents).map((name) => {
                  const NEED = 20; // learnAdjust's minimum CLV sample size before the first tune
                  const n = Math.min(NEED, picks.filter((p) => agentOf(p) === name && p.clv != null).length);
                  return (
                    <div key={name} className="rounded-xl border border-white/10 bg-pitch-2 p-4">
                      <div className="flex items-center justify-between gap-3 text-[13.5px] text-chalk">
                        <span><b>{name}</b> — Learning is on</span>
                        <span className="font-mono text-[11px] text-onpitch-mute">{n} / {NEED} price samples</span>
                      </div>
                      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-white/10">
                        <div className="h-full rounded-full bg-grass" style={{ width: `${(n / NEED) * 100}%` }} />
                      </div>
                      <p className="mt-2 font-mono text-[11px] leading-relaxed text-onpitch-mute">
                        Each priced pick gets a closing-price snapshot before kickoff; the first self-tune lands once {NEED} have accrued.
                      </p>
                    </div>
                  );
                })}
              </div>
            ) : (
              <p className="rounded-2xl border border-white/10 bg-pitch-2 p-5 text-[13.5px] text-onpitch-mute">
                {agent
                  ? <>{agent} doesn&apos;t have Learning on — no self-tuning to show for it. Turn on Learning in the builder (Pro Max) and its adjustments will appear here.</>
                  : <>No self-tuning yet — a learning agent (Pro Max) adjusts its bar after 20+ settled picks. Turn on Learning when building an agent.</>}
              </p>
            )}

            {/* 🔎 the insight miner — weekly sweep of the full results history for patterns the
                rule language can express; only holdout-validated ones surface. The engine
                SUGGESTS, the owner applies: copy the rule into an agent's rule box. */}
            {!agent && discoveries.length > 0 && (
              <>
                <div className="mt-8 mb-2 flex items-center gap-3">
                  <span className="font-mono text-[11px] font-bold uppercase tracking-[0.15em] text-onpitch-mute">
                    What the engine noticed this week
                  </span>
                  <div className="h-px flex-1 bg-white/10" />
                </div>
                <div className="flex flex-col gap-2.5">
                  {discoveries.map((d) => (
                    <div key={d.id} className="rounded-xl border border-flood/25 bg-pitch-2 p-4">
                      <div className="flex items-center gap-2 text-[13.5px] text-chalk">
                        <span aria-hidden>🔎</span>
                        <b className="min-w-0 flex-1">{d.title}</b>
                        {d.grade === "early" && (
                          <span className="flex-none rounded bg-white/10 px-1.5 py-0.5 font-mono text-[10px] font-bold text-onpitch-mute" title="Found on a small sample — firms up weekly as more picks settle">
                            early signal
                          </span>
                        )}
                        <span className="flex-none rounded bg-flood/15 px-1.5 py-0.5 font-mono text-[10px] font-bold text-flood" title="How far above the market-wide baseline this pattern lands">
                          +{Math.round(d.score * 100)}%
                        </span>
                      </div>
                      <p className="mt-1.5 font-mono text-[11.5px] leading-relaxed text-onpitch-mute">{d.detail}</p>
                      {/* paper record: how the suggestion has done on NEW games since it was made */}
                      {(d.shadow_n ?? 0) > 0 && (
                        <p className="mt-1 font-mono text-[11px] font-bold text-grass">
                          📄 Paper record since suggested: {d.shadow_hits}/{d.shadow_n} ({Math.round((100 * (d.shadow_hits ?? 0)) / (d.shadow_n ?? 1))}%)
                        </p>
                      )}
                      <div className="mt-2.5 flex flex-wrap items-center gap-2">
                        <span className="min-w-0 rounded bg-white/5 px-2 py-1 font-mono text-[11px] text-chalk">{d.rule_text}</span>
                        <button
                          onClick={async () => { try { await navigator.clipboard.writeText(d.rule_text); setCopiedDisc(d.id); setTimeout(() => setCopiedDisc(null), 2000); } catch { /* clipboard denied */ } }}
                          className="flex-none rounded-lg border border-white/15 px-2.5 py-1 font-mono text-[11px] font-bold text-chalk transition-colors hover:border-white/35"
                        >
                          {copiedDisc === d.id ? "Copied ✓" : "Copy rule"}
                        </button>
                        <Link
                          href={`/strategies/new?name=${encodeURIComponent(d.title)}&market=${encodeURIComponent(d.market_key)}&rule=${encodeURIComponent(d.rule_text)}`}
                          className="flex-none rounded-lg bg-flood px-2.5 py-1 font-mono text-[11px] font-bold text-ink transition-transform hover:-translate-y-0.5"
                        >
                          Build agent →
                        </Link>
                      </div>
                      <p className="mt-2 font-mono text-[10.5px] leading-relaxed text-onpitch-mute">
                        Runs as a <b className="text-chalk">{DISC_MK[d.market_key] ?? d.market_key}</b> agent — validated on {d.train_n + d.holdout_n} games including a holdout it had never seen.
                      </p>
                    </div>
                  ))}
                </div>
              </>
            )}
          </>
        )}
      </div>

      {/* plain-language explainer for a KPI card */}
      {help && (
        <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center sm:p-4">
          <div onClick={() => setHelp(null)} className="absolute inset-0 bg-ink/60" />
          <div role="dialog" aria-modal="true" aria-label={HELP[help].title} className="relative w-full max-w-md rounded-t-2xl bg-chalk p-5 text-ink shadow-2xl sm:rounded-2xl">
            <div className="flex items-start justify-between gap-3">
              <h3 className="font-disp text-lg font-extrabold text-ink">{HELP[help].title}</h3>
              <button onClick={() => setHelp(null)} aria-label="Close" className="grid h-8 w-8 flex-none place-items-center rounded-lg bg-ink/5 font-mono text-lg text-ink-mute transition-colors hover:text-ink">×</button>
            </div>
            <div className="mt-3 flex flex-col gap-2.5">
              {HELP[help].body.map((p, i) => (
                <p key={i} className="text-[13.5px] leading-relaxed text-ink-mute">{p}</p>
              ))}
            </div>
            <button onClick={() => setHelp(null)} className="mt-4 w-full rounded-xl bg-flood py-2.5 font-bold text-ink">Got it</button>
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

function Kpi({ k, v, d, tone, onHelp }: { k: string; v: string; d: string; tone?: "up" | "down" | "amber"; onHelp?: () => void }) {
  const vc = tone === "up" ? "text-grass-deep" : tone === "down" ? "text-brick" : tone === "amber" ? "text-flood-deep" : "text-ink";
  return (
    <div className="relative rounded-2xl bg-chalk p-4 text-ink shadow-xl md:p-5">
      {onHelp && (
        <button
          onClick={onHelp}
          aria-label={`What does "${k}" mean?`}
          className="absolute right-2.5 top-2.5 grid h-5 w-5 place-items-center rounded-full border border-ink/15 font-mono text-[11px] font-bold leading-none text-ink-mute transition-colors hover:border-ink/40 hover:text-ink"
        >
          ?
        </button>
      )}
      <div className="pr-6 font-mono text-[10.5px] uppercase tracking-wide text-ink-mute">{k}</div>
      <div className={`mt-1.5 font-disp text-[28px] font-extrabold leading-none tracking-tight md:text-[32px] ${vc}`}>{v}</div>
      <div className="mt-1.5 font-mono text-[11px] text-ink-mute">{d}</div>
    </div>
  );
}

function Panel({ title, sub, children }: { title: string; sub: string; children: React.ReactNode }) {
  return (
    <div className="rounded-2xl bg-chalk p-5 text-ink shadow-xl">
      <div className="font-disp text-base font-bold text-ink">{title}</div>
      <div className="mt-0.5 font-mono text-[11px] text-ink-mute">{sub}</div>
      {children}
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="mt-6 font-mono text-[12px] text-ink-mute">{children}</p>;
}

function Insight({ tone, title, children }: { tone: "good" | "warn"; title: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-3.5 rounded-2xl border border-white/15 bg-pitch-2 p-5">
      <span className={`w-[9px] flex-none rounded-[5px] ${tone === "warn" ? "bg-gradient-to-b from-flood to-flood-deep" : "bg-gradient-to-b from-grass to-grass-deep"}`} />
      <div>
        <div className="font-disp text-base font-bold text-chalk">{title}</div>
        <div className="mt-1.5 text-[13.5px] leading-relaxed text-onpitch-mute">{children}</div>
      </div>
    </div>
  );
}
