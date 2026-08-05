"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { matchState } from "@/lib/matchState";
import { adjustElapsed } from "@/lib/ticket";
import { useMinuteTick } from "@/lib/useMinuteTick";
import { recognizeBet, recognizedFromClassification } from "@/lib/betCatalog";

type League = { name: string; flag_url: string | null; tier: string | null };
type Game = {
  id: number;
  kickoff_utc: string;
  home_team: string;
  away_team: string;
  status: string | null;
  elapsed: number | null;
  home_goals: number | null;
  away_goals: number | null;
  extra?: number | null;
  updated_at?: string | null;
  leagues: League | null;
};
type Market = { key: string; label: string; kind: string };
type BasketItem = {
  key: string;
  fixtureId: number;
  home: string;
  away: string;
  marketKey: string;
  label: string;
  line: number | null;
  side: string | null;
  custom: string | null;
  period: string;
  value: string | null;
};

const ORDER = [
  "over_0_5",
  "over_1_5",
  "over_2_5",
  "over_3_5",
  "under_2_5",
  "under_3_5",
  "btts",
  "home_to_score",
  "away_to_score",
  "home_win",
  "draw",
  "away_win",
  "double_chance_1x",
  "double_chance_x2",
  "double_chance_12",
  "over_8_5_corners",
  "home_to_qualify",
  "away_to_qualify",
  "custom",
];
const DEFAULT_LINE: Record<string, number> = {
  over_1_5: 1.5,
  over_2_5: 2.5,
  over_8_5_corners: 8.5,
};
const SIDE: Record<string, string | null> = {
  over_0_5: "over",
  over_1_5: "over",
  over_2_5: "over",
  over_3_5: "over",
  under_2_5: "under",
  under_3_5: "under",
  btts: "yes",
  home_to_score: "home",
  away_to_score: "away",
  home_win: "home",
  draw: "draw",
  away_win: "away",
  double_chance_1x: "1x",
  double_chance_x2: "x2",
  double_chance_12: "12",
  over_8_5_corners: "over",
  home_to_qualify: "home",
  away_to_qualify: "away",
  custom: null,
};
const unit = (kind: string) => (kind === "corners" ? "corners" : "goals");
const PAGE = 10;

