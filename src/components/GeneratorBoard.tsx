"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { canonicalMarket } from "@/lib/betCatalog";
import { lagosTodayStartISO } from "@/lib/ticket";
import { useMinuteTick } from "@/lib/useMinuteTick";
import StickyHeader from "@/components/StickyHeader";
import MobileLogo from "@/components/MobileLogo";

// One pick in the generator's pool: an agent delivery for a still-upcoming game, priced by the
// per-pick odds waterfall (criteria.odds / odds_src). Only picks that CARRY a price are eligible —
// a priceless leg would make the combined total a lie.
export type GenPick = {
  id: string;
  strategy_id: string | null;
  agent_name: string;
  market_key: string | null;
  market_label: string | null;
  line: number | null;
  side: string | null;
  period: string | null;
  bet_value: string | null;
  model_prob: number | null;
  odds: number;
  odds_src: "quoted" | "derived" | "model";
  fixture: {
    id: number;
    home_team: string;
    away_team: string;
    kickoff_utc: string;
    league: { name: string; flag_url: string | null; tier: string | null } | null;
  };
};

// pragmatic market families, derived from the key + label text (order matters: corners/cards
// before the goals catch-all; BTTS before results because "both teams to score" contains "score")
type Fam = "goals" | "results" | "btts" | "corners" | "cards" | "other";
const FAMS: { key: Fam; label: string }[] = [
  { key: "goals", label: "Goals" },
  { key: "results", label: "Results" },
  { key: "btts", label: "BTTS" },
  { key: "corners", label: "Corners" },
  { key: "cards", label: "Cards" },
  { key: "other", label: "Other" },
];
function famOf(mk: string | null, label: string | null): Fam {
  const s = `${mk ?? ""} ${label ?? ""}`.toLowerCase();
  if (/corner/.test(s)) return "corners";
  if (/card|booking/.test(s)) return "cards";
  if (/btts|both teams|\bgg\b/.test(s)) return "btts";
  if (
    /^(home_win|away_win|draw|double_chance|dc_best|result_1x2|dnb\b|handicap|home_no_bet|away_no_bet|1up|2up|never_down|to_qualify)/.test(mk ?? "") ||
    /\b(win|draw|chance)\b/.test(s)
  )
    return "results";
  if (/goal|over|under|score/.test(s)) return "goals";
  return "other";
}

// Target-odds mode: over the top-20 picks (already ranked by model probability), find the n-leg
// combination whose PRODUCT of odds lands closest to the target — ties broken toward the higher
// summed model probability, so among equally-close slips the user's strongest picks win.
// C(20,5) = 15,504 combinations — instant.
function pickForTarget(pool: GenPick[], n: number, target: number): GenPick[] | null {
  const cand = pool.slice(0, 20);
  if (cand.length < n) return null;
  let best: { picks: GenPick[]; dist: number; prob: number } | null = null;
  const cur: GenPick[] = [];
  const walk = (start: number, prod: number, prob: number) => {
    if (cur.length === n) {
      const dist = Math.abs(Math.log(prod) - Math.log(target));
      if (!best || dist < best.dist - 1e-9 || (Math.abs(dist - best.dist) < 1e-9 && prob > best.prob)) {
        best = { picks: [...cur], dist, prob };
      }
      return;
    }
    for (let i = start; i <= cand.length - (n - cur.length); i++) {
      cur.push(cand[i]);
      walk(i + 1, prod * cand[i].odds, prob + (cand[i].model_prob ?? 0));
      cur.pop();
    }
  };
  walk(0, 1, 0);
  return best ? (best as { picks: GenPick[] }).picks : null;
}

