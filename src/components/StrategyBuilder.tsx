"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { recognizeBet } from "@/lib/betCatalog";
import { describeRule, type ParsedRule } from "@/lib/ruleReadback";
import StickyHeader from "@/components/StickyHeader";
import MobileLogo from "@/components/MobileLogo";
import ConnectTelegram from "@/components/ConnectTelegram";

export type LeagueOpt = { id: number; name: string; country: string | null; flag_url: string | null; tier: string | null };

const PRESETS = [
  { key: "home_to_score", label: "Home team to score", side: "home", line: null as number | null, sub: "1+ home goal" },
  { key: "over_1_5", label: "Over 1.5 goals", side: "over", line: 1.5 as number | null, sub: "2+ total" },
  { key: "over_2_5", label: "Over 2.5 goals", side: "over", line: 2.5 as number | null, sub: "3+ total" },
  { key: "btts", label: "Both teams to score", side: "yes", line: null as number | null, sub: "GG yes" },
  { key: "over_8_5_corners", label: "Over 8.5 corners", side: "over", line: 8.5 as number | null, sub: "corner line" },
  { key: "home_win", label: "Home win", side: "home", line: null as number | null, sub: "1x2 home" },
];

// Market FAMILIES: pick a category and let the agent choose the exact selection per game (the one
// with the best value). run-strategies resolves these into a specific gradeable pick per fixture.
const FAMILIES = [
  { key: "handicap_best", label: "Handicap", sub: "agent picks the line" },
  { key: "ou_best", label: "Over / Under", sub: "agent picks the line" },
  { key: "result_best", label: "Match result", sub: "1X2 or double chance" },
  { key: "dc_best", label: "Double chance", sub: "agent picks 1X / X2 / 12" },
];

// map a free-text category to a family, so typing e.g. "double chance" or "handicap" works even
// though it isn't a complete single bet (the agent picks the exact selection per game)
function familyFromText(text: string): { key: string; label: string } | null {
  const t = text.trim().toLowerCase();
  if (!t) return null;
  if (/\bhandicap\b|\bah\b/.test(t)) return { key: "handicap_best", label: "Handicap" };
  if (/double\s*chance|\bdc\b/.test(t)) return { key: "dc_best", label: "Double chance" };
  if (/over\s*\/?\s*under|\bo\/u\b|\btotals?\b|^goals?$/.test(t)) return { key: "ou_best", label: "Over / Under" };
  if (/match\s*result|1\s*x\s*2|match\s*odds|full[-\s]*time\s*result|\bresult\b/.test(t)) return { key: "result_best", label: "Match result" };
  return null;
}

// the full set "Surprise me" rolls from — families AND specific outcomes, including ones with no
// button on the page, so the pick is a genuine surprise. All are priced by the engine + gradeable.
const SURPRISE_POOL: { key: string; label: string; side: string | null; line: number | null }[] = [
  { key: "handicap_best", label: "Handicap — agent picks the line", side: null, line: null },
  { key: "ou_best", label: "Over / Under — agent picks the line", side: null, line: null },
  { key: "result_best", label: "Match result — agent picks", side: null, line: null },
  { key: "dc_best", label: "Double chance — agent picks 1X / X2 / 12", side: null, line: null },
  { key: "home_win", label: "Home win", side: "home", line: null },
  { key: "away_win", label: "Away win", side: "away", line: null },
  { key: "draw", label: "Draw", side: "draw", line: null },
  { key: "double_chance_1x", label: "Double chance (1X)", side: "1x", line: null },
  { key: "double_chance_x2", label: "Double chance (X2)", side: "x2", line: null },
  { key: "double_chance_12", label: "Double chance (12)", side: "12", line: null },
  { key: "over_1_5", label: "Over 1.5 goals", side: "over", line: 1.5 },
  { key: "over_2_5", label: "Over 2.5 goals", side: "over", line: 2.5 },
  { key: "over_3_5", label: "Over 3.5 goals", side: "over", line: 3.5 },
  { key: "under_2_5", label: "Under 2.5 goals", side: "under", line: 2.5 },
  { key: "under_3_5", label: "Under 3.5 goals", side: "under", line: 3.5 },
  { key: "btts", label: "Both teams to score", side: "yes", line: null },
  { key: "home_to_score", label: "Home team to score", side: "home", line: null },
  { key: "away_to_score", label: "Away team to score", side: "away", line: null },
];

const PICK_CAPS = [8, 24, 50]; // plan ceilings: free 8 · pro 24 · pro_max 50 (plan_limits.max_games_per_prediction)

// selectivity tiers -> the minimum edge (model prob − market prob) a pick must clear
const SELECT = [
  { key: "elite", name: "Elite value", eq: "min edge +5.0%", min_edge: 0.05, desc: "Only the biggest mispricings clear the bar. Fewest picks, highest conviction." },
  { key: "strong", name: "Strong value", eq: "min edge +4.0%", min_edge: 0.04, desc: "A clear edge over the bookmaker. A balanced number of picks." },
  { key: "wide", name: "Wider net", eq: "min edge +2.5%", min_edge: 0.025, desc: "Smaller edges allowed through. More picks, more variance." },
];

const FINISHED_LIVE = ["FT", "AET", "PEN", "1H", "2H", "HT", "ET", "BT", "P", "LIVE", "SUSP", "INT"];
const PREVIEW_DAYS = 3; // "future" horizon — the agent runs daily, so show a few days of scope

// which day(s), relative to each daily run, the agent hunts — also filters the leagues you can pick
const TARGETS = [
  { k: "same_day", l: "Same day", h: "that day's games, from your delivery time on" },
  { k: "tomorrow", l: "Tomorrow", h: "the next day's full slate" },
  { k: "saturday", l: "Saturday only", h: "Saturday's fixtures — delivered on Saturday" },
  { k: "sunday", l: "Sunday only", h: "Sunday's fixtures — delivered on Sunday" },
  { k: "weekend", l: "This weekend", h: "Saturday & Sunday's fixtures" },
  { k: "future", l: "Next few days", h: "anything upcoming in the next few days" },
];
// day-matched targets: the agent delivers on the same day as the matches (so delivery time is
// validated against kickoff). tomorrow/weekend/future deliver ahead of the match day.
const DAY_MATCHED = new Set(["same_day", "saturday", "sunday"]);
// the fixture window a target maps to (local time ≈ the user's strategy tz); mirrors the engine
function targetWindow(target: string): [string, string] {
  const now = new Date();
  const startOf = (d: Date) => { const s = new Date(d); s.setHours(0, 0, 0, 0); return s; };
  const endOf = (d: Date) => { const e = new Date(d); e.setHours(23, 59, 59, 999); return e; };
  if (target === "tomorrow") {
    const s = new Date(now); s.setDate(s.getDate() + 1);
    return [startOf(s).toISOString(), endOf(s).toISOString()];
  }
  if (target === "saturday" || target === "sunday") {
    const td = target === "saturday" ? 6 : 0; // Sat=6, Sun=0
    const delta = (td - now.getDay() + 7) % 7; // 0 if today is that day
    const day = new Date(now); day.setDate(day.getDate() + delta);
    const from = delta === 0 ? now : startOf(day); // today → from now; else the whole day
    return [from.toISOString(), endOf(day).toISOString()];
  }
  if (target === "weekend") {
    const dow = now.getDay(); // 0 Sun .. 6 Sat
    const daysToSat = dow === 0 ? -1 : 6 - dow; // on Sunday, Saturday was yesterday
    const sat = new Date(now); sat.setDate(sat.getDate() + daysToSat);
    const sun = new Date(sat); sun.setDate(sat.getDate() + 1);
    const from = startOf(sat).getTime() > now.getTime() ? startOf(sat) : now; // don't include the past
    return [from.toISOString(), endOf(sun).toISOString()];
  }
  if (target === "future") {
    const e = new Date(now); e.setDate(e.getDate() + PREVIEW_DAYS);
    return [now.toISOString(), endOf(e).toISOString()];
  }
  return [now.toISOString(), endOf(now).toISOString()]; // same_day
}

export type ExistingStrategy = {
  id: string;
  name: string;
  status: string;
  market_key: string;
  market_label: string | null;
  custom_market: string | null;
  side: string | null;
  line: number | null;
  period: string | null;
  bet_value: string | null;
  rule_text: string | null;
  rule_parsed: ParsedRule | null;
  kickoff_at: string | null;
  league_ids: number[] | null;
  league_mode: string | null;
  selectivity: string | null;
  max_per_prediction: number | null;
  deliver_at: string | null;
  target_day: string | null;
  channels: string[] | null;
  learning: boolean | null;
  markets: MixItem[] | null;
};

// one outcome inside a mixed-outcome agent — the engine weighs every entry per game and
// delivers the best one
export type MixItem = {
  market_key: string;
  label: string;
  side: string | null;
  line: number | null;
  period: string | null;
  bet_value: string | null;
};

// Tappable starters for the rule box — one filter-style, one form-style, one if/else. Each is
// known to parse cleanly (they use the engine's native signals), so a new user's first contact
// with rules is a green read-back, not a red "will be ignored".
const RULE_EXAMPLES = [
  { label: "Odds band", text: "Only pick games where the odds on the pick are between 1.40 and 1.90." },
  { label: "Scoring form", text: "Only pick games where the home team scores at least 2.0 goals per game and the combined blend is at least 3.0." },
  { label: "Win or cover", text: "If the home win odds are at most 1.70, bet home win. Otherwise bet double chance 1X." },
];