export default function AddGamesClient({
  games,
  markets,
  userId,
  leaguesActive = 0,
  leaguesTotal = 0,
}: {
  games: Game[];
  markets: Market[];
  userId: string;
  leaguesActive?: number;
  leaguesTotal?: number;
}) {
  const router = useRouter();
  const supabase = createClient();
  const nowMs = useMinuteTick(); // ticks live match clocks every minute

  const [q, setQ] = useState("");
  const [league, setLeague] = useState<string | null>(null);
  const [visible, setVisible] = useState(PAGE);
  const [openId, setOpenId] = useState<number | null>(null);
  const [marketKey, setMarketKey] = useState("");
  const [line, setLine] = useState("");
  const [customText, setCustomText] = useState("");
  const [customValue, setCustomValue] = useState(""); // player name / score / line for complex bets
  const [customSide, setCustomSide] = useState<string | null>(null); // Yes/No override for yes-no markets
  const [basket, setBasket] = useState<BasketItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [slipOpen, setSlipOpen] = useState(false); // mobile slip drawer
  const [remote, setRemote] = useState<Game[] | null>(null); // server-side search results
  const [searching, setSearching] = useState(false);
  const [headerH, setHeaderH] = useState(0); // page header height, so the search bar stacks under it (mobile)

  // this page is a server snapshot of fixtures; unlike the tracker it has no realtime feed,
  // so a live game's minute/score would freeze here. Re-pull every 15s so the timers stay
  // current — router.refresh() re-runs the server query but keeps your slip/search intact.
  useEffect(() => {
    const id = setInterval(() => router.refresh(), 15000);
    return () => clearInterval(id);
  }, [router]);

  // measure the (sticky) page header so the search bar can pin directly beneath it on mobile —
  // no magic numbers, survives font/viewport changes
  useEffect(() => {
    const el = document.getElementById("add-header");
    if (!el) return;
    const update = () => setHeaderH(el.offsetHeight);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    window.addEventListener("resize", update);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", update);
    };
  }, []);

  // search across ALL fixtures (global coverage) once the query is 2+ chars,
  // not just the preloaded page — so users can find any league or match
  useEffect(() => {
    const term = q.trim();
    setVisible(PAGE);
    if (term.length < 2) {
      setRemote(null);
      setSearching(false);
      return;
    }
    let cancelled = false;
    setSearching(true);
    const timer = setTimeout(async () => {
      const like = `%${term}%`;
      const nowIso = new Date().toISOString();
      const liveFloor = new Date(Date.now() - 4 * 3600 * 1000).toISOString();
      const { data: lgs } = await supabase
        .from("leagues")
        .select("id")
        .or(`name.ilike.${like},country.ilike.${like}`)
        .limit(80);
      const ids = (lgs ?? []).map((l) => l.id);
      const orMatch = [`home_team.ilike.${like}`, `away_team.ilike.${like}`];
      if (ids.length) orMatch.push(`league_id.in.(${ids.join(",")})`);
      const { data } = await supabase
        .from("fixtures")
        .select("id, kickoff_utc, home_team, away_team, status, elapsed, home_goals, away_goals, extra, updated_at, leagues(name, flag_url, tier)")
        .gte("kickoff_utc", liveFloor)
        .or(`kickoff_utc.gte.${nowIso},status.in.(1H,2H,HT,ET,BT,P,LIVE)`)
        .or(orMatch.join(","))
        .order("kickoff_utc", { ascending: true })
        .limit(60);
      if (!cancelled) {
        setRemote((data ?? []) as unknown as Game[]);
        setSearching(false);
      }
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // supabase client is stable for the component's life; re-running on q only
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  // chips = only the curated common markets; the full glossary is reachable by typing
  // in "Something else" (it auto-completes), so we don't flood the card with every market
  const orderedMarkets = useMemo(
    () => markets.filter((mk) => ORDER.includes(mk.key)).sort((a, b) => ORDER.indexOf(a.key) - ORDER.indexOf(b.key)),
    [markets]
  );
  // try to recognise free-text custom bets (1X, GG, Over 3.5…) as real markets
  const customParsed = useMemo(() => (customText.trim() ? recognizeBet(customText) : null), [customText]);
  // AI fallback: when the deterministic recognizer can't map the text, ask Haiku
  // (classify-bet) to map it against the glossary → same shape, same grade path
  const [aiParsed, setAiParsed] = useState<ReturnType<typeof recognizeBet>>(null);
  const [aiBusy, setAiBusy] = useState(false);
  useEffect(() => {
    const text = customText.trim();
    if (!text || customParsed || text.length < 3) {
      setAiParsed(null);
      setAiBusy(false);
      return;
    }
    let cancelled = false;
    setAiBusy(true);
    const timer = setTimeout(async () => {
      try {
        const { data, error } = await supabase.functions.invoke("classify-bet", { body: { text, source: "text" } });
        if (!cancelled) setAiParsed(!error && data?.market_key ? recognizedFromClassification(text, data) : null);
      } catch {
        if (!cancelled) setAiParsed(null);
      } finally {
        if (!cancelled) setAiBusy(false);
      }
    }, 500);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [customText, customParsed, supabase]);
  // the effective recognition: deterministic first, AI fallback second
  const parsedBet = customParsed ?? aiParsed;
  // when a value was lifted out of the text (a player name, a score), prefill the box
  useEffect(() => {
    if (parsedBet?.value) setCustomValue(parsedBet.value);
  }, [parsedBet?.value]);
  // one tidy row of league chips, top leagues first
  const leagueChips = useMemo(() => {
    const order = ["uefa", "top", "mid", "lower"];
    const seen = new Map<string, string | null>();
    for (const g of games) {
      const n = g.leagues?.name;
      if (n && !seen.has(n)) seen.set(n, g.leagues?.tier ?? null);
    }
    return Array.from(seen.entries())
      .map(([name, tier]) => ({ name, tier }))
      .sort(
        (a, b) =>
          order.indexOf(a.tier ?? "lower") - order.indexOf(b.tier ?? "lower") || a.name.localeCompare(b.name)
      )
      .slice(0, 5); // top 5 leagues only — keep it to one tidy row
  }, [games]);
  const filtered = useMemo(() => {
    // remote = global search results (already matched server-side); else the preloaded page
    if (remote) return league ? remote.filter((g) => g.leagues?.name === league) : remote;
    const t = q.trim().toLowerCase();
    return games.filter((g) => {
      if (league && g.leagues?.name !== league) return false;
      if (
        t &&
        !`${g.home_team} ${g.away_team} ${g.leagues?.name ?? ""}`
          .toLowerCase()
          .includes(t)
      )
        return false;
      return true;
    });
  }, [games, remote, q, league]);
  const shown = filtered.slice(0, visible);

  function openGame(id: number) {
    setOpenId(openId === id ? null : id);
    setMarketKey("");
    setLine("");
    setCustomText("");
    setCustomValue("");
    setMsg(null);
  }
  function pickMarket(k: string) {
    setMarketKey(k);
    setLine(DEFAULT_LINE[k] != null ? String(DEFAULT_LINE[k]) : "");
  }

  function addToSlip(g: Game) {
    const m = orderedMarkets.find((x) => x.key === marketKey);
    if (!m) return;

    let key = m.key;
    let label: string;
    let ln: number | null = null;
    let side: string | null = SIDE[m.key] ?? null;
    let custom: string | null = null;
    let period = "ft";
    let value: string | null = null;

    if (m.key === "custom") {
      const text = customText.trim();
      if (!text) {
        setMsg("Describe the outcome you bet.");
        return;
      }
      if (parsedBet) {
        // recognised against the glossary dictionary (deterministic or AI) — carry the canonical key + params
        key = parsedBet.marketKey;
        ln = parsedBet.line;
        side = parsedBet.side;
        period = parsedBet.period;
        const base = parsedBet.label.split(" — ")[0];
        if (parsedBet.needsValue) {
          const raw = customValue.trim();
          if (!raw) {
            setMsg(`${parsedBet.needsValue.label} (e.g. ${parsedBet.needsValue.placeholder})`);
            return;
          }
          if (parsedBet.valueTarget === "side") {
            // the collected value IS the pick (e.g. handicap Home/Draw/Away); keep any
            // recognised value (the handicap line) in bet_value for grading
            const sm: Record<string, string> = { home: "home", "1": "home", draw: "draw", x: "draw", away: "away", "2": "away" };
            side = sm[raw.toLowerCase()] ?? raw.toLowerCase();
            value = parsedBet.value ?? null;
            label = `${base} — ${side}`;
          } else {
            value = raw;
            label = `${base} — ${raw}`;
          }
        } else {
          value = parsedBet.value ?? null;
          label = parsedBet.label;
          // Yes/No markets: honour the user's toggle over the recognised default
          if (parsedBet.side === "yes" || parsedBet.side === "no") {
            side = customSide ?? parsedBet.side;
            const base = parsedBet.label.split(" — ")[0];
            label = side === "no" ? `${base} — No` : base;
          }
        }
        // markets we can't grade yet stay "custom" and keep their label for manual settle
        if (!parsedBet.gradeable) {
          key = "custom";
          custom = label;
        }
      } else {
        // genuinely free text — keep it for manual settle
        label = text;
        custom = text;
      }
    } else {
      const isLine = DEFAULT_LINE[m.key] != null;
      ln = isLine ? Number(line || DEFAULT_LINE[m.key]) : null;
      label = isLine ? `Over ${ln} ${unit(m.kind)}` : m.label;
    }

    const slipKey = `${g.id}:${key}:${ln ?? ""}:${label}`;
    if (basket.some((b) => b.key === slipKey)) {
      setOpenId(null);
      return;
    }
    setBasket((b) => [
      ...b,
      { key: slipKey, fixtureId: g.id, home: g.home_team, away: g.away_team, marketKey: key, label, line: ln, side, custom, period, value },
    ]);
    setOpenId(null);
  }

  async function trackAll() {
    if (!basket.length) return;
    setBusy(true);
    setMsg(null);

    // don't re-track a bet you already have live/pending — same fixture + market + side + line.
    // (different markets on the same game are fine.)
    const dupKey = (fixtureId: number | null | undefined, mk: string | null | undefined, side: string | null | undefined, line: number | null | undefined) =>
      `${fixtureId}:${mk ?? ""}:${side ?? ""}:${line ?? ""}`;
    const fixtureIds = Array.from(new Set(basket.map((b) => b.fixtureId)));
    const { data: existing } = await supabase
      .from("tickets")
      .select("fixture_id, market_key, side, line")
      .eq("user_id", userId)
      .in("status", ["pending", "live"])
      .in("fixture_id", fixtureIds);
    const taken = new Set((existing ?? []).map((r) => dupKey(r.fixture_id as number, r.market_key as string, r.side as string, r.line as number)));
    const fresh = basket.filter((b) => !taken.has(dupKey(b.fixtureId, b.marketKey, b.side, b.line)));
    const skipped = basket.length - fresh.length;
    if (fresh.length === 0) {
      setBusy(false);
      setMsg("You're already tracking these bets.");
      setBasket([]);
      return;
    }

    // manual picks are always standalone bets — accumulators are only built from an uploaded
    // slip (ImportSlip), so hand-picked games never group into an acca
    const rows = fresh.map((b) => ({
      user_id: userId,
      accumulator_id: null,
      fixture_id: b.fixtureId,
      market_key: b.marketKey,
      market_label: b.label,
      custom_market: b.custom,
      line: b.line,
      side: b.side,
      period: b.period,
      bet_value: b.value,
      source: "manual",
      status: "pending",
    }));
    const { error } = await supabase.from("tickets").insert(rows);
    setBusy(false);
    if (error) {
      setMsg(error.message);
      return;
    }
    if (skipped > 0) setMsg(`Tracked ${fresh.length}; skipped ${skipped} already on your tracker.`);
    router.push("/tracker");
    router.refresh();
  }

  const inBasket = (id: number) => basket.some((b) => b.fixtureId === id);

  // slip body shared by the desktop side-card and the mobile drawer
  const slip = (
    <>
      {basket.length === 0 ? (
        <p className="mt-3 text-[13px] text-ink-mute">
          Pick games and markets — they collect here, then you track them all in one tap.
        </p>
      ) : (
        <div className="no-scrollbar mt-3 flex flex-1 flex-col gap-2 overflow-y-auto lg:max-h-[320px] lg:flex-none">
          {basket.map((b) => (
            <div key={b.key} className="flex items-start gap-2 rounded-lg border border-ink/10 px-3 py-2">
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13px] font-bold">
                  {b.home} <span className="text-ink-mute">v</span> {b.away}
                </div>
                <div className="font-mono text-[10.5px] font-bold uppercase text-flood-deep">{b.label}</div>
              </div>
              <button
                onClick={() => setBasket((x) => x.filter((i) => i.key !== b.key))}
                className="font-mono text-ink-mute hover:text-brick"
                aria-label="Remove from slip"
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}

      {msg && <p className="mt-3 font-mono text-xs text-brick">{msg}</p>}

      <button
        disabled={!basket.length || busy}
        onClick={trackAll}
        className="mt-4 w-full shrink-0 rounded-xl bg-flood px-4 py-3 font-bold text-ink disabled:opacity-40"
      >
        {busy ? "Tracking…" : basket.length ? `Track ${basket.length} bet${basket.length === 1 ? "" : "s"}` : "Track"}
      </button>
    </>
  );

  return (
    <>
    <div className="flex flex-col gap-6 pb-6 lg:grid lg:min-h-0 lg:flex-1 lg:grid-cols-[1fr_290px] lg:items-stretch lg:pb-0">
      {/* ---- game list ---- */}
      <div className="flex min-w-0 flex-col lg:min-h-0">
        {/* mobile: this block pins directly BELOW the sticky page header (top = measured header
            height) so the whole header stays fixed while the list scrolls; on desktop the list
            scrolls in its own pane, so it naturally stays put */}
        <div style={{ top: headerH }} className="sticky z-20 -mx-5 bg-pitch/80 px-5 pb-2 pt-1 backdrop-blur lg:static lg:top-auto lg:mx-0 lg:bg-transparent lg:px-0 lg:pt-0 lg:pb-0 lg:backdrop-blur-none">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search a team or league…"
          className="w-full shrink-0 rounded-xl border border-white/15 bg-pitch-2 px-4 py-3 text-chalk placeholder:text-onpitch-mute focus:outline-none focus:ring-2 focus:ring-flood"
        />
        {leagueChips.length > 1 && (
          <div className="no-scrollbar mt-3 flex shrink-0 gap-2 overflow-x-auto">
            <button
              onClick={() => setLeague(null)}
              className={`flex-none whitespace-nowrap rounded-full border px-3 py-1.5 font-mono text-[11px] ${
                league === null ? "border-flood bg-flood text-ink" : "border-white/15 text-onpitch-mute"
              }`}
            >
              All
            </button>
            {leagueChips.map((l) => (
              <button
                key={l.name}
                onClick={() => setLeague(l.name)}
                className={`flex-none whitespace-nowrap rounded-full border px-3 py-1.5 font-mono text-[11px] ${
                  league === l.name ? "border-flood bg-flood text-ink" : "border-white/15 text-onpitch-mute"
                }`}
              >
                {l.name}
              </button>
            ))}
          </div>
        )}

        <p className="mt-4 shrink-0 font-mono text-[11px] text-onpitch-mute">
          {searching
            ? "Searching all competitions…"
            : q || league
              ? `${filtered.length} game${filtered.length === 1 ? "" : "s"}`
              : `${leaguesActive}/${leaguesTotal} leagues with games today`}
        </p>
        </div>

        <div className="no-scrollbar mt-2 flex flex-col gap-2.5 lg:min-h-0 lg:flex-1 lg:overflow-y-auto">
          {shown.map((g) => {
            const open = openId === g.id;
            const m = orderedMarkets.find((x) => x.key === marketKey);
            const isLine = m ? DEFAULT_LINE[m.key] != null : false;
            const picked = inBasket(g.id);
            const st = matchState(
              g.status,
              adjustElapsed(g.status, g.elapsed, g.updated_at, nowMs),
              g.extra ?? null,
              g.home_goals,
              g.away_goals,
              g.kickoff_utc
            );
            return (
              <div key={g.id} className="rounded-xl bg-chalk text-ink shadow-lg">
                <button
                  onClick={() => openGame(g.id)}
                  className="flex w-full items-center gap-3 px-4 py-3 text-left"
                >
                  <span className="flex h-8 w-8 flex-none items-center justify-center overflow-hidden rounded-lg bg-ink/5 text-lg">
                    {/* UEFA competitions get the cup; domestic leagues show their country flag */}
                    {g.leagues?.tier === "uefa" ? (
                      "🏆"
                    ) : g.leagues?.flag_url ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={g.leagues.flag_url} alt="" className="h-full w-full object-cover" />
                    ) : (
                      "⚽"
                    )}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-bold leading-tight">
                      {g.home_team} <span className="text-ink-mute">v</span>{" "}
                      {g.away_team}
                    </div>
                    <div className="flex items-center gap-1.5 font-mono text-[11px] text-ink-mute">
                      {g.leagues?.name ?? ""} ·{" "}
                      {st.phase === "live" ? (
                        <span className="font-bold text-flood-deep">{st.label}</span>
                      ) : (
                        st.label
                      )}
                    </div>
                  </div>
                  {st.phase === "live" && st.score && (
                    <span className="font-mono text-sm font-bold text-flood-deep">
                      {st.score}
                    </span>
                  )}
                  {picked ? (
                    <span className="font-mono text-[11px] font-bold text-grass-deep">
                      on slip
                    </span>
                  ) : (
                    <span className="font-mono text-lg text-flood-deep">
                      {open ? "×" : "+"}
                    </span>
                  )}
                </button>

                {open && (
                  <div className="border-t border-dashed border-ink/15 px-4 py-4">
                    <p className="mb-2 font-mono text-[10.5px] uppercase tracking-wide text-ink-mute">
                      What did you bet?
                    </p>
                    <div className="flex flex-wrap gap-2">
                      {orderedMarkets.map((mk) => (
                        <button
                          key={mk.key}
                          onClick={() => pickMarket(mk.key)}
                          className={`rounded-lg border px-3 py-1.5 text-[13px] font-semibold ${
                            marketKey === mk.key
                              ? "border-flood-deep bg-flood/15 text-ink"
                              : "border-ink/15 text-ink"
                          }`}
                        >
                          {mk.key === "custom" ? "✎ Something else" : mk.label}
                        </button>
                      ))}
                    </div>

                    {marketKey && marketKey !== "custom" && isLine && (
                      <div className="mt-3 flex items-center gap-2">
                        <span className="font-mono text-[12px] text-ink-mute">Line</span>
                        <input
                          type="number"
                          step="0.5"
                          value={line}
                          onChange={(e) => setLine(e.target.value)}
                          className="w-24 rounded-lg border border-ink/20 bg-white px-3 py-2 font-mono text-sm text-ink"
                        />
                      </div>
                    )}
                    {marketKey === "custom" && (
                      <>
                        <input
                          value={customText}
                          onChange={(e) => {
                            setCustomText(e.target.value);
                            setCustomSide(null); // a new bet resets any Yes/No pick
                          }}
                          placeholder="e.g. 1X, GG, Over 3.5, away to score…"
                          className="mt-3 w-full rounded-lg border border-flood-deep bg-white px-3 py-2 text-sm text-ink"
                        />
                        {customText.trim() &&
                          (parsedBet?.gradeable ? (
                            <p className="mt-2 font-mono text-[11px] font-bold text-grass-deep">
                              ✓ Auto-tracked as {parsedBet.label.split(" — ")[0]}
                              {parsedBet.side === "yes" || parsedBet.side === "no"
                                ? ` — ${(customSide ?? parsedBet.side) === "no" ? "No" : "Yes"}`
                                : ""}
                              {!customParsed && aiParsed ? " · AI" : ""}
                            </p>
                          ) : parsedBet ? (
                            <p className="mt-2 font-mono text-[11px] font-bold text-flood-deep">
                              ✓ Recognised as {parsedBet.label.split(" — ")[0]} — you&apos;ll mark the result
                            </p>
                          ) : aiBusy ? (
                            <p className="mt-2 font-mono text-[11px] text-ink-mute">Checking the glossary…</p>
                          ) : (
                            <p className="mt-2 font-mono text-[11px] text-ink-mute">
                              We&apos;ll track this manually — you&apos;ll mark the result.
                            </p>
                          ))}

                        {/* Yes/No markets (GG 2+, N in a row, lead by N…): let the user pick a side */}
                        {parsedBet?.gradeable && (parsedBet.side === "yes" || parsedBet.side === "no") && (
                          <div className="mt-2.5">
                            <label className="mb-1 block font-mono text-[10.5px] uppercase tracking-wide text-ink-mute">Your pick</label>
                            <div className="flex gap-2">
                              {(["yes", "no"] as const).map((s) => {
                                const active = (customSide ?? parsedBet.side) === s;
                                return (
                                  <button
                                    key={s}
                                    type="button"
                                    onClick={() => setCustomSide(s)}
                                    className={`flex-1 rounded-lg border px-3 py-2 font-mono text-xs font-bold uppercase transition-colors ${
                                      active ? "border-ink bg-ink text-chalk" : "border-ink/25 text-ink hover:border-ink/50"
                                    }`}
                                  >
                                    {s === "yes" ? "Yes" : "No"}
                                  </button>
                                );
                              })}
                            </div>
                          </div>
                        )}

                        {parsedBet?.needsValue && (
                          <div className="mt-3">
                            <label className="mb-1 block font-mono text-[10.5px] uppercase tracking-wide text-ink-mute">
                              {parsedBet.needsValue.label}
                            </label>
                            <input
                              value={customValue}
                              onChange={(e) => setCustomValue(e.target.value)}
                              placeholder={parsedBet.needsValue.placeholder}
                              className="w-full rounded-lg border border-flood-deep bg-white px-3 py-2 text-sm text-ink"
                            />
                          </div>
                        )}
                      </>
                    )}

                    <button
                      disabled={!marketKey}
                      onClick={() => addToSlip(g)}
                      className="mt-4 rounded-lg bg-ink px-4 py-2.5 text-sm font-bold text-chalk disabled:opacity-40"
                    >
                      Add to slip
                    </button>
                  </div>
                )}
              </div>
            );
          })}

          {filtered.length > visible && (
            <button
              onClick={() => setVisible((v) => v + PAGE)}
              className="mt-2.5 w-full rounded-xl border border-white/15 py-3 font-semibold text-onpitch-mute hover:text-chalk"
            >
              Show more games
            </button>
          )}
        </div>
      </div>

      {/* ---- slip basket: side card on desktop ---- */}
      <aside className="hidden lg:block">
        <div className="rounded-2xl bg-chalk-2 p-4 text-ink shadow-xl">
          <div className="flex items-center justify-between">
            <span className="font-disp text-lg font-extrabold">Your slip</span>
            <span className="font-mono text-sm font-bold text-flood-deep">{basket.length}</span>
          </div>
          {slip}
        </div>
      </aside>
    </div>

      {/* ---- mobile: floating slip button (badged with the count) opens the slip drawer, so it
              never overlaps the "Show more games" control at the foot of the list ---- */}
      {basket.length > 0 && (
        <button
          onClick={() => setSlipOpen(true)}
          aria-label={`Review slip — ${basket.length} bet${basket.length === 1 ? "" : "s"}`}
          className="fixed bottom-[84px] right-5 z-40 grid h-14 w-14 place-items-center rounded-full bg-flood text-ink shadow-2xl transition-transform hover:-translate-y-0.5 lg:hidden"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-6 w-6">
            <path d="M6 3h12a1 1 0 0 1 1 1v16l-2.5-1.5L14 20l-2-1.5L10 20l-2.5-1.5L5 20V4a1 1 0 0 1 1-1Z" strokeLinejoin="round" />
            <path d="M9 8h6M9 12h6" strokeLinecap="round" />
          </svg>
          <span className="absolute -right-1 -top-1 grid h-6 min-w-[24px] place-items-center rounded-full bg-ink px-1.5 font-mono text-xs font-bold text-chalk">
            {basket.length}
          </span>
        </button>
      )}

      {/* ---- mobile: slip as a slide-over from the right ---- */}
      <div className={`fixed inset-0 z-50 lg:hidden ${slipOpen ? "" : "pointer-events-none"}`} aria-hidden={!slipOpen}>
        <div
          onClick={() => setSlipOpen(false)}
          className={`absolute inset-0 bg-ink/60 transition-opacity motion-reduce:transition-none ${
            slipOpen ? "opacity-100" : "opacity-0"
          }`}
        />
        <div
          role="dialog"
          aria-label="Your slip"
          className={`absolute right-0 top-0 flex h-full w-[86%] max-w-sm flex-col bg-chalk-2 p-4 text-ink shadow-2xl transition-transform duration-300 motion-reduce:transition-none ${
            slipOpen ? "translate-x-0" : "translate-x-full"
          }`}
        >
          <div className="mb-1 flex items-center justify-between">
            <span className="font-disp text-lg font-extrabold">
              Your slip <span className="font-mono text-sm text-flood-deep">{basket.length}</span>
            </span>
            <button
              onClick={() => setSlipOpen(false)}
              aria-label="Close slip"
              className="flex h-9 w-9 items-center justify-center rounded-lg bg-ink/5 font-mono text-lg text-ink-mute"
            >
              ×
            </button>
          </div>
          {slip}
        </div>
      </div>
    </>
  );
}
