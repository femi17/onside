"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { canonicalMarket } from "@/lib/betCatalog";
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

  // pool: the user's own pending picks whose game is still ≥10 min from kickoff (re-checked
  // every minute so a slip can't be tracked onto a game that just started)
  const upcoming = useMemo(
    () => picks.filter((p) => Date.parse(p.fixture.kickoff_utc) >= nowMs + 10 * 60 * 1000),
    [picks, nowMs]
  );
  const famsPresent = useMemo(() => {
    const s = new Set<Fam>();
    for (const p of upcoming) s.add(famOf(p.market_key, p.market_label));
    return s;
  }, [upcoming]);

  // eligible = family-filtered, ranked by model probability, ONE leg per fixture (v1: no
  // same-game doubling — keep the best-rated pick per game)
  const eligible = useMemo(() => {
    const filtered = fam === "all" ? upcoming : upcoming.filter((p) => famOf(p.market_key, p.market_label) === fam);
    const ranked = [...filtered].sort((a, b) => (b.model_prob ?? -1) - (a.model_prob ?? -1));
    const seen = new Set<number>();
    const out: GenPick[] = [];
    for (const p of ranked) {
      if (seen.has(p.fixture.id)) continue;
      seen.add(p.fixture.id);
      out.push(p);
    }
    return out;
  }, [upcoming, fam]);

  const target = (() => {
    const t = parseFloat(targetStr.replace(",", "."));
    return Number.isFinite(t) && t > 1 ? t : null;
  })();

  // the assembled slip, shown in kickoff order like a real acca card
  const chosen = useMemo(() => {
    const n = Math.min(legs, eligible.length);
    if (n < 2) return [];
    const sel = target ? (pickForTarget(eligible, n, target) ?? eligible.slice(0, n)) : eligible.slice(0, n);
    return [...sel].sort((a, b) => a.fixture.kickoff_utc.localeCompare(b.fixture.kickoff_utc));
  }, [eligible, legs, target]);

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

  const header = (
    <StickyHeader className="-mx-5 px-5 pb-4 pt-6 md:-mx-8 md:px-8">
      <MobileLogo />
      <div className="min-w-0">
        <p className="font-mono text-[11px] uppercase tracking-[0.25em] text-flood">Acca generator</p>
        <h1 className="mt-2 font-disp text-3xl font-bold tracking-tight text-chalk sm:text-4xl">
          Your agents found them. <span className="text-onpitch-mute">We assemble.</span>
        </h1>
      </div>
    </StickyHeader>
  );

  const footer = (
    <p className="mt-6 pb-4 text-center font-mono text-[10px] uppercase tracking-wide text-onpitch-mute">{COMPLIANCE}</p>
  );

  // no agents yet → the generator has no pool; point at the three starter agents
  if (agentCount === 0) {
    return (
      <div className="mx-auto max-w-3xl px-5 pb-10 md:px-8">
        {header}
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
  if (upcoming.length === 0) {
    return (
      <div className="mx-auto max-w-3xl px-5 pb-10 md:px-8">
        {header}
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

  return (
    <div className="mx-auto max-w-3xl px-5 pb-10 md:px-8">
      {header}

      {/* ---- controls ---- */}
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

      {/* ---- the assembled slip ---- */}
      {chosen.length < 2 ? (
        <div className="mt-4 rounded-2xl border border-dashed border-white/15 bg-pitch-2 p-8 text-center">
          <p className="text-sm font-bold text-chalk">Not enough picks for a {legs}-leg slip.</p>
          <p className="mx-auto mt-1.5 max-w-sm text-[12.5px] text-onpitch-mute">
            {fam !== "all"
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
            <p className="mt-2.5 text-center font-mono text-[10px] uppercase tracking-wide text-ink-mute">{COMPLIANCE}</p>
          </div>
        </section>
      )}
    </div>
  );
}