export default function StrategyBuilder({
  userId,
  plan,
  maxLeagues,
  maxPicks,
  maxAgents,
  canLearn,
  existingCount,
  leagues,
  existing,
}: {
  userId: string;
  plan: string;
  maxLeagues: number;
  maxPicks: number;
  maxAgents: number;
  canLearn: boolean;
  existingCount: number;
  leagues: LeagueOpt[];
  existing?: ExistingStrategy;
}) {
  const router = useRouter();
  const supabase = createClient();
  const editing = !!existing;

  // when editing, reverse-map the saved market back to the right builder mode
  const initMarket = (() => {
    if (!existing) return { mode: "preset" as const, presetIdx: 1, familyIdx: 0, customText: "" };
    const pi = PRESETS.findIndex((p) => p.key === existing.market_key);
    if (pi >= 0) return { mode: "preset" as const, presetIdx: pi, familyIdx: 0, customText: "" };
    const fi = FAMILIES.findIndex((f) => f.key === existing.market_key);
    if (fi >= 0) return { mode: "family" as const, presetIdx: 1, familyIdx: fi, customText: "" };
    return { mode: "custom" as const, presetIdx: 1, familyIdx: 0, customText: existing.custom_market ?? existing.market_label ?? existing.market_key };
  })();
  const foundSel = existing ? SELECT.findIndex((s) => s.key === existing.selectivity) : -1;
  const initSelIdx = foundSel >= 0 ? foundSel : 1;

  // know whether the user has linked Telegram, so we can warn if they pick that channel unlinked
  useEffect(() => {
    (async () => {
      const { data } = await supabase.from("profiles").select("telegram_linked_at").eq("id", userId).maybeSingle();
      setTgLinked(!!data?.telegram_linked_at);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [name, setName] = useState(existing?.name ?? "Weekend Overs");
  const [mode, setMode] = useState<"preset" | "custom" | "family" | "surprise">(initMarket.mode);
  const [presetIdx, setPresetIdx] = useState(initMarket.presetIdx);
  const [familyIdx, setFamilyIdx] = useState(initMarket.familyIdx);
  const [surprisePick, setSurprisePick] = useState<{ key: string; label: string; side: string | null; line: number | null } | null>(null);
  const [customText, setCustomText] = useState(initMarket.customText);
  const [customValue, setCustomValue] = useState(existing?.bet_value ?? "");
  const [rule, setRule] = useState(existing?.rule_text ?? "");
  const [picked, setPicked] = useState<Set<number>>(new Set(existing?.league_ids ?? []));
  // "surprise" is a MODE, not a frozen pick: the engine re-rolls a fresh set of in-window leagues at
  // every run. `picked` under surprise only holds a client-side preview roll — it is NOT persisted.
  const [leagueSurprise, setLeagueSurprise] = useState<boolean>(existing?.league_mode === "surprise");
  const [lgSearch, setLgSearch] = useState("");
  const [selIdx, setSelIdx] = useState(initSelIdx);
  // snap a stored cap (e.g. legacy 15) to the largest offered pill it covers, within the plan
  const [cap, setCap] = useState(() => {
    const want = Math.min(existing?.max_per_prediction ?? 8, maxPicks);
    return PICK_CAPS.filter((c) => c <= want).pop() ?? PICK_CAPS[0];
  });
  const [time, setTime] = useState(existing?.deliver_at ? existing.deliver_at.slice(0, 5) : "06:00");
  const [target, setTarget] = useState(existing?.target_day ?? "same_day");
  // optional kickoff pin: only games starting at exactly this local time ("" = any time)
  const [kickAt, setKickAt] = useState(existing?.kickoff_at ? existing.kickoff_at.slice(0, 5) : "");
  const [channels, setChannels] = useState<Set<string>>(new Set(existing?.channels ?? ["app"]));
  const [tgLinked, setTgLinked] = useState(true); // optimistic: avoids a warning flash before we know
  const [learning, setLearning] = useState(existing?.learning ?? false);
  const [detailsOpen, setDetailsOpen] = useState(false); // mobile agent-details slide-over
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [mixNote, setMixNote] = useState<string | null>(null);
  // mixed-outcome agent: several markets in one strategy; non-empty overrides the single market
  const [mix, setMix] = useState<MixItem[]>(existing?.markets ?? []);

  const [previewN, setPreviewN] = useState<number | null>(null);
  const [previewFx, setPreviewFx] = useState<{ home_team: string; away_team: string }[]>([]);
  const [earliestKickoff, setEarliestKickoff] = useState<string | null>(null);

  const customParsed = useMemo(() => (mode === "custom" && customText.trim() ? recognizeBet(customText) : null), [mode, customText]);

  // the concrete market the strategy hunts
  const market = useMemo(() => {
    if (mode === "preset") {
      const p = PRESETS[presetIdx];
      return { key: p.key, label: p.label, side: p.side, line: p.line, period: "ft", value: null as string | null, gradeable: true, needsValue: null as null | { label: string; placeholder: string }, valueTarget: "bet_value" as "bet_value" | "side" };
    }
    if (mode === "family") {
      // a family has no fixed side/line — the agent picks the exact selection per game
      const f = FAMILIES[familyIdx];
      return { key: f.key, label: f.label, side: null as string | null, line: null as number | null, period: "ft", value: null as string | null, gradeable: true, needsValue: null as null | { label: string; placeholder: string }, valueTarget: "bet_value" as "bet_value" | "side" };
    }
    if (mode === "surprise" && surprisePick) {
      const s = surprisePick;
      return { key: s.key, label: s.label.split(" — ")[0], side: s.side, line: s.line, period: "ft", value: null as string | null, gradeable: true, needsValue: null as null | { label: string; placeholder: string }, valueTarget: "bet_value" as "bet_value" | "side" };
    }
    if (!customParsed) {
      // free text that names a whole category (e.g. "double chance", "handicap") → run it as a family
      const fam = mode === "custom" ? familyFromText(customText) : null;
      if (fam) return { key: fam.key, label: fam.label, side: null as string | null, line: null as number | null, period: "ft", value: null as string | null, gradeable: true, needsValue: null as null | { label: string; placeholder: string }, valueTarget: "bet_value" as "bet_value" | "side" };
      return null;
    }
    return {
      key: customParsed.marketKey,
      label: customParsed.label.split(" — ")[0],
      side: customParsed.side,
      line: customParsed.line,
      period: customParsed.period,
      value: customParsed.value ?? null,
      gradeable: customParsed.gradeable,
      needsValue: customParsed.needsValue ?? null,
      valueTarget: customParsed.valueTarget ?? "bet_value",
    };
  }, [mode, presetIdx, familyIdx, surprisePick, customParsed, customText]);

  // Live rule read-back: run the plain-English rule through the engine's OWN parser and show
  // exactly what it understood — a rule that mistranslates (or translates to nothing and would be
  // silently ignored) gets caught here, before the agent ever picks with it. The confirmed parse
  // is persisted on save so the engine runs precisely what the user approved.
  const [ruleParse, setRuleParse] = useState<{ text: string; baseKey: string; parsed: ParsedRule | null; heard?: string | null } | null>(
    existing?.rule_text?.trim() && existing.rule_parsed
      ? { text: existing.rule_text.trim(), baseKey: `${existing.markets?.length ? "mix" : existing.market_key}|${existing.markets?.length ? "" : existing.side ?? ""}`, parsed: existing.rule_parsed }
      : null
  );
  const [parseBusy, setParseBusy] = useState(false);
  useEffect(() => {
    const text = rule.trim();
    if (!text) { setRuleParse(null); return; }
    const base = mix.length
      ? { market_key: "mix", side: null as string | null, market_label: `Mix · ${mix.map((m) => m.label).join(" / ")}` }
      : { market_key: market?.key ?? "custom", side: market?.side ?? null, market_label: market?.label ?? "custom" };
    // cache on wording AND base market — the same words parse differently against a different
    // market ("odds" = the pick's odds), so switching market must re-run the read-back
    const baseKey = `${base.market_key}|${base.side ?? ""}`;
    if (ruleParse?.text === text && ruleParse.baseKey === baseKey) return;
    let cancelled = false;
    const timer = setTimeout(async () => {
      setParseBusy(true);
      try {
        const { data, error } = await supabase.functions.invoke("run-strategies", { body: { parse_rule: { text, ...base } } });
        if (!cancelled) setRuleParse({ text, baseKey, parsed: error ? null : ((data?.parsed as ParsedRule | null) ?? null), heard: (data?.heard as string | null) ?? null });
      } catch {
        if (!cancelled) setRuleParse({ text, baseKey, parsed: null });
      }
      if (!cancelled) setParseBusy(false);
    }, 1200);
    return () => { cancelled = true; clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rule, market?.key, market?.side, mix]);

  // Search across ALL leagues in the DB (1000+), not just the preloaded set — so typing "england"
  // finds Premier League, League One/Two, National League, etc. even though they aren't preloaded.
  const [remoteLeagues, setRemoteLeagues] = useState<LeagueOpt[] | null>(null);
  useEffect(() => {
    const t = lgSearch.trim();
    if (t.length < 2) { setRemoteLeagues(null); return; }
    let cancelled = false;
    const timer = setTimeout(async () => {
      const like = `%${t}%`;
      const { data } = await supabase
        .from("leagues")
        .select("id, name, country, flag_url, tier")
        .or(`name.ilike.${like},country.ilike.${like}`)
        .order("name", { ascending: true })
        .limit(120);
      if (!cancelled) setRemoteLeagues((data ?? []) as LeagueOpt[]);
    }, 250);
    return () => { cancelled = true; clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lgSearch]);

  // leagues that actually have fixtures in the chosen target window — the day selector filters the
  // list (and Surprise) down to these, so you only ever pick leagues that play when you deliver.
  const [activeLeagueIds, setActiveLeagueIds] = useState<Set<number> | null>(null);
  // full detail for EVERY league that plays in the window — not just the preloaded top-400. This is
  // what the list renders, so competitions like Club Friendlies (untiered, beyond the preload) show up.
  const [windowLeagues, setWindowLeagues] = useState<LeagueOpt[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    setWindowLeagues(null); // show the instant preloaded set until the window query lands
    (async () => {
      const [fromIso, toIso] = targetWindow(target);
      const { data } = await supabase
        .from("fixtures")
        .select("league_id")
        .gte("kickoff_utc", fromIso)
        .lte("kickoff_utc", toIso)
        .not("status", "in", `(${FINISHED_LIVE.join(",")})`)
        .limit(5000);
      if (cancelled) return;
      const ids = Array.from(new Set((data ?? []).map((r) => r.league_id as number).filter((x) => x != null)));
      setActiveLeagueIds(new Set(ids));
      if (!ids.length) { setWindowLeagues([]); return; }
      // pull the details for every in-window league (batched to stay under URL limits)
      const rank: Record<string, number> = { uefa: 0, top: 1, mid: 2, lower: 3 };
      const acc: LeagueOpt[] = [];
      for (let i = 0; i < ids.length; i += 300) {
        const { data: lg } = await supabase.from("leagues").select("id, name, country, flag_url, tier").in("id", ids.slice(i, i + 300));
        acc.push(...((lg ?? []) as LeagueOpt[]));
      }
      acc.sort((a, b) => (rank[a.tier ?? ""] ?? 4) - (rank[b.tier ?? ""] ?? 4) || a.name.localeCompare(b.name));
      if (!cancelled) setWindowLeagues(acc);
    })();
    return () => { cancelled = true; };
  }, [target, supabase]);

  const filteredLeagues = useMemo(() => {
    const t = lgSearch.trim().toLowerCase();
    let base: LeagueOpt[];
    if (remoteLeagues) base = remoteLeagues;                       // DB search across ALL leagues
    else if (windowLeagues) base = t ? windowLeagues.filter((l) => `${l.name} ${l.country ?? ""}`.toLowerCase().includes(t)) : windowLeagues; // every in-window league
    else base = t ? leagues.filter((l) => `${l.name} ${l.country ?? ""}`.toLowerCase().includes(t)) : leagues; // preloaded fallback until the window loads
    // scope to leagues that play in the target window, and never show an already-picked league here —
    // those live in the pinned "Selected" list so they're always removable
    const scoped = activeLeagueIds ? base.filter((l) => activeLeagueIds.has(l.id)) : base;
    return scoped.filter((l) => !picked.has(l.id));
  }, [leagues, remoteLeagues, windowLeagues, lgSearch, activeLeagueIds, picked]);

  // full detail for every league the DB knows we've loaded — used to render the pinned Selected list.
  // Picked leagues that aren't in the preloaded set (or don't play in the window) are fetched below.
  const [pickedDetails, setPickedDetails] = useState<LeagueOpt[]>([]);
  useEffect(() => {
    const known = new Set<number>([...leagues.map((l) => l.id), ...pickedDetails.map((l) => l.id)]);
    const missing = Array.from(picked).filter((id) => !known.has(id));
    if (!missing.length) return;
    let cancelled = false;
    (async () => {
      const { data } = await supabase.from("leagues").select("id, name, country, flag_url, tier").in("id", missing);
      if (!cancelled && data?.length) {
        setPickedDetails((prev) => {
          const seen = new Set(prev.map((l) => l.id));
          return [...prev, ...(data as LeagueOpt[]).filter((l) => !seen.has(l.id))];
        });
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [picked, leagues]);

  const knownById = useMemo(() => {
    const m = new Map<number, LeagueOpt>();
    for (const l of leagues) m.set(l.id, l);
    for (const l of remoteLeagues ?? []) m.set(l.id, l);
    for (const l of pickedDetails) m.set(l.id, l);
    return m;
  }, [leagues, remoteLeagues, pickedDetails]);

  // the picked leagues, always visible + removable (a placeholder name until details load)
  const selectedLeagues = useMemo(
    () => Array.from(picked).map((id) => knownById.get(id) ?? { id, name: `League #${id}`, country: null, flag_url: null, tier: null }),
    [picked, knownById]
  );

  // page the (possibly long) league list instead of hard-capping it
  const [visibleCount, setVisibleCount] = useState(80);
  useEffect(() => { setVisibleCount(80); }, [lgSearch, target, activeLeagueIds]);

  // live preview: how many upcoming fixtures the strategy would look at over the next few days
  // (the agent runs daily, so counting only the tail of today would read 0 in the evening).
  // Rule-based on leagues + the upcoming slate; edge filtering narrows this once the model lands.
  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      // mirror the engine's hunt window for the chosen target day (local time ~= the strategy tz)
      const [fromIso, toIso] = targetWindow(target);
      let q = supabase
        .from("fixtures")
        .select("home_team, away_team, kickoff_utc", { count: "exact" })
        .gte("kickoff_utc", fromIso)
        .lte("kickoff_utc", toIso)
        .not("status", "in", `(${FINISHED_LIVE.join(",")})`)
        .order("kickoff_utc", { ascending: true })
        .limit(200);
      if (picked.size) q = q.in("league_id", Array.from(picked));
      const { data, count } = await q;
      if (cancelled) return;
      // a kickoff pin filters by LOCAL start time, which the DB can't do — filter the page here
      // (the count is then "of the first 200", close enough for a preview)
      const all = (data ?? []) as { home_team: string; away_team: string; kickoff_utc: string }[];
      const inScope = kickAt
        ? all.filter((f) => new Date(f.kickoff_utc).toLocaleTimeString("en-GB", { hour12: false }).slice(0, 5) === kickAt)
        : all;
      setPreviewN(kickAt ? inScope.length : count ?? all.length);
      setPreviewFx(inScope.slice(0, 3));
      // earliest kickoff in scope — used to keep the delivery time before the first match
      setEarliestKickoff(inScope[0]?.kickoff_utc ?? null);
    };
    const id = setTimeout(run, 250);
    return () => { cancelled = true; clearTimeout(id); };
  }, [picked, target, kickAt, supabase]);

  // A same-day time that's already passed is FINE — the engine simply fires at its next chance
  // (right away if the agent hasn't run today, else tomorrow at that time). The old hard block here
  // pushed people to switch to "Tomorrow", which delivers the WRONG day's slate; now it's a note.
  const sameDayLater = useMemo<boolean>(() => {
    if (target !== "same_day") return false;
    const [hh, mm] = time.split(":").map(Number);
    if (Number.isNaN(hh)) return false;
    const now = new Date();
    const dt = new Date(now); dt.setHours(hh, mm, 0, 0);
    return dt.getTime() <= now.getTime();
  }, [target, time]);

  // keep the delivery time ahead of the first kickoff so picks arrive before the matches start
  // (skipped when today's time already passed — the delivery is tomorrow, so today's kickoff
  // doesn't constrain it)
  const deliveryWarn = useMemo<string | null>(() => {
    const [hh, mm] = time.split(":").map(Number);
    if (Number.isNaN(hh)) return null;
    if (DAY_MATCHED.has(target) && !sameDayLater && earliestKickoff) {
      const ko = new Date(earliestKickoff);
      const dt = new Date(ko); dt.setHours(hh, mm, 0, 0);
      if (dt.getTime() >= ko.getTime()) {
        const koStr = ko.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
        return `The first match kicks off at ${koStr} — set delivery earlier so picks arrive before kickoff.`;
      }
    }
    return null;
  }, [target, time, earliestKickoff, sameDayLater]);

  // Human-readable outcome label: always spells out WHICH selection was chosen (side/line/period),
  // so a mix chip is never ambiguous — "Match result (1X2)" alone doesn't tell you the pick.
  function outcomeLabel(base: string, side: string | null, line: number | null, period?: string | null): string {
    const SIDE_TXT: Record<string, string> = { home: "Home", away: "Away", draw: "Draw", yes: "Yes", no: "No", odd: "Odd", even: "Even", "1x": "Home or draw", "12": "Home or away", x2: "Draw or away" };
    let label = base;
    const low = label.toLowerCase();
    if (side === "over" || side === "under") {
      if (!(low.includes(side) && (line == null || label.includes(String(line))))) {
        label = `${label} — ${side === "over" ? "Over" : "Under"}${line != null ? ` ${line}` : ""}`;
      }
    } else if (side) {
      const t = SIDE_TXT[side] ?? side;
      if (!low.includes(t.toLowerCase())) label = `${label} — ${t}`;
    }
    if (period && period !== "ft" && !/half/i.test(label)) label = `${label} (${period === "1h" ? "1st half" : "2nd half"})`;
    return label;
  }
  // Sideless early-payout phrasings expand to BOTH team variants — "1x2 1up" means the agent
  // weighs Home 1UP vs Away 1UP per game and sends the stronger side.
  function expandOutcomes(text: string): MixItem[] | null {
    const raw = text.toLowerCase();
    if (!/\b(1x2|match result|full ?time result|result)\b/.test(raw)) return null;
    const pair = (hk: string, hl: string, ak: string, al: string): MixItem[] => [
      { market_key: hk, label: hl, side: "home", line: null, period: "ft", bet_value: null },
      { market_key: ak, label: al, side: "away", line: null, period: "ft", bet_value: null },
    ];
    if (/\b1\s*-?up\b/.test(raw)) return pair("home_win_1up", "Home 1UP", "away_win_1up", "Away 1UP");
    if (/\b2\s*-?up\b/.test(raw)) return pair("home_win_2up", "Home 2UP", "away_win_2up", "Away 2UP");
    if (/never\s*down/.test(raw)) return pair("home_win_never_down", "Home Never Down", "away_win_never_down", "Away Never Down");
    return null;
  }
  // Several outcomes typed at once in the describe box ("over 2.5, btts, home win") — recognise
  // each part so "Add to mix" can add them all in one go, with per-part feedback.
  type Seg = { text: string; ok: true; items: MixItem[] } | { text: string; ok: false; why: string };
  const customSegs = useMemo<Seg[]>(() => {
    if (mode !== "custom") return [];
    const parts = customText.split(/[,;\n]+/).map((s) => s.trim()).filter(Boolean);
    if (!parts.length) return [];
    const segs = parts.map((text): Seg => {
      const ex = expandOutcomes(text);
      if (ex) return { text, ok: true, items: ex };
      const p = recognizeBet(text);
      if (!p) return { text, ok: false, why: "not recognised" };
      if (!p.gradeable) return { text, ok: false, why: "can't be auto-graded yet" };
      if (p.needsValue) return { text, ok: false, why: `needs ${p.needsValue.label.toLowerCase().replace(/[.?]$/, "")} — add it on its own` };
      // full label (no " — " split): recognised labels like "1st half — Over 0.5 goals" already
      // spell out the whole outcome, and outcomeLabel only appends what's missing
      return {
        text, ok: true,
        items: [{ market_key: p.marketKey, label: outcomeLabel(p.label, p.side, p.line, p.period), side: p.side, line: p.line, period: p.period ?? "ft", bet_value: p.value ?? null }],
      };
    });
    // a single plain part stays in the normal single-market flow; a single EXPANDING part
    // (e.g. just "1x2 1up") still gets the multi treatment because it IS several outcomes
    if (parts.length < 2 && !(segs[0]?.ok && segs[0].items.length > 1)) return [];
    return segs;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, customText]);

  // add the currently-selected market to the mix (same side/value resolution as saving a single);
  // a comma-separated describe box adds every recognised outcome at once
  function addToMix() {
    setMsg(null); setMixNote(null);
    if (customSegs.length) {
      const skipped = customSegs.filter((s) => !s.ok).map((s) => `“${s.text}” (${(s as { why: string }).why})`);
      const items = customSegs.flatMap((s) => (s.ok ? s.items : []));
      if (!items.length) return setMsg(`Couldn't read any of those — ${skipped.join(", ")}.`);
      const next = [...mix];
      const added: string[] = [];
      for (const item of items) {
        if (next.some((m) => m.market_key === item.market_key && m.side === item.side && m.line === item.line && m.period === item.period && m.bet_value === item.bet_value)) continue;
        next.push(item); added.push(item.label);
      }
      setMix(next);
      if (added.length) setMixNote(`Added: ${added.join(" · ")}`);
      if (skipped.length) setMsg(`Skipped ${skipped.join(", ")}.`);
      else if (!added.length) setMixNote("Those outcomes are already in the mix.");
      return;
    }
    if (!market) return setMsg("Pick or describe a market first, then add it to the mix.");
    if (!market.gradeable) return setMsg("That market can't be auto-graded yet — pick a supported outcome.");
    if (mode === "family") return setMsg("Families already pick the best option per game — mix individual outcomes instead.");
    let side = market.side, value = market.value, label = market.label;
    if (market.needsValue) {
      const rawv = customValue.trim();
      if (!rawv) return setMsg(`${market.needsValue.label} (e.g. ${market.needsValue.placeholder})`);
      if (market.valueTarget === "side") {
        const sm: Record<string, string> = { home: "home", "1": "home", draw: "draw", x: "draw", away: "away", "2": "away" };
        side = sm[rawv.toLowerCase()] ?? rawv.toLowerCase();
      } else { value = rawv; label = `${label} — ${rawv}`; }
    }
    label = outcomeLabel(label, side, market.line, market.period);
    const item: MixItem = { market_key: market.key, label, side, line: market.line, period: market.period ?? "ft", bet_value: value };
    if (mix.some((m) => m.market_key === item.market_key && m.side === item.side && m.line === item.line && m.period === item.period && m.bet_value === item.bet_value)) {
      return setMsg("That outcome is already in the mix.");
    }
    setMix((xs) => [...xs, item]);
    setMixNote(`Added: ${label}`);
  }

  // surprise element — roll from the whole pool (incl. markets with no button on the page) so the
  // pick is genuinely unknown until it lands, then reveal it
  function surpriseMarket() {
    setSurprisePick(SURPRISE_POOL[Math.floor(Math.random() * SURPRISE_POOL.length)]);
    setMode("surprise");
  }
  function surpriseLeagues() {
    setMsg(null);
    // draw from the leagues that actually play in the chosen target window (prefer visible ones)
    const active = activeLeagueIds ? Array.from(activeLeagueIds) : [];
    if (!active.length) { setMsg("No leagues play in that window — try another day."); return; }
    const preloaded = new Set(leagues.map((l) => l.id));
    const visible = active.filter((id) => preloaded.has(id));
    const pool = (visible.length ? visible : active).slice();
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    const count = maxLeagues; // roll the widest net the plan allows (capped by in-window leagues)
    setPicked(new Set(pool.slice(0, count)));
    // arm surprise MODE — the roll above is just a preview; the engine re-rolls fresh each run
    setLeagueSurprise(true);
  }

  function toggleLeague(id: number) {
    // hand-picking a league means the user is taking manual control — leave surprise mode
    setLeagueSurprise(false);
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else {
        if (next.size >= maxLeagues) {
          setMsg(`Your ${plan.replace("_", " ")} plan covers ${maxLeagues} leagues. Upgrade for more.`);
          return prev;
        }
        next.add(id);
      }
      setMsg(null);
      return next;
    });
  }
  // One-tap quick picks by catalog tier: 🏆 Top Europe = every European country's TOP division
  // ('top'), 🥈 Mid tier = their second divisions ('mid'), 🌎 S. America ('sa_top') and 🌏 Asia
  // ('as_top') top flights. Each set is ordered by football-country strength so a plan's league
  // cap fills with the strongest competitions first. Tap again to remove the set.
  const EURO_RANK = ["England","Spain","Italy","Germany","France","Netherlands","Portugal","Belgium","Scotland","Turkey","Austria","Switzerland","Greece","Denmark","Norway","Sweden","Poland","Croatia","Czech-Republic","Ukraine","Russia","Romania","Serbia","Hungary","Finland","Iceland","Ireland","Wales","Northern-Ireland","Slovakia","Slovenia","Bulgaria","Israel","Cyprus"];
  const SA_RANK = ["Brazil","Argentina","Colombia","Chile","Uruguay","Ecuador","Paraguay","Peru","Bolivia","Venezuela"];
  // "South Korea" appears both with a space and a dash in the catalog
  const ASIA_RANK = ["Japan","South Korea","South-Korea","Saudi-Arabia","China","Qatar","United-Arab-Emirates","Iran","Australia","Uzbekistan","Thailand","India","Vietnam","Indonesia","Malaysia","Iraq","Bahrain","Kuwait","Jordan","Oman"];
  const tierSet = (tier: string, rank: string[]) =>
    leagues
      .filter((l) => l.tier === tier)
      .sort((a, b) => {
        const ra = rank.indexOf(a.country ?? ""), rb = rank.indexOf(b.country ?? "");
        return (ra < 0 ? 99 : ra) - (rb < 0 ? 99 : rb) || a.name.localeCompare(b.name);
      })
      .map((l) => l.id);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const topEuroIds = useMemo(() => tierSet("top", EURO_RANK), [leagues]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const midTierIds = useMemo(() => tierSet("mid", EURO_RANK), [leagues]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const saTopIds = useMemo(() => tierSet("sa_top", SA_RANK), [leagues]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const asiaTopIds = useMemo(() => tierSet("as_top", ASIA_RANK), [leagues]);
  const allPicked = (ids: number[]) => ids.length > 0 && ids.every((id) => picked.has(id));
  function toggleTierSet(ids: number[]) {
    setLeagueSurprise(false);
    setMsg(null);
    setPicked((prev) => {
      const next = new Set(prev);
      if (ids.length && ids.every((id) => next.has(id))) {
        for (const id of ids) next.delete(id);
        return next;
      }
      for (const id of ids) {
        if (next.has(id)) continue;
        if (next.size >= maxLeagues) {
          setMsg(`Your ${plan.replace("_", " ")} plan covers ${maxLeagues} leagues — added the strongest that fit.`);
          break;
        }
        next.add(id);
      }
      return next;
    });
  }
  // clear every picked league at once (also leaves surprise mode) — works even for picks that aren't
  // visible in the current window/list
  function clearLeagues() {
    setPicked(new Set());
    setLeagueSurprise(false);
    setMsg(null);
  }
  function toggleChannel(c: string) {
    setChannels((prev) => {
      const next = new Set(prev);
      if (next.has(c)) next.delete(c);
      else next.add(c);
      if (next.size === 0) next.add("app"); // always deliver somewhere
      return new Set(next);
    });
  }

  // jitter the stored delivery time by 0-5 min + random seconds so agents don't all become "due" in
  // the same cron minute (spreads run-strategies load across ticks — see scalability review)
  function jitteredDeliverAt(hhmm: string): string {
    const [h, m] = hhmm.split(":").map(Number);
    let mins = h * 60 + m + Math.floor(Math.random() * 6);
    if (mins >= 24 * 60) mins = h * 60 + m;
    const ss = String(Math.floor(Math.random() * 60)).padStart(2, "0");
    return `${String(Math.floor(mins / 60)).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}:${ss}`;
  }

  function resolveMarket(): { ok: true; row: Record<string, unknown> } | { ok: false; err: string } {
    if (!name.trim()) return { ok: false, err: "Name your agent." };
    // the agent cap only applies to NEW agents — editing an existing one doesn't add a slot
    if (!editing && existingCount >= maxAgents) return { ok: false, err: `Your ${plan.replace("_", " ")} plan allows ${maxAgents} agents. Upgrade for more.` };
    // scanning every competition (empty selection) is a Pro Max perk; capped plans must choose
    if (plan !== "pro_max" && picked.size === 0 && !leagueSurprise) return { ok: false, err: "Pick your leagues — or hit 🎲 Surprise me. Scanning every competition is a Pro Max perk." };
    if (deliveryWarn) return { ok: false, err: deliveryWarn };

    const base = {
      user_id: userId,
      name: name.trim(),
      rule_text: rule.trim() || null,
      // surprise persists NO frozen leagues — the engine re-rolls each run from that day's slate.
      // fixed persists the picks; empty-on-pro_max = "all" (scan every competition).
      league_ids: leagueSurprise ? [] : picked.size ? Array.from(picked) : [],
      league_mode: leagueSurprise ? "surprise" : picked.size ? "fixed" : "all",
      selectivity: SELECT[selIdx].key,
      min_edge: SELECT[selIdx].min_edge,
      max_per_prediction: cap,
      deliver_at: jitteredDeliverAt(time),
      target_day: target,
      kickoff_at: kickAt ? `${kickAt}:00` : null,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "Africa/Lagos",
      channels: Array.from(channels),
      learning: canLearn ? learning : false,
    };

    // a MIX overrides the single market: the engine weighs every outcome per game and sends
    // the best one (market_key 'mix'; the list itself lives in `markets`)
    if (mix.length) {
      return {
        ok: true,
        row: {
          ...base,
          market_key: "mix",
          market_label: `Mix · ${mix.length} outcome${mix.length === 1 ? "" : "s"}`,
          custom_market: null,
          side: null,
          line: null,
          period: "ft",
          bet_value: null,
          markets: mix,
        },
      };
    }

    if (!market) return { ok: false, err: "Pick a market to hunt (or describe one we recognise)." };
    if (!market.gradeable) return { ok: false, err: "That market can't be auto-graded yet — pick a preset or a supported outcome." };

    let side = market.side;
    let value = market.value;
    let label = market.label;
    if (market.needsValue) {
      const raw = customValue.trim();
      if (!raw) return { ok: false, err: `${market.needsValue.label} (e.g. ${market.needsValue.placeholder})` };
      if (market.valueTarget === "side") {
        const sm: Record<string, string> = { home: "home", "1": "home", draw: "draw", x: "draw", away: "away", "2": "away" };
        side = sm[raw.toLowerCase()] ?? raw.toLowerCase();
      } else {
        value = raw;
        label = `${label} — ${raw}`;
      }
    }
    return {
      ok: true,
      row: {
        ...base,
        market_key: market.key,
        market_label: label,
        custom_market: mode === "custom" ? customText.trim() : null,
        side,
        line: market.line,
        period: market.period,
        bet_value: value,
        markets: null,
      },
    };
  }

  async function save(status: "running" | "draft") {
    const r = resolveMarket();
    if (!r.ok) return setMsg(r.err);
    setBusy(true);
    setMsg(null);

    // Persist the CONFIRMED parse — the exact logic the read-back showed — so the engine runs
    // precisely what the user approved. An empty or unchecked parse stays null: the engine
    // re-parses on the first run rather than caching "no rule" forever.
    const ruleText = r.row.rule_text as string | null;
    // the read-back must match BOTH the wording and the market being saved — a parse made
    // against a different base market is stale (null → the engine re-parses on first run)
    const savedBaseKey = `${r.row.market_key}|${(r.row.side as string | null) ?? ""}`;
    const confirmedParse =
      ruleText && ruleParse?.text === ruleText && ruleParse.baseKey === savedBaseKey &&
      ruleParse.parsed && (ruleParse.parsed.filters.length || ruleParse.parsed.select.length)
        ? ruleParse.parsed
        : null;

    // EDIT: update in place, keep the current status, and DO NOT run now. New config applies on the
    // next scheduled run — so editing can never be used to churn out extra forecasts on demand.
    if (editing && existing) {
      const patch: Record<string, unknown> = { ...r.row };
      delete patch.user_id; // never reassign owner on edit
      // store the read-back's confirmed parse; if there isn't one and the wording changed,
      // null it so the engine re-parses (never leave a stale parse behind edited wording)
      if (confirmedParse) patch.rule_parsed = confirmedParse;
      else if ((existing.rule_text ?? null) !== ruleText) patch.rule_parsed = null;
      const { error } = await supabase.from("strategies").update(patch).eq("id", existing.id);
      setBusy(false);
      if (error) { setMsg(error.message); return; }
      router.push("/strategies");
      router.refresh();
      return;
    }

    // CREATE: insert, then run once immediately so today's picks show right away.
    const { data: strat, error } = await supabase
      .from("strategies")
      .insert({ ...r.row, rule_parsed: confirmedParse, status })
      .select("id")
      .single();
    if (error || !strat) {
      setBusy(false);
      setMsg(error?.message ?? "Couldn't save the agent.");
      return;
    }
    if (status === "running") {
      try { await supabase.functions.invoke("run-strategies", { body: { strategy_id: strat.id } }); } catch { /* scheduler will populate */ }
    }
    router.push("/strategies");
    router.refresh();
  }

  const flag = (l: LeagueOpt) =>
    l.flag_url ? (
      // eslint-disable-next-line @next/next/no-img-element
      <img src={l.flag_url} alt="" className="h-3.5 w-5 flex-none rounded-[2px] object-cover" />
    ) : (
      <span className="flex-none text-ink-mute">{l.tier === "uefa" ? "★" : "•"}</span>
    );

  const sel = SELECT[selIdx];
  const chLabel = Array.from(channels).map((c) => (c === "telegram" ? "TG" : "app")).join("+") || "—";

  // the agent summary + deploy actions — a sticky side card on desktop, a slide-over on mobile
  const preview = (
    <>
      <div className="font-mono text-[10.5px] uppercase tracking-[0.12em] text-ink-mute">Your agent · preview</div>
      <div className="mt-1 font-disp text-2xl font-extrabold tracking-tight text-ink">{name || "Untitled agent"}</div>
      <div className="mt-0.5 font-mono text-xs font-bold uppercase tracking-wide text-flood-deep">
        {mix.length ? `Mix · ${mix.map((m) => m.label).join(" / ")}` : market?.label ?? "Pick a market"}
      </div>
      {rule.trim() && <div className="mt-2 border-l-2 border-flood pl-2.5 text-[12.5px] italic text-ink-mute">“{rule.trim().length > 90 ? rule.trim().slice(0, 90) + "…" : rule.trim()}”</div>}

      <div className="my-4 flex flex-col gap-2.5 border-t border-dashed border-ink/15 pt-3.5 text-[13px]">
        <Row k="Leagues" v={leagueSurprise ? "🎲 Surprise · re-rolls each run" : picked.size === 0 ? (plan === "pro_max" ? "All competitions" : "Pick some") : `${picked.size} of ${maxLeagues}`} />
        <Row k="Selectivity" v={`${sel.name.split(" ")[0]} · ${sel.eq.replace("min edge ", "")}`} />
        <Row k="Cap" v={`${cap} / prediction`} />
        {kickAt && <Row k="Kickoff" v={`${kickAt} games only`} />}
        <Row k="Delivery" v={`${time} · ${chLabel}`} />
        <Row k="Learning" v={learning && canLearn ? "On" : "Off"} />
      </div>

      <div className="rounded-xl bg-ink p-4 text-chalk-2">
        <div className="font-mono text-[10.5px] uppercase tracking-wide text-onpitch-mute">In scope · {target === "tomorrow" ? "tomorrow" : target === "future" ? `next ${PREVIEW_DAYS} days` : "today"}</div>
        <div className="mt-1 flex items-baseline gap-2 font-disp text-3xl font-extrabold text-flood">
          {previewN ?? "—"}<span className="font-sans text-[13px] font-semibold text-chalk-2">games</span>
        </div>
        <div className="mt-3 flex flex-col gap-1.5">
          {previewFx.length ? previewFx.map((f, i) => (
            <div key={i} className="flex justify-between font-mono text-[11.5px] text-chalk-2">
              <span className="truncate">{f.home_team} v {f.away_team}</span>
            </div>
          )) : (
            <div className="font-mono text-[11px] text-onpitch-mute">No upcoming games in your leagues over the next few days — try more leagues or 🎲 Surprise me.</div>
          )}
        </div>
        <p className="mt-3 font-mono text-[10px] leading-relaxed text-onpitch-mute">Edge ranking narrows this to your bar once odds land.</p>
      </div>

      {editing ? (
        <>
          <button onClick={() => save("running")} disabled={busy} className="mt-4 w-full rounded-xl bg-flood px-4 py-3.5 font-bold text-ink transition-transform hover:-translate-y-0.5 disabled:opacity-50">
            {busy ? "Saving…" : "Save changes"}
          </button>
          <p className="mt-2 text-center font-mono text-[10px] leading-relaxed text-onpitch-mute">Applies on the next scheduled run — this won&apos;t send picks now.</p>
          <button onClick={() => router.push("/strategies")} disabled={busy} className="mt-2.5 w-full rounded-xl border border-ink/20 px-4 py-2.5 text-[13.5px] font-bold text-ink disabled:opacity-50">
            Cancel
          </button>
        </>
      ) : (
        <>
          <button onClick={() => save("running")} disabled={busy} className="mt-4 w-full rounded-xl bg-flood px-4 py-3.5 font-bold text-ink transition-transform hover:-translate-y-0.5 disabled:opacity-50">
            {busy ? "Deploying…" : "Deploy agent"}
          </button>
          <button onClick={() => save("draft")} disabled={busy} className="mt-2.5 w-full rounded-xl border border-ink/20 px-4 py-2.5 text-[13.5px] font-bold text-ink disabled:opacity-50">
            Save as draft
          </button>
        </>
      )}

      {/* free plan = a 7-day daily trial, then ~weekly — say so HERE, or the agent looks broken when
          it throttles (the single biggest "is this working?" confusion) */}
      {plan === "free" && (
        <p className="mt-3 rounded-xl bg-ink/[0.05] px-3.5 py-2.5 text-center text-[11.5px] leading-snug text-ink-mute">
          Free plan: your agent delivers <b className="text-ink">daily for your first 7 days</b>, then about <b className="text-ink">twice a week</b>.{" "}
          <Link href="/profile" className="font-bold text-ink underline decoration-ink/30 underline-offset-2 hover:decoration-ink">
            Go Pro for daily deliveries →
          </Link>
        </p>
      )}
    </>
  );

  return (
    <div className="mx-auto max-w-5xl px-5 pb-24 md:px-8">
      <StickyHeader className="-mx-5 px-5 pb-3 pt-6 md:-mx-8 md:px-8 lg:mx-0 lg:px-0">
        <MobileLogo />
        <div className="flex items-center justify-between">
          <div>
            <p className="font-mono text-[11px] uppercase tracking-[0.25em] text-flood">{editing ? "Edit agent" : "New agent"}</p>
            <h1 className="mt-2 font-disp text-3xl font-bold tracking-tight text-chalk sm:text-4xl">{editing ? "Tune your agent." : "Build your agent."}</h1>
          </div>
          <Link href="/strategies" className="font-mono text-xs text-onpitch-mute hover:text-chalk">← Back</Link>
        </div>
      </StickyHeader>
      <p className="mt-3 max-w-lg text-sm text-onpitch-mute">
        Tell it what you&apos;re hunting and where. It checks every game and only sends the ones that clear your bar — on your schedule.
      </p>

      <div className="mt-6 grid grid-cols-1 gap-4 lg:grid-cols-[1fr_320px] lg:items-start">
        <div className="flex flex-col gap-4">
          {/* 01 name */}
          <section className="rounded-2xl bg-chalk p-5 text-ink shadow-xl">
            <Step n="01" t="Name it" />
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full rounded-xl border border-ink/15 bg-white px-3.5 py-3 font-disp text-lg font-bold text-ink focus:outline focus:outline-2 focus:outline-flood"
            />
          </section>

          {/* 02 market */}
          <section className="rounded-2xl bg-chalk p-5 text-ink shadow-xl">
            <div className="mb-3.5 flex items-center gap-2.5">
              <span className="rounded-md bg-flood/15 px-1.5 py-0.5 font-mono text-[11px] font-bold text-flood-deep">02</span>
              <span className="font-disp text-[16px] font-bold text-ink">What is it hunting?</span>
              <button
                type="button"
                onClick={surpriseMarket}
                className="ml-auto rounded-md border border-ink/20 px-2 py-1 font-mono text-[10.5px] font-bold uppercase tracking-wide text-ink transition hover:border-ink/40"
              >
                🎲 Surprise me
              </button>
            </div>
            <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3">
              {PRESETS.map((p, i) => (
                <button
                  key={p.key}
                  onClick={() => { setMode("preset"); setPresetIdx(i); }}
                  className={`rounded-xl border p-3 text-left transition ${
                    mode === "preset" && presetIdx === i ? "border-flood-deep bg-flood/10 shadow-[inset_0_0_0_1px_var(--flood-deep)]" : "border-ink/15 bg-white hover:border-ink/30"
                  }`}
                >
                  <div className="text-sm font-bold text-ink">{p.label}</div>
                  <div className="mt-1 font-mono text-[10.5px] uppercase tracking-wide text-ink-mute">{p.sub}</div>
                </button>
              ))}
            </div>

            {/* families — pick a category, the agent chooses the exact bet per game */}
            <div className="mt-3 mb-2 font-mono text-[10.5px] uppercase tracking-wide text-ink-mute">Or let the agent pick the exact bet</div>
            <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3">
              {FAMILIES.map((f, i) => (
                <button
                  key={f.key}
                  onClick={() => { setMode("family"); setFamilyIdx(i); }}
                  className={`rounded-xl border p-3 text-left transition ${
                    mode === "family" && familyIdx === i ? "border-flood-deep bg-flood/10 shadow-[inset_0_0_0_1px_var(--flood-deep)]" : "border-ink/15 bg-white hover:border-ink/30"
                  }`}
                >
                  <div className="flex items-center gap-1.5 text-sm font-bold text-ink">
                    <span className="text-flood-deep">✦</span>{f.label}
                  </div>
                  <div className="mt-1 font-mono text-[10.5px] uppercase tracking-wide text-ink-mute">{f.sub}</div>
                </button>
              ))}
              <button
                onClick={() => setMode("custom")}
                className={`col-span-2 flex items-center gap-3 rounded-xl border border-dashed p-3 text-left transition sm:col-span-3 ${
                  mode === "custom" ? "border-flood-deep bg-flood/10" : "border-ink/25 bg-white hover:border-ink/40"
                }`}
              >
                <div className="text-sm font-bold text-flood-deep">✎ Something else — describe it</div>
              </button>
            </div>
            {mode === "family" && (
              <p className="mt-2.5 text-[12.5px] leading-snug text-ink-mute">
                For each game your agent prices every {FAMILIES[familyIdx].label.toLowerCase()} option and sends the one selection that clears your bar — so you don&apos;t pin the line, it does.
              </p>
            )}
            {mode === "surprise" && surprisePick && (
              <div className="mt-3 flex items-center justify-between gap-3 rounded-xl border border-flood-deep bg-flood/10 p-3.5">
                <div className="min-w-0">
                  <div className="font-mono text-[10.5px] font-bold uppercase tracking-wide text-flood-deep">🎲 The dice picked</div>
                  <div className="mt-0.5 truncate text-sm font-bold text-ink">{surprisePick.label}</div>
                </div>
                <button
                  type="button"
                  onClick={surpriseMarket}
                  className="flex-none rounded-lg border border-ink/25 px-3 py-2 font-mono text-[11px] font-bold uppercase text-ink transition hover:border-ink/50"
                >
                  Reroll
                </button>
              </div>
            )}
            {mode === "custom" && (
              <div className="mt-3">
                <input
                  value={customText}
                  onChange={(e) => setCustomText(e.target.value)}
                  placeholder="e.g. away win, over 3.5, anytime goalscorer…"
                  className="w-full rounded-xl border border-flood-deep bg-white px-3.5 py-3 text-sm font-semibold text-ink"
                />
                {customText.trim() && (
                  customSegs.length ? (
                    // comma-separated list → show exactly what each part resolved to
                    <div className="mt-2 space-y-1">
                      {customSegs.map((s, i) => (
                        <p key={i} className={`font-mono text-[11px] font-bold ${s.ok ? "text-grass-deep" : "text-brick"}`}>
                          {s.ok ? <>✓ {s.items.map((it) => it.label).join(" + ")}</> : <>✗ “{s.text}” — {s.why}</>}
                        </p>
                      ))}
                      <p className="font-mono text-[10.5px] text-ink-mute">“Add to mix” below adds every ✓ in one go.</p>
                    </div>
                  ) : customParsed?.gradeable ? (
                    <p className="mt-2 font-mono text-[11px] font-bold text-grass-deep">
                      ✓ Recognised: {market ? outcomeLabel(market.label, market.side, market.line, market.period) : ""}
                      {market?.needsValue ? " — fill the box below to complete it" : ""}
                    </p>
                  ) : customParsed ? (
                    <p className="mt-2 font-mono text-[11px] font-bold text-brick">Recognised, but not auto-gradeable yet — pick another.</p>
                  ) : familyFromText(customText) ? (
                    <p className="mt-2 font-mono text-[11px] font-bold text-grass-deep">✓ Hunting the best {familyFromText(customText)!.label} per game</p>
                  ) : (
                    <p className="mt-2 font-mono text-[11px] text-ink-mute">Not recognised yet — try a clearer market name. Tip: separate several outcomes with commas.</p>
                  )
                )}
                {market?.needsValue && (
                  <div className="mt-3">
                    <label className="mb-1 block font-mono text-[10.5px] uppercase tracking-wide text-ink-mute">{market.needsValue.label}</label>
                    <input
                      value={customValue}
                      onChange={(e) => setCustomValue(e.target.value)}
                      placeholder={market.needsValue.placeholder}
                      className="w-full rounded-xl border border-flood-deep bg-white px-3.5 py-2.5 text-sm text-ink"
                    />
                  </div>
                )}
              </div>
            )}

            {/* MIX — combine several outcomes into ONE agent (e.g. home win + home over 1.5 +
                corners + 1st-half over 0.5): per game it weighs every outcome and sends the best */}
            <div className="mt-4 border-t border-dashed border-ink/15 pt-3.5">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-[10.5px] uppercase tracking-wide text-ink-mute">Mix outcomes · optional</span>
                <button
                  type="button"
                  onClick={addToMix}
                  className="ml-auto rounded-md border border-ink/20 px-2.5 py-1.5 font-mono text-[10.5px] font-bold uppercase tracking-wide text-ink transition hover:border-ink/40"
                >
                  ＋ Add {customSegs.length
                    ? `${customSegs.reduce((n, s) => n + (s.ok ? s.items.length : 0), 0)} outcomes`
                    : market
                      ? `“${outcomeLabel(market.label, market.side, market.line, market.period)}”`
                      : "market"} to mix
                </button>
              </div>
              {mixNote && <p className="mt-2 font-mono text-[11px] font-bold text-grass-deep">{mixNote}</p>}
              {mix.length > 0 && (
                <>
                  <div className="mt-2.5 flex flex-wrap gap-2">
                    {mix.map((m, i) => (
                      <span key={`${m.market_key}:${m.side}:${m.line}:${m.period}:${m.bet_value}:${i}`} className="inline-flex items-center gap-2 rounded-full border border-flood-deep bg-flood/10 px-3 py-1.5 font-mono text-[11.5px] font-bold text-ink">
                        {m.label}
                        {m.period && m.period !== "ft" && !/half/i.test(m.label) ? ` · ${m.period === "1h" ? "1st half" : "2nd half"}` : ""}
                        <button type="button" onClick={() => setMix((xs) => xs.filter((_, j) => j !== i))} aria-label="Remove from mix" className="text-ink-mute transition-colors hover:text-brick">×</button>
                      </span>
                    ))}
                  </div>
                  <p className="mt-2 text-[12.5px] leading-snug text-ink-mute">
                    Your agent hunts <b className="text-ink">all of these</b> — for each game it weighs every outcome in the mix and sends the one that clears your bar. Remove every chip to go back to a single market.
                  </p>
                </>
              )}
            </div>
          </section>

          {/* 03 rule */}
          <section className="rounded-2xl bg-chalk p-5 text-ink shadow-xl">
            <div className="mb-3.5 flex items-center gap-2.5">
              <span className="rounded-md bg-flood/15 px-1.5 py-0.5 font-mono text-[11px] font-bold text-flood-deep">03</span>
              <span className="font-disp text-[16px] font-bold text-ink">Your rule</span>
              <span className="ml-auto rounded-md bg-ink px-2 py-1 font-mono text-[9.5px] font-bold uppercase tracking-wide text-flood">✦ AI reads this</span>
            </div>
            <textarea
              value={rule}
              onChange={(e) => setRule(e.target.value)}
              placeholder={"Write your logic in plain English — the agent applies it exactly.\n\ne.g. Back home to win. If home odds are under 1.60, take the straight win. Otherwise take double chance (home or draw)."}
              className="min-h-[96px] w-full resize-y rounded-xl border border-ink/15 bg-white p-3.5 text-sm leading-relaxed text-ink focus:outline focus:outline-2 focus:outline-flood"
            />
            {/* tap-to-insert examples: replaces the box, and the read-back below confirms it */}
            <div className="mt-2.5 flex flex-wrap items-center gap-2">
              <span className="font-mono text-[10px] uppercase tracking-wide text-ink-mute">Try:</span>
              {RULE_EXAMPLES.map((ex) => (
                <button
                  key={ex.label}
                  type="button"
                  onClick={() => setRule(ex.text)}
                  title={ex.text}
                  className="rounded-full border border-ink/15 px-2.5 py-1 font-mono text-[10.5px] font-bold text-ink-mute transition hover:border-ink/40 hover:text-ink"
                >
                  {ex.label}
                </button>
              ))}
            </div>
            <p className="mt-2.5 text-[12.5px] leading-relaxed text-ink-mute">
              Conditions, odds checks and fallbacks are understood. <b className="text-ink">“If odds &lt; 1.6 → straight win, else double chance”</b> becomes a real rule the agent runs on every game. Optional.
            </p>
            {rule.trim() && (() => {
              const pending = parseBusy || ruleParse?.text !== rule.trim();
              const failed = !pending && ruleParse?.parsed == null;
              const rb = !pending && !failed ? describeRule(ruleParse!.parsed) : null;
              return (
                <div className="mt-3 rounded-xl border border-ink/10 bg-ink/[0.03] p-3.5">
                  <div className="flex items-center gap-2 font-mono text-[10px] font-bold uppercase tracking-wide text-ink-mute">
                    <span className={`h-1.5 w-1.5 flex-none rounded-full ${pending ? "animate-pulse bg-flood motion-reduce:animate-none" : failed ? "bg-ink/30" : rb!.empty ? "bg-brick" : "bg-grass"}`} />
                    How your agent reads this
                  </div>
                  {pending ? (
                    <p className="mt-2 text-[12.5px] text-ink-mute">Reading your rule…</p>
                  ) : failed ? (
                    <p className="mt-2 text-[12.5px] leading-relaxed text-ink-mute">
                      Couldn&apos;t check this right now — the agent will read the rule on its first run.
                    </p>
                  ) : rb!.empty ? (
                    <p className="mt-2 text-[12.5px] leading-relaxed">
                      <b className="text-brick">This doesn&apos;t translate into anything the agent can act on — as written it will be ignored.</b>{" "}
                      <span className="text-ink-mute">
                        Use numbers the engine can check: odds, wins or points in the last 5, goals scored per game, the blend, model probability or edge.
                      </span>
                    </p>
                  ) : (
                    <>
                      {ruleParse?.heard && (
                        <p className="mt-2 text-[12px] italic leading-snug text-ink-mute">Heard as: “{ruleParse.heard}”</p>
                      )}
                      <ul className="mt-2 flex flex-col gap-1 text-[12.5px] leading-relaxed text-ink">
                        {rb!.lines.map((l, i) => (
                          <li key={i} className="flex gap-1.5">
                            <span className="flex-none text-ink-mute">→</span>
                            <span>{l}</span>
                          </li>
                        ))}
                      </ul>
                    </>
                  )}
                </div>
              );
            })()}
          </section>

          {/* 04 leagues */}
          <section className="rounded-2xl bg-chalk p-5 text-ink shadow-xl">
            <div className="mb-3.5 flex flex-wrap items-center gap-2.5">
              <span className="rounded-md bg-flood/15 px-1.5 py-0.5 font-mono text-[11px] font-bold text-flood-deep">04</span>
              <span className="font-disp text-[16px] font-bold text-ink">Which leagues?</span>
              <span className="font-mono text-[10.5px] text-ink-mute">{plan.replace("_", " ")} · up to {maxLeagues}</span>
              <button
                type="button"
                onClick={surpriseLeagues}
                className={`ml-auto rounded-md border px-2 py-1 font-mono text-[10.5px] font-bold uppercase tracking-wide transition ${
                  leagueSurprise ? "border-flood bg-flood/15 text-flood-deep" : "border-ink/20 text-ink hover:border-ink/40"
                }`}
              >
                🎲 {leagueSurprise ? "Surprise: on" : "Surprise me"}
              </button>
            </div>

            {leagueSurprise && (
              <div className="mb-3 rounded-lg border border-flood/30 bg-flood/[0.06] px-3 py-2 text-[12px] leading-snug text-flood-deep">
                🎲 <b>Surprise mode</b> — your agent re-rolls a fresh set of in-window leagues at every run, using the same market, outcome and selectivity. The picks below are just a preview; hand-pick any league to switch to a fixed set.
              </div>
            )}

            {/* the day selector doubles as a filter: only leagues that play in this window are shown,
                and 🎲 Surprise me draws from them. Also sets the agent's hunt window. */}
            <div className="mb-2 font-mono text-[11px] uppercase tracking-wide text-ink-mute">Which day&apos;s games</div>
            <div className="mb-1.5 flex flex-wrap gap-2">
              {TARGETS.map((t) => (
                <button
                  key={t.k}
                  type="button"
                  onClick={() => setTarget(t.k)}
                  className={`rounded-lg border px-3 py-1.5 font-mono text-[12px] font-bold transition ${
                    target === t.k ? "border-ink bg-ink text-chalk-2" : "border-ink/15 bg-white text-ink hover:border-ink/30"
                  }`}
                >
                  {t.l}
                </button>
              ))}
            </div>
            <p className="mb-3 text-[12px] leading-snug text-ink-mute">
              Showing leagues that play {TARGETS.find((t) => t.k === target)?.h}. Your agent hunts this window at each delivery.
            </p>

            {/* optional kickoff pin — only games starting at exactly this local time */}
            <div className="mb-3 flex flex-wrap items-center gap-2.5">
              <span className="font-mono text-[11px] uppercase tracking-wide text-ink-mute">⏰ Kickoff at</span>
              <input
                type="time"
                value={kickAt}
                onChange={(e) => setKickAt(e.target.value)}
                className="rounded-lg border border-ink/15 bg-white px-2.5 py-1.5 font-mono text-[12px] font-bold text-ink focus:outline focus:outline-2 focus:outline-flood"
              />
              {kickAt ? (
                <>
                  <span className="text-[12px] text-ink-mute">only games starting {kickAt} count</span>
                  <button
                    type="button"
                    onClick={() => setKickAt("")}
                    className="rounded-md border border-ink/15 px-2 py-1 font-mono text-[10.5px] font-bold uppercase text-ink-mute transition hover:border-ink/40 hover:text-ink"
                  >
                    ✕ Any time
                  </button>
                </>
              ) : (
                <span className="text-[12px] text-ink-mute">optional — leave empty for any kickoff time</span>
              )}
            </div>

            {/* one-tap region sets — each toggles its whole tier (cap-aware, strongest first) */}
            <div className="mb-3 flex flex-wrap gap-2">
              {([
                ["🏆 Top Europe", topEuroIds],
                ["🥈 Europe 2nd tier", midTierIds],
                ["🌎 S. America", saTopIds],
                ["🌏 Asia", asiaTopIds],
              ] as [string, number[]][]).map(([label, ids]) => (
                <button
                  key={label}
                  type="button"
                  onClick={() => toggleTierSet(ids)}
                  className={`rounded-lg border px-2.5 py-1.5 font-mono text-[11px] font-bold transition ${
                    allPicked(ids) ? "border-grass-deep bg-grass/15 text-grass-deep" : "border-ink/15 bg-white text-ink hover:border-ink/30"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>

            {/* pinned selected leagues — always visible + removable, even ones that don't play in the
                current window (so an edited agent's saved leagues can always be cleared) */}
            {picked.size > 0 && (
              <div className="mb-3 rounded-xl border border-grass-deep/30 bg-grass/[0.06] p-3">
                <div className="mb-2 flex items-center justify-between gap-2">
                  <span className="font-mono text-[10.5px] font-bold uppercase tracking-wide text-ink-mute">
                    Selected · {picked.size}{leagueSurprise ? " · 🎲 preview" : ` of ${maxLeagues}`}
                  </span>
                  <button type="button" onClick={clearLeagues} className="font-mono text-[11px] font-bold text-brick hover:underline">
                    Clear all
                  </button>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {selectedLeagues.map((l) => (
                    <span key={l.id} className="inline-flex items-center gap-1.5 rounded-full border border-grass-deep/40 bg-white px-2.5 py-1 text-[12px] font-semibold text-ink">
                      {flag(l)}
                      <span className="max-w-[140px] truncate">{l.name}</span>
                      <button type="button" onClick={() => toggleLeague(l.id)} aria-label={`Remove ${l.name}`} className="text-ink-mute transition-colors hover:text-brick">×</button>
                    </span>
                  ))}
                </div>
              </div>
            )}

            <input
              value={lgSearch}
              onChange={(e) => setLgSearch(e.target.value)}
              placeholder="Search leagues or countries…"
              className="mb-3 w-full rounded-xl border border-ink/15 bg-white px-3.5 py-2.5 text-sm text-ink"
            />
            <div className="no-scrollbar flex max-h-[280px] flex-col gap-1 overflow-y-auto">
              {activeLeagueIds && filteredLeagues.length === 0 && (
                <p className="px-1 py-3 font-mono text-[11px] text-ink-mute">
                  {lgSearch.trim() ? "No matching leagues play in this window." : picked.size ? "Every in-window league is already selected." : "No games loaded for this window yet — fixtures usually appear a few days out. Try Same day / Tomorrow, or check back closer to the weekend."}
                </p>
              )}
              {filteredLeagues.slice(0, visibleCount).map((l) => {
                const on = picked.has(l.id);
                return (
                  <button
                    key={l.id}
                    onClick={() => toggleLeague(l.id)}
                    className={`grid grid-cols-[1fr_auto] items-center gap-3 rounded-lg border px-2.5 py-2 text-left transition ${
                      on ? "border-grass-deep/40 bg-grass/10" : "border-transparent hover:bg-ink/[0.04]"
                    }`}
                  >
                    <div className="flex items-center gap-2.5">
                      {flag(l)}
                      <div className="min-w-0">
                        <div className="truncate text-[13.5px] font-bold text-ink">{l.name}</div>
                        <div className="truncate font-mono text-[10.5px] text-ink-mute">{l.country ?? "—"}</div>
                      </div>
                    </div>
                    <span className={`grid h-5 w-5 place-items-center rounded-md border text-[11px] ${on ? "border-grass-deep bg-grass-deep text-white" : "border-ink/25 text-transparent"}`}>✓</span>
                  </button>
                );
              })}
              {filteredLeagues.length > visibleCount && (
                <button
                  type="button"
                  onClick={() => setVisibleCount((c) => c + 80)}
                  className="mt-1 w-full rounded-lg border border-ink/15 py-2 font-mono text-[11px] font-bold text-ink transition-colors hover:border-ink/30"
                >
                  Show more ({filteredLeagues.length - visibleCount})
                </button>
              )}
            </div>
            <div className="mt-3 flex items-center justify-between font-mono text-[11px] text-ink-mute">
              <span>
                {leagueSurprise
                  ? <><b className="text-flood-deep">🎲 preview</b> · re-rolls each run</>
                  : <><b className={picked.size >= maxLeagues ? "text-brick" : "text-ink"}>{picked.size}</b> of {maxLeagues} selected</>}
              </span>
              <span className="text-flood-deep">{!leagueSurprise && picked.size === 0 ? (plan === "pro_max" ? "none = all competitions" : "pick some — or 🎲 Surprise me") : ""}</span>
            </div>
          </section>

          {/* 05 selectivity */}
          <section className="rounded-2xl bg-chalk p-5 text-ink shadow-xl">
            <Step n="05" t="How strict?" />
            <p className="mb-3 text-[13px] leading-snug text-ink-mute">
              Your agent only sends a game when our model rates it better than the bookmaker&apos;s price. This sets how much better it has to be. Stricter means fewer picks, but each one is a bigger edge.
            </p>
            <div className="flex flex-col gap-2">
              {SELECT.map((s, i) => {
                const on = selIdx === i;
                return (
                  <button
                    key={s.key}
                    type="button"
                    onClick={() => setSelIdx(i)}
                    aria-pressed={on}
                    className={`rounded-xl border p-3.5 text-left transition ${on ? "border-flood-deep bg-flood/10 shadow-[inset_0_0_0_1px_var(--flood-deep)]" : "border-ink/15 hover:border-ink/30"}`}
                  >
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="font-disp text-[16px] font-extrabold text-ink">{s.name}</span>
                      <span className="font-mono text-[11px] font-bold text-flood-deep">{s.eq}</span>
                    </div>
                    <div className="mt-1 text-[12.5px] leading-snug text-ink-mute">{s.desc}</div>
                  </button>
                );
              })}
            </div>
          </section>

          {/* 06 cap + delivery */}
          <section className="rounded-2xl bg-chalk p-5 text-ink shadow-xl">
            <Step n="06" t="Cap & delivery" />
            <div className="mb-2 font-mono text-[11px] uppercase tracking-wide text-ink-mute">Max games per prediction</div>
            <div className="flex flex-wrap gap-2">
              {PICK_CAPS.map((c) => {
                const locked = c > maxPicks;
                return (
                  <button
                    key={c}
                    disabled={locked}
                    onClick={() => setCap(c)}
                    className={`rounded-lg border px-4 py-2 font-mono text-[13px] font-bold transition ${
                      cap === c ? "border-ink bg-ink text-chalk-2" : locked ? "cursor-not-allowed border-ink/15 text-ink-mute opacity-50" : "border-ink/15 bg-white text-ink hover:border-ink/30"
                    }`}
                  >
                    {c}
                    {locked && <span className="ml-1.5 rounded bg-flood px-1 py-0.5 text-[8.5px] text-ink">{c <= 24 ? "PRO" : "MAX"}</span>}
                  </button>
                );
              })}
            </div>
            <div className="mb-2 mt-4 font-mono text-[11px] uppercase tracking-wide text-ink-mute">Deliver at · where</div>
            <div className="flex flex-wrap items-center gap-4">
              <input type="time" value={time} onChange={(e) => setTime(e.target.value)} className="rounded-lg border border-ink/15 bg-white px-3 py-2.5 font-mono text-sm text-ink" />
              <div className="flex gap-2">
                {[{ k: "app", l: "In-app" }, { k: "telegram", l: "Telegram" }].map((c) => (
                  <button
                    key={c.k}
                    onClick={() => toggleChannel(c.k)}
                    className={`rounded-lg border px-4 py-2.5 font-mono text-[12.5px] font-bold transition ${
                      channels.has(c.k) ? "border-ink bg-ink text-chalk-2" : "border-ink/15 bg-white text-ink-mute hover:border-ink/30"
                    }`}
                  >
                    {c.l}
                  </button>
                ))}
              </div>
            </div>
            {deliveryWarn ? (
              <p className="mt-2 text-[12.5px] font-semibold text-brick">{deliveryWarn}</p>
            ) : sameDayLater ? (
              <p className="mt-2 text-[12px] text-ink-mute">
                {time} already passed today — the agent runs at its next chance: right away if it
                hasn&apos;t delivered today, otherwise tomorrow at {time}.
              </p>
            ) : DAY_MATCHED.has(target) && earliestKickoff ? (
              <p className="mt-2 text-[12px] text-ink-mute">
                First match at {new Date(earliestKickoff).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} — you&apos;ll get picks before then.
              </p>
            ) : null}
            {channels.has("telegram") && !tgLinked && (
              <div className="mt-2.5">
                <p className="text-[12.5px] text-ink-mute">
                  Telegram isn&apos;t connected yet. Link it to get these picks as a DM — your agent still delivers in-app either way.
                </p>
                {/* connect right here; flips to connected on its own, then this notice clears */}
                <ConnectTelegram linked={tgLinked} onLinked={() => setTgLinked(true)} />
              </div>
            )}
          </section>

          {/* 07 learning */}
          <section className="rounded-2xl bg-chalk p-5 text-ink shadow-xl">
            <Step n="07" t="Learning" />
            <button
              disabled={!canLearn}
              onClick={() => setLearning((v) => !v)}
              className="flex w-full items-center gap-3.5 text-left disabled:opacity-60"
            >
              <span className={`relative h-[26px] w-[46px] flex-none rounded-full transition ${learning && canLearn ? "bg-grass-deep" : "bg-ink/20"}`}>
                <span className={`absolute top-[3px] h-5 w-5 rounded-full bg-white shadow transition-all ${learning && canLearn ? "left-[23px]" : "left-[3px]"}`} />
              </span>
              <span>
                <span className="text-sm font-bold text-ink">Let it learn from results {!canLearn && <span className="ml-1 rounded bg-ink px-1.5 py-0.5 font-mono text-[9px] text-flood">PRO MAX</span>}</span>
                <span className="mt-0.5 block text-[12.5px] text-ink-mute">After each matchday it tunes itself to what&apos;s landing — and tells you what&apos;s working.</span>
              </span>
            </button>
          </section>

          {msg && <p className="font-mono text-xs text-brick">{msg}</p>}
        </div>

        {/* preview: sticky side card on desktop */}
        <aside className="hidden lg:sticky lg:top-6 lg:block">
          <div className="rounded-2xl bg-chalk-2 p-5 text-ink shadow-2xl">{preview}</div>
        </aside>
      </div>

      {/* mobile: floating button opens the agent-details slide-over (with deploy inside) */}
      <button
        onClick={() => setDetailsOpen(true)}
        aria-label="Agent details"
        className="fixed bottom-[84px] right-5 z-40 grid h-14 w-14 place-items-center rounded-full bg-flood text-ink shadow-2xl transition-transform hover:-translate-y-0.5 lg:hidden"
      >
        {/* scope/crosshair — the agent is hunting games */}
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-6 w-6">
          <circle cx="12" cy="12" r="8" />
          <circle cx="12" cy="12" r="3" />
          <path d="M12 2v3M12 19v3M2 12h3M19 12h3" strokeLinecap="round" />
        </svg>
        {previewN != null && (
          <span className="absolute -right-1 -top-1 grid h-6 min-w-[24px] place-items-center rounded-full bg-ink px-1.5 font-mono text-xs font-bold text-chalk">
            {previewN}
          </span>
        )}
      </button>

      {/* mobile: agent-details as a slide-over from the right. overflow-hidden clips the off-canvas
          panel while closed (translate-x-full) so it can't bleed past the right edge and create
          horizontal scroll on mobile. */}
      <div className={`fixed inset-0 z-50 overflow-hidden lg:hidden ${detailsOpen ? "" : "pointer-events-none"}`} aria-hidden={!detailsOpen}>
        <div
          onClick={() => setDetailsOpen(false)}
          className={`absolute inset-0 bg-ink/60 transition-opacity motion-reduce:transition-none ${detailsOpen ? "opacity-100" : "opacity-0"}`}
        />
        <div
          role="dialog"
          aria-label="Agent details"
          className={`no-scrollbar absolute right-0 top-0 flex h-full w-[88%] max-w-sm flex-col overflow-y-auto bg-chalk-2 p-5 text-ink shadow-2xl transition-transform duration-300 motion-reduce:transition-none ${
            detailsOpen ? "translate-x-0" : "translate-x-full"
          }`}
        >
          <button
            onClick={() => setDetailsOpen(false)}
            aria-label="Close"
            className="mb-1 self-end grid h-9 w-9 place-items-center rounded-lg bg-ink/5 font-mono text-lg text-ink-mute"
          >
            ×
          </button>
          {preview}
        </div>
      </div>
    </div>
  );
}

function Step({ n, t, hint }: { n: string; t: string; hint?: string }) {
  return (
    <div className="mb-3.5 flex items-center gap-2.5">
      <span className="rounded-md bg-flood/15 px-1.5 py-0.5 font-mono text-[11px] font-bold text-flood-deep">{n}</span>
      <span className="font-disp text-[16px] font-bold text-ink">{t}</span>
      {hint && <span className="ml-auto font-mono text-[10.5px] text-ink-mute">{hint}</span>}
    </div>
  );
}
function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between">
      <span className="text-ink-mute">{k}</span>
      <span className="font-mono font-bold text-ink">{v}</span>
    </div>
  );
}