function LeagueTag({ lg }: { lg: { name: string; flag_url: string | null; tier: string | null } | null }) {
  if (!lg) return null;
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

// the three starter agents (same prefill deep-links as the recipe rail) — shown when the user
// has no agents yet, because the generator has nothing to assemble without them
const STARTERS = [
  { emoji: "🛡️", name: "Safe Double", what: "Strongest double-chance angle per game.", market: "dc_best", rule: "Only send picks with a model probability of 75% or higher." },
  { emoji: "🔥", name: "Goals Banker", what: "Over 1.5 goals, only when the model rates it highly.", market: "over_1_5", rule: "Only send picks with a model probability of 82% or higher." },
  { emoji: "⚽", name: "Home Scorers", what: "Home team to score, screened by the model.", market: "home_to_score", rule: "Only send picks with a model probability of 85% or higher." },
];
const starterHref = (r: (typeof STARTERS)[number]) =>
  `/strategies/new?${new URLSearchParams({ name: r.name, market: r.market, rule: r.rule }).toString()}`;

const COMPLIANCE = "Assembled from your agents' picks · 18+ · Bet responsibly · Not financial advice";
const COMPLIANCE_QUICK = "Assembled from your spec's picks · 18+ · Bet responsibly · Not financial advice";

// ---- Quick spec mode ------------------------------------------------------------------------
// Users with no agents state a spec (outcomes + legs + optional target); the engine executes it
// as their own throwaway agent — a single re-aimed `strategies` draft row THEY own. Onside never
// picks first-hand: every pick below came from the user's stated spec.

// Popular-market outcome chips only. side/line mirror the builder's catalog defaults (same
// shapes as StrategyBuilder's SURPRISE_POOL). Owner ruling: NOTHING is pre-selected — the user
// must actively choose their outcomes.
const QUICK_CHIPS: { key: string; label: string; side: string | null; line: number | null }[] = [
  { key: "over_1_5", label: "Over 1.5 goals", side: "over", line: 1.5 },
  { key: "over_2_5", label: "Over 2.5 goals", side: "over", line: 2.5 },
  { key: "under_3_5", label: "Under 3.5 goals", side: "under", line: 3.5 },
  { key: "double_chance_1x", label: "Double chance (1X)", side: "1x", line: null },
  { key: "double_chance_12", label: "Double chance (12)", side: "12", line: null },
  { key: "home_to_score", label: "Home team to score", side: "home", line: null },
  { key: "away_to_score", label: "Away team to score", side: "away", line: null },
  { key: "btts", label: "Both teams to score", side: "yes", line: null },
];

// the user's single quick strategy row: found by user_id + status 'draft' + this exact name,
// re-aimed on every run (a DB trigger exempts draft rows from free-plan locks)
const QUICK_NAME = "⚡ Quick acca";

// one row of the proven_rules table (authenticated SELECT): a holdout-validated rule for a
// market, with its past record. `filters` is the engine-ready rule_parsed filter list.
type ProvenRule = {
  market_key: string;
  market_label: string | null;
  rule_text: string | null;
  filters: unknown[] | null;
  n: number;
  won: number;
  hit: number;
  computed_at: string;
  source: string | null;
};
// hit is a percentage; tolerate a 0..1 fraction just in case the miner ever writes one
const hitPct = (r: ProvenRule) => Math.round(r.hit <= 1 ? r.hit * 100 : r.hit);

// deliver_at mirrors "run now": the quick draft never sits on the scheduler (status 'draft'),
// so this only anchors the engine's same-day hunt window at the moment of the run
function nowDeliverAt(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// client-side mirror of the page's pool mapping (the server page can't share a function with a
// "use client" module, so the shape lives in both places — keep them in step): still-upcoming
// (≥10 min to kickoff), priced picks only.
function rowsToGenPicks(rows: Record<string, unknown>[]): GenPick[] {
  const cutoff = Date.now() + 10 * 60 * 1000;
  const out: GenPick[] = [];
  for (const r of rows) {
    const f = r.fixtures as {
      id: number;
      home_team: string;
      away_team: string;
      kickoff_utc: string;
      status: string | null;
      leagues: { name: string; flag_url: string | null; tier: string | null } | null;
    } | null;
    if (!f?.kickoff_utc || Date.parse(f.kickoff_utc) < cutoff) continue;
    const crit = r.criteria as { odds?: number; odds_src?: string } | null;
    const odds = typeof crit?.odds === "number" && crit.odds > 1 ? crit.odds : null;
    if (odds == null) continue;
    out.push({
      id: r.id as string,
      strategy_id: (r.strategy_id as string) ?? null,
      agent_name: ((r.strategies as { name?: string } | null)?.name) ?? "Your spec",
      market_key: (r.market_key as string) ?? null,
      market_label: (r.market_label as string) ?? null,
      line: (r.line as number) ?? null,
      side: (r.side as string) ?? null,
      period: (r.period as string) ?? null,
      bet_value: (r.bet_value as string) ?? null,
      model_prob: r.model_prob != null ? Number(r.model_prob) : null,
      odds,
      odds_src: crit?.odds_src === "quoted" || crit?.odds_src === "derived" ? crit.odds_src : "model",
      fixture: {
        id: f.id,
        home_team: f.home_team,
        away_team: f.away_team,
        kickoff_utc: f.kickoff_utc,
        league: f.leagues ?? null,
      },
    });
  }
  return out;
}

export default function GeneratorBoard({
  picks,
  plan,
  userId,
  agentCount,
  generatedToday,
}: {
  picks: GenPick[];
  plan: string;
  userId: string;
  agentCount: number;
  generatedToday: number;
}) {
  const nowMs = useMinuteTick();
  const supabase = createClient();
  const router = useRouter();

  const free = plan !== "pro" && plan !== "pro_max";
  const maxLegs = free ? 3 : 5;
  const [legs, setLegs] = useState(Math.min(3, maxLegs));
  const [fam, setFam] = useState<"all" | Fam>("all");
  const [targetStr, setTargetStr] = useState("");
  const [stakeStr, setStakeStr] = useState("1000");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  // client mirror of the server-enforced free quota (the trigger is the real gate)
  const [usedToday, setUsedToday] = useState(generatedToday);
  const outOfSlips = free && usedToday >= 1;

  // ---- Quick spec state ----
  // mode: users with zero agents land on Quick spec (they have no pool to assemble from)
  const [genMode, setGenMode] = useState<"agents" | "quick">(agentCount === 0 ? "quick" : "agents");
  const quickMaxLegs = free ? 3 : 24; // client mirror of the GEN_ACCA_LEGS trigger caps
  const [chips, setChips] = useState<Set<string>>(new Set()); // NO defaults — owner ruling
  const [quickLegs, setQuickLegs] = useState(Math.min(3, free ? 3 : 24));
  // kick-off window in hours from now (0 = anytime today) — maps onto the engine's inclusive
  // local-time kickoff_at/kickoff_until window on the strategy row. ranWindow snapshots the
  // value the LAST run actually used, so the empty-state copy can't drift if chips change after.
  const [quickWindow, setQuickWindow] = useState<0 | 3 | 6>(0);
  const [ranWindow, setRanWindow] = useState<0 | 3 | 6>(0);
  const [quickPicks, setQuickPicks] = useState<GenPick[]>([]);
  // the draft strategy rows the LAST run aimed (one for single/mix; one PER OUTCOME in
  // per-outcome mode — separate ids so two outcomes can both deliver the same fixture).
  // outcome = the chip label (used to suffix names when promoting), null for single/mix.
  const [quickRuns, setQuickRuns] = useState<{ id: string; outcome: string | null }[]>([]);
  const [hunting, setHunting] = useState(false);
  const [quickRan, setQuickRan] = useState(false);
  const [quickMsg, setQuickMsg] = useState<string | null>(null);
  // proven-rule suggestions, keyed by market_key (missing table/rows → simply no card)
  const [proven, setProven] = useState<Record<string, ProvenRule>>({});
  const [applyProven, setApplyProven] = useState(true);
  // save-as-agent (promote the quick draft to a running agent)
  const [saveOpen, setSaveOpen] = useState(false);
  const [agentName, setAgentName] = useState("");
  const [saveBusy, setSaveBusy] = useState(false);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);
  const [savedNames, setSavedNames] = useState<string[]>([]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data } = await supabase
        .from("proven_rules")
        .select("market_key, market_label, rule_text, filters, n, won, hit, computed_at, source")
        .in("market_key", QUICK_CHIPS.map((c) => c.key));
      if (cancelled || !data) return;
      const m: Record<string, ProvenRule> = {};
      for (const r of data as ProvenRule[]) m[r.market_key] = r;
      setProven(m);
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // proven-rule surface: one selected outcome → its card; several where EVERY outcome has a
  // proven row → the per-outcome list with one shared toggle. The default-ON toggle re-arms
  // whenever the selection changes at all.
  const chipsKey = useMemo(() => Array.from(chips).sort().join(","), [chips]);
  useEffect(() => { setApplyProven(true); }, [chipsKey]);
  const singleChipKey = chips.size === 1 ? Array.from(chips)[0] : null;
  const provenRow = singleChipKey ? proven[singleChipKey] ?? null : null;
  const selChips = useMemo(() => QUICK_CHIPS.filter((c) => chips.has(c.key)), [chips]);
  // multi-select surfaces the per-outcome list whenever ANY selected outcome has a proven rule;
  // zero ruled outcomes → a one-line honest note and a single mix run instead
  const anyProvenSel = selChips.length > 1 && selChips.some((c) => proven[c.key]);

  // pool: the user's own pending picks whose game is still ≥10 min from kickoff (re-checked
  // every minute so a slip can't be tracked onto a game that just started). Quick mode swaps in
  // the picks the last spec run found — the assembly pipeline downstream is identical.
  const pool = genMode === "quick" ? quickPicks : picks;
  const upcoming = useMemo(
    () => pool.filter((p) => Date.parse(p.fixture.kickoff_utc) >= nowMs + 10 * 60 * 1000),
    [pool, nowMs]
  );
  const famsPresent = useMemo(() => {
    const s = new Set<Fam>();
    for (const p of upcoming) s.add(famOf(p.market_key, p.market_label));
    return s;
  }, [upcoming]);

  // eligible = family-filtered, ranked by model probability, ONE leg per fixture (v1: no
  // same-game doubling — keep the best-rated pick per game)
  // quick mode already scoped the pool to the user's chosen outcomes — no family filter there
  const famNow = genMode === "quick" ? "all" : fam;
  const eligible = useMemo(() => {
    const filtered = famNow === "all" ? upcoming : upcoming.filter((p) => famOf(p.market_key, p.market_label) === famNow);
    const ranked = [...filtered].sort((a, b) => (b.model_prob ?? -1) - (a.model_prob ?? -1));

    // Multi-outcome quick pools assemble ROUND-ROBIN across market_key groups. Pure prob order
    // buries lower-prob markets (Over 1.5 probs beat 1X probs every time → a 14-leg two-outcome
    // spec came back one-sided), so instead: group by market, keep each group prob-ranked, take
    // best-of-group in rotation (A, B, A, B…); a fixture taken by whichever turn reaches it
    // first leaves EVERY group (one leg per fixture), and a dry group just drops out of the
    // rotation while the rest keep filling. Feeding `chosen`'s slice AND pickForTarget's
    // candidate set from this order preserves representation in both assembly modes.
    if (genMode === "quick") {
      const groups = new Map<string, GenPick[]>();
      for (const p of ranked) {
        const k = p.market_key ?? "";
        const g = groups.get(k);
        if (g) g.push(p);
        else groups.set(k, [p]);
      }
      if (groups.size > 1) {
        const lists = Array.from(groups.values()); // each prob-desc (stable partition of ranked)
        const idx = lists.map(() => 0);
        const seen = new Set<number>();
        const out: GenPick[] = [];
        let took = 1;
        while (took > 0) {
          took = 0;
          for (let g = 0; g < lists.length; g++) {
            while (idx[g] < lists[g].length && seen.has(lists[g][idx[g]].fixture.id)) idx[g]++;
            if (idx[g] < lists[g].length) {
              const p = lists[g][idx[g]++];
              seen.add(p.fixture.id);
              out.push(p);
              took++;
            }
          }
        }
        return out;
      }
    }

    // single group / agents mode: straight best-prob order, one leg per fixture
    const seen = new Set<number>();
    const out: GenPick[] = [];
    for (const p of ranked) {
      if (seen.has(p.fixture.id)) continue;
      seen.add(p.fixture.id);
      out.push(p);
    }
    return out;
  }, [upcoming, famNow, genMode]);

  const target = (() => {
    const t = parseFloat(targetStr.replace(",", "."));
    return Number.isFinite(t) && t > 1 ? t : null;
  })();

  // the assembled slip, shown in kickoff order like a real acca card
  const legsNow = genMode === "quick" ? quickLegs : legs;
  const chosen = useMemo(() => {
    const n = Math.min(legsNow, eligible.length);
    if (n < 2) return [];
    const sel = target ? (pickForTarget(eligible, n, target) ?? eligible.slice(0, n)) : eligible.slice(0, n);
    return [...sel].sort((a, b) => a.fixture.kickoff_utc.localeCompare(b.fixture.kickoff_utc));
  }, [eligible, legsNow, target]);

  // combined odds = PRODUCT of leg odds (never a sum); any estimated leg makes the total an estimate
  const combined = chosen.reduce((acc, p) => acc * p.odds, 1);
  const estimate = chosen.some((p) => p.odds_src !== "quoted");
  const stake = (() => {
    const s = Number(stakeStr.replace(/[,\s]/g, ""));
    return Number.isFinite(s) && s > 0 ? s : null;
  })();
  const potential = stake != null && chosen.length >= 2 ? stake * combined : null;

  async function trackSlip() {
    if (chosen.length < 2 || busy) return;
    setBusy(true);
    setMsg(null);
    // the same accumulators + tickets shape ImportSlip/Rebet write; source 'generated' is what
    // the plan-gate trigger counts. Stake/potential mirror what's on screen (potential from
    // estimated odds is itself an estimate — the card just shows the number).
    const { data: acca, error } = await supabase
      .from("accumulators")
      .insert({
        user_id: userId,
        title: `⚡ Generated ${chosen.length}-fold`,
        leg_count: chosen.length,
        source: "generated",
        status: "open",
        bookmaker: null,
        stake,
        potential_return: potential != null ? Math.round(potential * 100) / 100 : null,
        currency: "NGN",
      })
      .select("id")
      .single();
    if (error || !acca) {
      setBusy(false);
      const gl = error?.message.match(/DAILY_GEN_LIMIT:(\w+):(\d+)/);
      const ll = error?.message.match(/GEN_ACCA_LEGS:(\w+):(\d+)/);
      if (gl) setUsedToday((n) => Math.max(n, Number(gl[2])));
      setMsg(
        gl
          ? `Your ${gl[1].replace("_", " ")} plan generates ${gl[2]} slip${gl[2] === "1" ? "" : "s"} a day — upgrade for unlimited.`
          : ll
            ? `Your ${ll[1].replace("_", " ")} plan caps generated slips at ${ll[2]} legs.`
            : error?.message ?? "Couldn't create the slip."
      );
      return;
    }
    // legs carry the delivery's agent link (strategy_id) and grade exactly like tracked agent
    // picks (source 'agent'); canonicalMarket folds e.g. "home over 0.5" → "home to score" so a
    // leg never shows twice under two names next to an identical tracker bet
    const rows = chosen.map((p) => {
      const c = canonicalMarket(p.market_key, p.line, p.side);
      return {
        user_id: userId,
        accumulator_id: acca.id,
        fixture_id: p.fixture.id,
        market_key: c.marketKey,
        market_label: p.market_label,
        custom_market: c.marketKey === "custom" ? p.market_label : null,
        line: c.line,
        side: c.side,
        period: p.period ?? "ft",
        bet_value: p.bet_value ?? null,
        source: "agent",
        status: "pending",
        strategy_id: p.strategy_id,
      };
    });
    const { error: legErr } = await supabase.from("tickets").insert(rows);
    if (legErr) {
      // don't leave an empty acca behind — hard delete also frees the day's generated slot
      await supabase.from("accumulators").delete().eq("id", acca.id);
      setBusy(false);
      setMsg(legErr.message);
      return;
    }
    setUsedToday((n) => n + 1);
    router.push("/accumulators");
    router.refresh();
  }

  function toggleChip(key: string) {
    setQuickMsg(null);
    setChips((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  // Quick spec run: upsert the user's quick draft strategy row(s) (their own throwaway agents),
  // run each quietly via run-strategies, then re-query the pool scoped to those strategy ids and
  // hand it to the exact same assembly pipeline the agents mode uses.
  //
  // With SEVERAL outcomes selected and at least ONE carrying a proven rule (toggle ON), the spec
  // runs PER OUTCOME — each outcome gets its OWN draft row ("⚡ Quick acca · <label>"): ruled
  // outcomes apply their rule, unruled ones run rule-less (the engine's model floors/screens
  // still apply). Separate strategy ids matter: deliveries dedup on unique(strategy_id,
  // fixture_id), so under ONE shared row outcome A's run would claim the qualifying fixtures and
  // block outcome B (often carrying the identical proven rule → the same fixtures) from
  // delivering them at all (the owner's 14-leg Over1.5+1X spec came back all-Over1.5 for exactly
  // this reason). Distinct ids let both outcomes deliver the same fixture; the assembler stays
  // one-leg-per-fixture. Single-outcome — and multi where NO outcome has a rule or the toggle is
  // off (per-outcome would cost N daily runs for zero rule benefit) — keeps the single
  // "⚡ Quick acca" row. Draft rows are exempt from plan caps by DB design, so N drafts is fine.
  async function runQuickSpec() {
    if (hunting || chips.size === 0) return;
    setHunting(true);
    setQuickMsg(null);
    setQuickRan(false);
    setQuickPicks([]);
    setSaveOpen(false);
    setSaveMsg(null);
    setSavedNames([]);
    setRanWindow(quickWindow);

    const sel = QUICK_CHIPS.filter((c) => chips.has(c.key));
    const perOutcome = sel.length > 1 && applyProven && sel.some((c) => proven[c.key]);

    // kick-off window → the engine's INCLUSIVE local-time kickoff_at/until pair, computed ONCE
    // so every aim this run shares the same window. Plain local Date math is correct here: the
    // row's timezone field IS the browser timezone. HH:MM:00 — engine compares "HH:MM" strings
    // (an until before at wraps past midnight; same_day scoping truncates that at midnight).
    const kickWin = (() => {
      if (!quickWindow) return { kickoff_at: null as string | null, kickoff_until: null as string | null };
      const hm = (d: Date) => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:00`;
      const now = new Date();
      return { kickoff_at: hm(now), kickoff_until: hm(new Date(now.getTime() + quickWindow * 3600 * 1000)) };
    })();

    // shared row fields; a proven rule applies its stored engine-ready filters DIRECTLY — no
    // LLM parse. Without one, rule_text stays null so the empty parse is never re-parsed.
    const baseFor = (pr: ProvenRule | null): Record<string, unknown> => ({
      rule_text: pr?.rule_text ?? null,
      rule_parsed: pr ? { filters: pr.filters ?? [], select: [] } : { filters: [], select: [] },
      league_ids: [], // the spec states outcomes, not competitions — all upcoming leagues
      league_mode: "all",
      selectivity: "strong",
      min_edge: 0.04,
      min_odds: null,
      max_odds: null,
      max_per_prediction: free ? 8 : 24, // plan pick ceilings (plan_limits mirror)
      deliver_at: nowDeliverAt(),
      target_day: "same_day", // hunt today's remaining games, like a same-day agent
      kickoff_at: kickWin.kickoff_at,
      kickoff_until: kickWin.kickoff_until,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "Africa/Lagos",
      channels: ["app"],
      learning: false,
    });
    // row shapes mirror StrategyBuilder's resolveMarket(): one outcome → that market's
    // key/side/line; a rule-less multi → the mix shape (market_key 'mix', list in `markets`)
    const singleRowFor = (c: (typeof QUICK_CHIPS)[number]): Record<string, unknown> => ({
      market_key: c.key,
      market_label: c.label,
      custom_market: null,
      side: c.side,
      line: c.line,
      period: "ft",
      bet_value: null,
      markets: null,
    });
    const mixRow: Record<string, unknown> = {
      market_key: "mix",
      market_label: `Mix · ${sel.length} outcomes`,
      custom_market: null,
      side: null,
      line: null,
      period: "ft",
      bet_value: null,
      markets: sel.map((c) => ({ market_key: c.key, label: c.label, side: c.side, line: c.line, period: "ft", bet_value: null })),
    };

    // every aim this run will make: which draft row (by name) gets which row patch
    const aims: { name: string; outcome: string | null; row: Record<string, unknown> }[] = perOutcome
      ? sel.map((c) => ({
          name: `${QUICK_NAME} · ${c.label}`,
          outcome: c.label,
          row: { ...baseFor(proven[c.key] ?? null), ...singleRowFor(c) },
        }))
      : sel.length === 1
        ? [{ name: QUICK_NAME, outcome: null, row: { ...baseFor(applyProven ? proven[sel[0].key] ?? null : null), ...singleRowFor(sel[0]) } }]
        : [{ name: QUICK_NAME, outcome: null, row: { ...baseFor(null), ...mixRow } }];

    // find-or-create a draft row by its quick name, then aim it. Drafts are exempt from
    // free-plan locks, so re-aiming works on every plan.
    async function aimDraft(name: string, row: Record<string, unknown>): Promise<{ id: string | null; err: string | null }> {
      const { data: found } = await supabase
        .from("strategies")
        .select("id")
        .eq("user_id", userId)
        .eq("status", "draft")
        .eq("name", name)
        .limit(1);
      const id = found?.[0]?.id ?? null;
      if (id) {
        const { error } = await supabase.from("strategies").update(row).eq("id", id);
        return { id, err: error?.message ?? null };
      }
      const { data: ins, error } = await supabase
        .from("strategies")
        .insert({ ...row, user_id: userId, name, status: "draft" })
        .select("id")
        .single();
      return { id: (ins?.id as string) ?? null, err: error?.message ?? null };
    }

    // aim → invoke → next aim. Each invoke costs one of the day's spec runs; hitting the limit
    // (or any error) mid-sequence keeps every delivery already inserted and falls through to
    // the pool re-query, so the slip still assembles from whatever the runs found.
    const used: { id: string; outcome: string | null }[] = [];
    for (const aim of aims) {
      const { id, err } = await aimDraft(aim.name, aim.row);
      if (!id || err) {
        setQuickMsg(err ?? "Couldn't save your spec.");
        break;
      }
      used.push({ id, outcome: aim.outcome });

      // run this aim once, quietly — no push/telegram noise from a throwaway run
      const { error: runErr } = await supabase.functions.invoke("run-strategies", { body: { strategy_id: id, quiet: true } });
      if (runErr) {
        // surface the function's real error body, not the generic "non-2xx" message
        let body: { error?: string; used?: number; limit?: number } | null = null;
        try {
          body = await (runErr as { context?: Response }).context?.json?.();
        } catch { /* keep generic message */ }
        if (body?.error === "quick_run_limit") {
          const limit = body.limit ?? 0;
          setQuickMsg(
            free
              ? `You've used today's ${limit} spec run${limit === 1 ? "" : "s"} — upgrade for more.`
              : `You've used today's ${limit} spec run${limit === 1 ? "" : "s"} — more tomorrow.`
          );
        } else {
          setQuickMsg(body?.error ?? runErr.message ?? "Your spec couldn't run — try again.");
        }
        break;
      }
    }
    setQuickRuns(used);
    if (!used.length) { setHunting(false); return; }

    // re-query the pool ONCE after all runs: the page's exact pool query, scoped to every
    // strategy id this run aimed (per-outcome deliveries live under their own ids)
    const { data: dels, error: qErr } = await supabase
      .from("deliveries")
      .select(
        "id, strategy_id, market_key, market_label, line, side, period, bet_value, model_prob, criteria, strategies(name), fixtures(id, home_team, away_team, kickoff_utc, status, leagues(name, flag_url, tier))"
      )
      .eq("user_id", userId)
      .in("strategy_id", used.map((u) => u.id))
      .eq("result", "pending")
      .gte("delivered_at", lagosTodayStartISO())
      .order("delivered_at", { ascending: false })
      .limit(400);
    setHunting(false);
    if (qErr) { setQuickMsg(qErr.message); return; }
    setQuickPicks(rowsToGenPicks((dels ?? []) as Record<string, unknown>[]));
    setQuickRan(true);
  }

  // Promote EVERY draft the last run used into real running agents — per-outcome runs become
  // one agent per outcome, named "<base> · <outcome label>". Server-side limits (e.g. a free
  // plan's one-running-agent cap) surface as the DB's own per-row error; never pre-blocked
  // client-side, and rows that promoted before a failure honestly stay promoted.
  async function promoteQuick() {
    const nm = agentName.trim();
    if (!quickRuns.length || !nm || saveBusy) return;
    setSaveBusy(true);
    setSaveMsg(null);
    const ok: string[] = [];
    const okIds = new Set<string>();
    let firstErr: string | null = null;
    for (const r of quickRuns) {
      const full = r.outcome ? `${nm} · ${r.outcome}` : nm;
      const { error } = await supabase.from("strategies").update({ name: full, status: "running" }).eq("id", r.id);
      if (error) {
        firstErr = firstErr ?? `${full}: ${error.message}`;
      } else {
        ok.push(full);
        okIds.add(r.id);
      }
    }
    setSaveBusy(false);
    if (ok.length) {
      setSavedNames((prev) => [...prev, ...ok]);
      // only the failures stay retryable — a promoted row must never be promoted twice
      setQuickRuns((prev) => prev.filter((r) => !okIds.has(r.id)));
      router.refresh();
    }
    if (firstErr) {
      setSaveMsg(`${firstErr} — if you're at your plan's agent limit, upgrading unlocks another slot.`);
    } else {
      setSaveOpen(false);
    }
  }

  const compliance = genMode === "quick" ? COMPLIANCE_QUICK : COMPLIANCE;

  const header = (
    <StickyHeader className="-mx-5 px-5 pb-4 pt-6 md:-mx-8 md:px-8">
      <MobileLogo />
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <p className="font-mono text-[11px] uppercase tracking-[0.25em] text-flood">Acca generator</p>
          <h1 className="mt-2 font-disp text-3xl font-bold tracking-tight text-chalk sm:text-4xl">
            {genMode === "quick" ? (
              <>Your spec does the finding. <span className="text-onpitch-mute">We assemble.</span></>
            ) : (
              <>Your agents found them. <span className="text-onpitch-mute">We assemble.</span></>
            )}
          </h1>
        </div>
        {/* same back convention as the builder's StickyHeader — lands on the acca history */}
        <Link href="/accumulators" className="flex-none font-mono text-xs text-onpitch-mute transition-colors hover:text-chalk">
          ← Back
        </Link>
      </div>
    </StickyHeader>
  );

  // top-of-page mode switch: existing agents-pool behaviour vs the stated-spec throwaway agent
  const modeToggle = (
    <div className="mt-4 flex rounded-xl border border-white/10 bg-pitch-2 p-1">
      {([["agents", "My agents' picks"], ["quick", "Quick spec"]] as const).map(([k, l]) => (
        <button
          key={k}
          onClick={() => { setGenMode(k); setMsg(null); }}
          className={`flex-1 rounded-lg px-3 py-2 font-mono text-[11.5px] font-bold transition-colors ${
            genMode === k ? "bg-flood/15 text-flood" : "text-onpitch-mute hover:text-chalk"
          }`}
        >
          {l}
        </button>
      ))}
    </div>
  );

  const footer = (
    <p className="mt-6 pb-4 text-center font-mono text-[10px] uppercase tracking-wide text-onpitch-mute">{compliance}</p>
  );

  // no agents yet → the agents pool is empty; point at the three starter agents (quick mode,
  // the default for these users, still works — the toggle above switches back to it)
  if (genMode === "agents" && agentCount === 0) {
    return (
      <div className="mx-auto max-w-3xl px-5 pb-10 md:px-8">
        {header}
        {modeToggle}
        <div className="mt-6 rounded-2xl border border-flood/30 bg-pitch-2 p-6">
          <p className="font-mono text-[10.5px] font-bold uppercase tracking-[0.2em] text-flood">No agents yet</p>
          <h2 className="mt-2 font-disp text-xl font-extrabold leading-snug text-chalk">
            The generator only assembles from your own agents&apos; picks.
          </h2>
          <p className="mt-2 text-[13.5px] leading-relaxed text-onpitch-mute">
            Onside never picks bets for you — your agents do the finding, the generator does the
            assembling. Put your first agent on your leagues and come back when it delivers.
          </p>
          <div className="mt-4 flex flex-col gap-2">
            {STARTERS.map((r) => (
              <Link
                key={r.name}
                href={starterHref(r)}
                className="group flex items-center gap-3 rounded-xl border border-white/10 bg-pitch px-3.5 py-3 transition-colors hover:border-flood/40"
              >
                <span className="text-lg">{r.emoji}</span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[14px] font-bold text-chalk">{r.name}</span>
                  <span className="block truncate text-[12px] text-onpitch-mute">{r.what}</span>
                </span>
                <span className="flex-none text-onpitch-mute transition-transform group-hover:translate-x-0.5">→</span>
              </Link>
            ))}
          </div>
          <Link
            href="/strategies/new"
            className="mt-4 inline-block rounded-xl bg-flood px-5 py-2.5 text-[14px] font-bold text-ink transition-transform hover:-translate-y-0.5"
          >
            Build an AI agent
          </Link>
        </div>
        {footer}
      </div>
    );
  }

  // agents exist but nothing is still upcoming today → say so honestly, no filler
  if (genMode === "agents" && upcoming.length === 0) {
    return (
      <div className="mx-auto max-w-3xl px-5 pb-10 md:px-8">
        {header}
        {modeToggle}
        <div className="mt-6 rounded-2xl border border-dashed border-white/15 bg-pitch-2 p-10 text-center">
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-flood/15 font-mono text-xl text-flood">⚡</div>
          <h2 className="font-disp text-xl font-bold text-chalk">Your agents found nothing still upcoming today.</h2>
          <p className="mx-auto mt-2 max-w-sm text-sm text-onpitch-mute">
            The generator only builds from your agents&apos; pending picks whose games haven&apos;t
            kicked off. Check back after their next delivery.
          </p>
          <Link href="/agent" className="mt-5 inline-block rounded-xl bg-flood px-5 py-3 font-bold text-ink">
            See the agent feed
          </Link>
        </div>
        {footer}
      </div>
    );
  }

  // the slip only assembles in quick mode after a run actually found still-upcoming picks
  const showSlip = genMode === "agents" || (quickRan && !hunting && upcoming.length > 0);

  return (
    <div className="mx-auto max-w-3xl px-5 pb-10 md:px-8">
      {header}
      {modeToggle}

      {/* ---- quick spec controls ---- */}
      {genMode === "quick" && (
        <>
          <div className="mt-4 rounded-2xl border border-white/10 bg-pitch-2 p-4">
            <p className="font-mono text-[10px] uppercase tracking-wide text-onpitch-mute">Your outcomes — pick at least one</p>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {QUICK_CHIPS.map((c) => {
                const on = chips.has(c.key);
                return (
                  <button
                    key={c.key}
                    onClick={() => toggleChip(c.key)}
                    className={`rounded-full border px-3 py-1.5 font-mono text-[11px] font-bold transition-colors ${
                      on ? "border-flood bg-flood/15 text-flood" : "border-white/15 text-chalk hover:border-white/30"
                    }`}
                  >
                    {c.label}
                  </button>
                );
              })}
            </div>

            {/* proven-rule suggestion: exactly ONE outcome selected AND a proven_rules row exists */}
            {provenRow ? (
              <div className="mt-3.5 rounded-xl border border-flood/30 bg-pitch p-3.5">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-mono text-[10px] font-bold uppercase tracking-[0.2em] text-flood">Proven rule</p>
                    <p className="mt-1 text-[13px] font-bold leading-snug text-chalk">
                      Landed {hitPct(provenRow)}% of {provenRow.n} {provenRow.source === "fixtures" ? "backtested matches" : "graded picks"} — apply it?
                    </p>
                    {provenRow.rule_text && (
                      <p className="mt-1 text-[12px] leading-relaxed text-onpitch-mute">{provenRow.rule_text}</p>
                    )}
                    <p className="mt-1.5 font-mono text-[10px] uppercase tracking-wide text-onpitch-mute">
                      {provenRow.source === "fixtures"
                        ? "Backtested on the full match history · past record, not a promise"
                        : "Past record, not a promise."}
                    </p>
                  </div>
                  <button
                    onClick={() => setApplyProven((v) => !v)}
                    aria-pressed={applyProven}
                    className={`flex-none rounded-full border px-3 py-1.5 font-mono text-[11px] font-bold transition-colors ${
                      applyProven ? "border-flood bg-flood/15 text-flood" : "border-white/15 text-onpitch-mute hover:border-white/30"
                    }`}
                  >
                    {applyProven ? "Applied ✓" : "Off"}
                  </button>
                </div>
              </div>
            ) : anyProvenSel ? (
              // at least one selected outcome is mastered → the spec runs PER OUTCOME (toggle
              // ON): ruled outcomes apply their rule, unruled ones run on model screening only.
              // One shared toggle governs the ruled subset; each outcome costs a spec run.
              <div className="mt-3.5 rounded-xl border border-flood/30 bg-pitch p-3.5">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-mono text-[10px] font-bold uppercase tracking-[0.2em] text-flood">Proven rules</p>
                    <p className="mt-1 text-[13px] font-bold leading-snug text-chalk">Apply proven rules per outcome?</p>
                    <div className="mt-1.5 flex flex-col gap-1">
                      {selChips.map((c) => {
                        const r = proven[c.key] as ProvenRule | undefined;
                        return (
                          <p key={c.key} className="text-[12.5px] font-bold leading-snug text-chalk">
                            {c.label}{" "}
                            <span className="font-mono text-[11px] font-normal text-onpitch-mute">
                              {r ? <>· landed {hitPct(r)}% of {r.n}</> : <>· no proven rule yet — model screening only</>}
                            </span>
                          </p>
                        );
                      })}
                    </div>
                    <p className="mt-1.5 font-mono text-[10px] uppercase tracking-wide text-onpitch-mute">Past record, not a promise.</p>
                    {applyProven && (
                      <p className="mt-1 font-mono text-[10.5px] text-flood">
                        Runs each outcome as its own spec — uses {selChips.length} of your daily runs.
                      </p>
                    )}
                  </div>
                  <button
                    onClick={() => setApplyProven((v) => !v)}
                    aria-pressed={applyProven}
                    aria-label="Apply proven rules per outcome"
                    className={`flex-none rounded-full border px-3 py-1.5 font-mono text-[11px] font-bold transition-colors ${
                      applyProven ? "border-flood bg-flood/15 text-flood" : "border-white/15 text-onpitch-mute hover:border-white/30"
                    }`}
                  >
                    {applyProven ? "Applied ✓" : "Off"}
                  </button>
                </div>
              </div>
            ) : chips.size > 1 ? (
              // no selected outcome has a proven rule yet — one mix run, model screening only
              // (per-outcome would cost extra daily runs for zero rule benefit)
              <p className="mt-3 font-mono text-[10.5px] text-onpitch-mute">
                No proven rules for these outcomes yet — they run as one spec on model screening.
              </p>
            ) : null}

            {/* kick-off window — narrows the engine hunt to games starting inside it */}
            <div className="mt-4">
              <p className="font-mono text-[10px] uppercase tracking-wide text-onpitch-mute">Kick-off</p>
              <div className="no-scrollbar mt-1.5 flex gap-1.5 overflow-x-auto">
                {([[0, "Anytime today"], [3, "Next 3 hours"], [6, "Next 6 hours"]] as const).map(([h, l]) => (
                  <button
                    key={h}
                    onClick={() => { setQuickWindow(h); setQuickMsg(null); }}
                    className={`flex-none rounded-full border px-3 py-1.5 font-mono text-[11px] font-bold transition-colors ${
                      quickWindow === h ? "border-flood bg-flood/15 text-flood" : "border-white/15 text-chalk hover:border-white/30"
                    }`}
                  >
                    {l}
                  </button>
                ))}
              </div>
            </div>

            <div className="mt-4 flex flex-wrap items-end gap-x-5 gap-y-3">
              <div>
                <p className="font-mono text-[10px] uppercase tracking-wide text-onpitch-mute">Legs · 2–{quickMaxLegs}</p>
                <div className="mt-1.5 flex items-center gap-1.5">
                  <button
                    onClick={() => setQuickLegs((n) => Math.max(2, n - 1))}
                    className="h-9 w-9 rounded-lg border border-white/15 font-mono text-[15px] font-bold text-chalk transition-colors hover:border-white/30"
                  >
                    −
                  </button>
                  <span className="w-9 text-center font-mono text-[14px] font-bold text-chalk">{quickLegs}</span>
                  <button
                    onClick={() => setQuickLegs((n) => Math.min(quickMaxLegs, n + 1))}
                    className="h-9 w-9 rounded-lg border border-white/15 font-mono text-[15px] font-bold text-chalk transition-colors hover:border-white/30"
                  >
                    +
                  </button>
                </div>
              </div>
              <div>
                <p className="font-mono text-[10px] uppercase tracking-wide text-onpitch-mute">Target odds (optional)</p>
                <input
                  value={targetStr}
                  onChange={(e) => setTargetStr(e.target.value)}
                  inputMode="decimal"
                  placeholder="leave it general"
                  className="mt-1.5 h-9 w-36 rounded-lg border border-white/15 bg-pitch px-2.5 font-mono text-[13px] font-bold text-chalk placeholder:text-onpitch-mute focus:border-flood focus:outline-none"
                />
              </div>
              <div>
                <p className="font-mono text-[10px] uppercase tracking-wide text-onpitch-mute">Stake (₦)</p>
                <input
                  value={stakeStr}
                  onChange={(e) => setStakeStr(e.target.value)}
                  inputMode="numeric"
                  placeholder="1000"
                  className="mt-1.5 h-9 w-28 rounded-lg border border-white/15 bg-pitch px-2.5 font-mono text-[13px] font-bold text-chalk placeholder:text-onpitch-mute focus:border-flood focus:outline-none"
                />
              </div>
            </div>

            {quickMsg && <p className="mt-3 font-mono text-xs text-brick">{quickMsg}</p>}
            <button
              onClick={runQuickSpec}
              disabled={hunting || chips.size === 0}
              className="mt-4 w-full rounded-xl bg-flood px-4 py-3 font-bold text-ink transition-transform hover:-translate-y-0.5 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:translate-y-0"
            >
              {hunting ? "Hunting…" : chips.size === 0 ? "Pick at least one outcome" : "Generate from my spec"}
            </button>
            {free && (
              <p className="mt-2.5 font-mono text-[10.5px] text-onpitch-mute">
                Free plan: 1 tracked slip a day{usedToday > 0 ? " (used)" : ""} · 3 legs max
              </p>
            )}
          </div>

          {hunting && (
            <div className="mt-4 rounded-2xl border border-dashed border-flood/30 bg-pitch-2 p-8 text-center">
              <div className="mx-auto mb-4 flex h-12 w-12 animate-pulse items-center justify-center rounded-xl bg-flood/15 font-mono text-xl text-flood">⚡</div>
              <p className="text-sm font-bold text-chalk">Your spec is hunting today&apos;s games…</p>
              <p className="mx-auto mt-1.5 max-w-sm text-[12.5px] text-onpitch-mute">
                Every upcoming fixture gets checked against your outcomes — usually 10–40 seconds.
              </p>
            </div>
          )}
          {!hunting && quickRan && upcoming.length === 0 && (
            <div className="mt-4 rounded-2xl border border-dashed border-white/15 bg-pitch-2 p-8 text-center">
              <p className="text-sm font-bold text-chalk">
                {ranWindow
                  ? `Your spec found nothing in the next ${ranWindow} hours.`
                  : "Your spec found nothing still upcoming today."}
              </p>
              <p className="mx-auto mt-1.5 max-w-sm text-[12.5px] text-onpitch-mute">
                {ranWindow
                  ? "Widen the window or loosen the spec — the pool is only today's games that haven't kicked off."
                  : "Loosen it or try more markets — the pool is only today's games that haven't kicked off."}
              </p>
            </div>
          )}
          {!hunting && quickRan && upcoming.length > 0 && (
            <p className="mt-3 font-mono text-[10.5px] text-onpitch-mute">
              {eligible.length} game{eligible.length === 1 ? "" : "s"} matched your spec
            </p>
          )}
        </>
      )}

      {/* ---- controls (agents mode) ---- */}
      {genMode === "agents" && (
      <div className="mt-4 rounded-2xl border border-white/10 bg-pitch-2 p-4">
        <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
          <div>
            <p className="font-mono text-[10px] uppercase tracking-wide text-onpitch-mute">Legs</p>
            <div className="mt-1.5 flex gap-1.5">
              {[2, 3, 4, 5].map((n) => {
                const locked = n > maxLegs;
                return (
                  <button
                    key={n}
                    onClick={() => !locked && setLegs(n)}
                    disabled={locked}
                    title={locked ? "Up to 5 legs on Pro" : undefined}
                    className={`h-9 w-9 rounded-lg border font-mono text-[13px] font-bold transition-colors ${
                      legs === n
                        ? "border-flood bg-flood/15 text-flood"
                        : locked
                          ? "cursor-not-allowed border-white/10 text-onpitch-mute opacity-40"
                          : "border-white/15 text-chalk hover:border-white/30"
                    }`}
                  >
                    {n}
                  </button>
                );
              })}
            </div>
          </div>
          <div>
            <p className="font-mono text-[10px] uppercase tracking-wide text-onpitch-mute">Target odds (optional)</p>
            <input
              value={targetStr}
              onChange={(e) => setTargetStr(e.target.value)}
              inputMode="decimal"
              placeholder="e.g. 5.0"
              className="mt-1.5 h-9 w-24 rounded-lg border border-white/15 bg-pitch px-2.5 font-mono text-[13px] font-bold text-chalk placeholder:text-onpitch-mute focus:border-flood focus:outline-none"
            />
          </div>
          <div>
            <p className="font-mono text-[10px] uppercase tracking-wide text-onpitch-mute">Stake (₦)</p>
            <input
              value={stakeStr}
              onChange={(e) => setStakeStr(e.target.value)}
              inputMode="numeric"
              placeholder="1000"
              className="mt-1.5 h-9 w-28 rounded-lg border border-white/15 bg-pitch px-2.5 font-mono text-[13px] font-bold text-chalk placeholder:text-onpitch-mute focus:border-flood focus:outline-none"
            />
          </div>
        </div>

        {/* market family filter — only families your pool actually has */}
        {famsPresent.size > 1 && (
          <div className="mt-3.5">
            <p className="font-mono text-[10px] uppercase tracking-wide text-onpitch-mute">Markets</p>
            <div className="no-scrollbar mt-1.5 flex gap-1.5 overflow-x-auto">
              <button
                onClick={() => setFam("all")}
                className={`flex-none rounded-full border px-3 py-1.5 font-mono text-[11px] font-bold transition-colors ${
                  fam === "all" ? "border-flood bg-flood/15 text-flood" : "border-white/15 text-chalk hover:border-white/30"
                }`}
              >
                All
              </button>
              {FAMS.filter((f) => famsPresent.has(f.key)).map((f) => (
                <button
                  key={f.key}
                  onClick={() => setFam(f.key)}
                  className={`flex-none rounded-full border px-3 py-1.5 font-mono text-[11px] font-bold transition-colors ${
                    fam === f.key ? "border-flood bg-flood/15 text-flood" : "border-white/15 text-chalk hover:border-white/30"
                  }`}
                >
                  {f.label}
                </button>
              ))}
            </div>
          </div>
        )}

        <p className="mt-3 font-mono text-[10.5px] text-onpitch-mute">
          {eligible.length} game{eligible.length === 1 ? "" : "s"} in your pool
          {free && <> · free plan: 1 generated slip a day{usedToday > 0 ? " (used)" : ""} · 3 legs max</>}
        </p>
      </div>
      )}

      {/* ---- the assembled slip ---- */}
      {!showSlip ? null : chosen.length < 2 ? (
        <div className="mt-4 rounded-2xl border border-dashed border-white/15 bg-pitch-2 p-8 text-center">
          <p className="text-sm font-bold text-chalk">Not enough picks for a {legsNow}-leg slip.</p>
          <p className="mx-auto mt-1.5 max-w-sm text-[12.5px] text-onpitch-mute">
            {genMode === "quick"
              ? "Your spec found games, but not enough still-upcoming legs — one leg per game. Try fewer legs or more markets."
              : fam !== "all"
                ? "Try another market family, or fewer legs — only one leg per game, from picks still upcoming."
                : "Only one leg per game, from picks still upcoming — try fewer legs or wait for the next delivery."}
          </p>
        </div>
      ) : (
        <section className="betslip betslip-chalk mt-4 rounded-2xl bg-chalk text-ink shadow-xl">
          <div className="border-b border-dashed border-ink/15 p-5">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <div className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-wide text-ink-mute">
                  <span className="rounded bg-ink px-1.5 py-0.5 font-bold tracking-wider text-chalk-2">Onside</span>
                  generated
                </div>
                <div className="mt-2 font-disp text-[15px] font-extrabold">{chosen.length}-fold accumulator</div>
                {target != null && (
                  <p className="mt-1 font-mono text-[10.5px] text-ink-mute">
                    closest to your {target.toFixed(2)} target from your own picks
                  </p>
                )}
              </div>
              <div className="text-right font-mono">
                <div className="whitespace-nowrap text-[13px] text-ink-mute">combined odds</div>
                <div
                  className="mt-0.5 whitespace-nowrap font-disp text-2xl font-extrabold tracking-tight text-ink"
                  title={estimate ? "Includes estimated prices — no direct quote for every leg, so this is approximate" : "Median bookmaker odds"}
                >
                  {estimate ? "~" : "@"}{combined.toFixed(2)}
                </div>
                {stake != null && potential != null && (
                  <div className="mt-1 whitespace-nowrap text-[12.5px] text-ink-mute">
                    ₦{stake.toLocaleString()} → <b className="font-bold text-grass-deep">{estimate ? "~" : ""}₦{Math.round(potential).toLocaleString()}</b>
                  </div>
                )}
              </div>
            </div>
          </div>

          <div className="p-3">
            {chosen.map((p) => (
              <div key={p.id} className="grid grid-cols-[1fr_auto] items-center gap-3 rounded-[10px] px-2.5 py-2.5 transition-colors hover:bg-ink/[0.04]">
                <div className="min-w-0">
                  <LeagueTag lg={p.fixture.league} />
                  <div className="mt-0.5 truncate text-sm font-bold leading-tight text-ink">
                    {p.fixture.home_team} <span className="font-semibold text-ink-mute">v</span> {p.fixture.away_team}
                  </div>
                  <div className="mt-0.5 truncate font-mono text-[11px] font-bold uppercase tracking-wide text-flood-deep">
                    {p.market_label ?? "Pick"}
                  </div>
                  <div className="mt-0.5 font-mono text-[10px] text-ink-mute">
                    {p.agent_name}
                    {p.model_prob != null && <> · {Math.round(p.model_prob * 100)}%</>}
                    {" · "}
                    {new Date(p.fixture.kickoff_utc).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}
                  </div>
                </div>
                <div
                  className="text-right font-mono text-sm font-bold text-ink"
                  title={p.odds_src === "quoted" ? "Median bookmaker odds" : "Estimated fair odds — no direct quote"}
                >
                  {p.odds_src === "quoted" ? "@" : "~"}{p.odds.toFixed(2)}
                </div>
              </div>
            ))}
          </div>

          <div className="border-t border-dashed border-ink/15 p-4">
            {msg && <p className="mb-2.5 font-mono text-xs text-brick">{msg}</p>}
            {outOfSlips ? (
              <div className="rounded-xl bg-ink/[0.05] px-3 py-2.5 text-[12.5px] text-ink-mute">
                Today&apos;s generated slip is used.{" "}
                <Link href="/profile" className="font-bold text-ink underline decoration-ink/30 underline-offset-2 hover:decoration-ink">
                  Go Pro for unlimited
                </Link>{" "}
                — or track picks one by one from the feed.
              </div>
            ) : (
              <button
                onClick={trackSlip}
                disabled={busy}
                className="w-full rounded-xl bg-ink px-4 py-3 font-bold text-chalk-2 disabled:opacity-40"
              >
                {busy ? "Tracking…" : `Track this slip · ${chosen.length} legs`}
              </button>
            )}
            <p className="mt-2.5 text-center font-mono text-[10px] uppercase tracking-wide text-ink-mute">{compliance}</p>
          </div>
        </section>
      )}

      {/* ---- save the spec as a real agent (quiet secondary action) ---- */}
      {genMode === "quick" && quickRan && !hunting && quickPicks.length > 0 && (savedNames.length > 0 || quickRuns.length > 0) && (
        <div className="mt-4 rounded-2xl border border-white/10 bg-pitch-2 p-4">
          {savedNames.length > 0 && (
            <p className="text-[13px] text-onpitch-mute">
              Saved — <b className="font-bold text-chalk">{savedNames.join(", ")}</b>{" "}
              {savedNames.length === 1 ? "is now one of your agents" : "are now your agents"} and will deliver on schedule.
            </p>
          )}
          {/* still-unpromoted rows (all of them at first; only the failures after a partial) */}
          {quickRuns.length > 0 &&
            (!saveOpen ? (
              <button
                onClick={() => setSaveOpen(true)}
                className={`${savedNames.length ? "mt-3 " : ""}font-mono text-[12px] font-bold text-onpitch-mute underline decoration-white/20 underline-offset-2 transition-colors hover:text-chalk`}
              >
                {quickRuns.length > 1 ? `Save this spec as ${quickRuns.length} agents →` : "Save this spec as an agent →"}
              </button>
            ) : (
              <div className={savedNames.length ? "mt-3" : undefined}>
                <p className="font-mono text-[10px] uppercase tracking-wide text-onpitch-mute">
                  {quickRuns.some((r) => r.outcome) ? "Base name — each outcome becomes its own agent" : "Name your agent"}
                </p>
                <div className="mt-1.5 flex gap-2">
                  <input
                    value={agentName}
                    onChange={(e) => setAgentName(e.target.value)}
                    placeholder="e.g. Goals Banker"
                    className="h-10 min-w-0 flex-1 rounded-lg border border-white/15 bg-pitch px-3 text-[13.5px] font-bold text-chalk placeholder:text-onpitch-mute focus:border-flood focus:outline-none"
                  />
                  <button
                    onClick={promoteQuick}
                    disabled={saveBusy || !agentName.trim()}
                    className="flex-none rounded-lg bg-flood px-4 font-bold text-ink disabled:opacity-40"
                  >
                    {saveBusy ? "Saving…" : quickRuns.length > 1 ? `Save ${quickRuns.length}` : "Save"}
                  </button>
                </div>
                {quickRuns.some((r) => r.outcome) && agentName.trim() && (
                  <p className="mt-1.5 font-mono text-[10px] text-onpitch-mute">
                    {quickRuns.map((r) => (r.outcome ? `${agentName.trim()} · ${r.outcome}` : agentName.trim())).join(" · ")}
                  </p>
                )}
                {saveMsg && <p className="mt-2 font-mono text-xs text-brick">{saveMsg}</p>}
              </div>
            ))}
        </div>
      )}

      {!(showSlip && chosen.length >= 2) && footer}
    </div>
  );
}
