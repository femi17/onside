"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { recognizeBet, recognizedFromClassification } from "@/lib/betCatalog";

// same normalisation parse-slip uses, so the alias we teach here matches next time
const norm = (s: string) => (s ?? "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();

// The vision API downscales any single image to ~1.15MP, so a tall stacked accumulator
// loses per-leg resolution and the lower legs go unread. Slice a tall screenshot into
// vertical strips (with overlap so no leg is cut in half) — parse-slip reads them as one
// slip. Short/normal images pass through untouched. Falls back to the original on any error.
async function sliceForVision(file: File): Promise<Blob[]> {
  try {
    const bmp = await createImageBitmap(file);
    const { width, height } = bmp;
    // only slice genuinely tall slips; a normal screenshot keeps enough detail as-is
    if (height / width <= 2 || height <= 1800) {
      bmp.close?.();
      return [file];
    }
    const stripH = Math.round(width * 1.5); // ~3:2 strips stay well under the 1.15MP squash
    const over = Math.round(stripH * 0.12); // overlap so a leg split across a cut is caught in both
    const step = stripH - over;
    const blobs: Blob[] = [];
    for (let y = 0; y < height && blobs.length < 8; y += step) {
      const h = Math.min(stripH, height - y);
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = h;
      const ctx = canvas.getContext("2d");
      if (!ctx) break;
      ctx.drawImage(bmp, 0, y, width, h, 0, 0, width, h);
      const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, "image/png"));
      if (blob) blobs.push(blob);
      if (h < stripH) break;
    }
    bmp.close?.();
    return blobs.length ? blobs : [file];
  } catch {
    return [file];
  }
}

type Game = { id: number; home_team: string; away_team: string; kickoff_utc: string; leagues: { name: string } | null };

type Sel = {
  home: string;
  away: string;
  league: string;
  market_key: string;
  market_label: string;
  value?: string | null;
  side?: string | null;
  line: number | null;
  confidence: "high" | "low";
  fixture_id: number | null;
  matched: string | null;
  league_name?: string | null;
  league_flag?: string | null;
  league_tier?: string | null;
  on: boolean;
};

// country flag + league name for a read selection (UEFA competitions show a cup)
function SlipLeague({ name, flag, tier }: { name?: string | null; flag?: string | null; tier?: string | null }) {
  if (!name && !flag) return null;
  return (
    <div className="mb-0.5 flex min-w-0 items-center gap-1.5 font-mono text-[10px] uppercase tracking-wide text-ink-mute">
      {tier === "uefa" ? (
        <span className="text-[11px] leading-none">🏆</span>
      ) : flag ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={flag} alt="" className="h-2.5 w-3.5 flex-none rounded-[2px] object-cover" />
      ) : (
        <span className="text-[11px] leading-none">⚽</span>
      )}
      {name && <span className="truncate">{name}</span>}
    </div>
  );
}

export default function ImportSlip({
  userId,
  plan,
  uploadsLeft,
  uploadQuota,
}: {
  userId: string;
  plan: string;
  uploadsLeft: number;
  uploadQuota: number;
}) {
  const router = useRouter();
  const supabase = createClient();
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false); // gate the portal to the client
  useEffect(() => setMounted(true), []);
  const [busy, setBusy] = useState<null | "reading" | "tracking">(null);
  const [sels, setSels] = useState<Sel[] | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  // reads consumed in this session — quota is checked server-side, but we mirror it
  // here so the UI can stop them before a call goes out (and before they get charged)
  const [readsUsed, setReadsUsed] = useState(0);
  const [ok, setOk] = useState<string | null>(null); // success line
  // inline "find game" search for a selection we couldn't auto-match
  const [findRow, setFindRow] = useState<number | null>(null);
  const [findQ, setFindQ] = useState("");
  const [findResults, setFindResults] = useState<Game[] | null>(null);
  const [finding, setFinding] = useState(false);

  // search fixtures on the spot to resolve a selection we couldn't auto-match
  useEffect(() => {
    const term = findQ.trim();
    if (findRow === null || term.length < 2) {
      setFindResults(null);
      setFinding(false);
      return;
    }
    let cancelled = false;
    setFinding(true);
    const timer = setTimeout(async () => {
      // accent-insensitive, league-aware, word-subset search (search_fixtures RPC): finds
      // "Hradec Králové" from "FC Hradec Kralove", and matches by competition name too.
      const { data } = await supabase.rpc("search_fixtures", { q: term });
      if (!cancelled) {
        const games = (data ?? []).map((r: { id: number; home_team: string; away_team: string; kickoff_utc: string; league_name: string | null }) => ({
          id: r.id,
          home_team: r.home_team,
          away_team: r.away_team,
          kickoff_utc: r.kickoff_utc,
          leagues: r.league_name ? { name: r.league_name } : null,
        }));
        setFindResults(games as Game[]);
        setFinding(false);
      }
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [findQ, findRow]);

  // user picked a fixture for an unmatched selection: attach it + teach the alias for next time
  function resolveMatch(i: number, g: Game) {
    const s = sels?.[i];
    if (!s) return;
    const rows = [
      { alias: norm(s.home), canonical: g.home_team, added_by: userId },
      { alias: norm(s.away), canonical: g.away_team, added_by: userId },
    ].filter((r) => r.alias.length >= 2);
    if (rows.length) supabase.from("team_aliases").upsert(rows, { onConflict: "alias", ignoreDuplicates: true }).then(() => {}, () => {});
    setSels((xs) => xs!.map((x, j) => (j === i ? { ...x, fixture_id: g.id, matched: `${g.home_team} v ${g.away_team}`, on: true } : x)));
    setFindRow(null);
    setFindQ("");
    setFindResults(null);
  }

  const planName = plan.replace("_", " ");
  const remaining = Math.max(0, uploadsLeft - readsUsed);
  const spentToday = uploadQuota - remaining;
  const upsell = `Your ${planName} plan reads ${uploadQuota} slip${uploadQuota === 1 ? "" : "s"} a day. Add more games by hand below, or upgrade to read more.`;

  function reset() {
    setSels(null);
    setMsg(null);
    setOk(null);
    setBusy(null);
    setFindRow(null);
    setFindQ("");
    setFindResults(null);
  }

  // a stable key so the same leg from an overlapping screenshot isn't added twice
  function keyOf(s: { home: string; away: string; market_key: string; line: number | null; fixture_id: number | null }) {
    const who = s.fixture_id ?? `${s.home.toLowerCase().trim()}|${s.away.toLowerCase().trim()}`;
    return `${who}|${s.market_key}|${s.line ?? ""}`;
  }

  // one slip can span several screenshots (a long acca) AND each screenshot can be a tall
  // strip-able image — ALL of them go up and parse-slip reads them together as ONE slip
  // (one read). This is why picking 3 screenshots now returns every leg, not just the first.
  async function readSlip(files: File[]): Promise<{ added: number; parsed: number; error?: string }> {
    try {
      const paths: string[] = [];
      for (const file of files) {
        const slices = await sliceForVision(file);
        for (const slice of slices) {
          if (paths.length >= 16) break; // hard cap so one read can't balloon the vision call
          const ext = slices.length > 1 ? "png" : file.name.split(".").pop()?.toLowerCase() || "png";
          const path = `${userId}/${crypto.randomUUID()}.${ext}`;
          const up = await supabase.storage.from("betslips").upload(path, slice);
          if (up.error) throw new Error(up.error.message);
          paths.push(path);
        }
      }
      const { data, error } = await supabase.functions.invoke("parse-slip", { body: { paths } });
      if (error) {
        // surface the function's real error body, not the generic "non-2xx" message
        let detail = error.message;
        try {
          const body = await (error as { context?: Response }).context?.json?.();
          if (body?.error) detail = body.error;
        } catch {
          /* keep generic message */
        }
        const cap = detail.match(/DAILY_UPLOAD_LIMIT:(\w+):(\d+)/);
        if (cap) {
          const plan = cap[1].replace("_", " ");
          const n = cap[2];
          detail =
            `Your ${plan} plan reads ${n} slip${n === "1" ? "" : "s"} a day. ` +
            `You can still add more games by hand from the tracker.`;
        }
        throw new Error(detail);
      }
      const parsed = (data?.selections ?? []) as Omit<Sel, "on">[];
      let added = 0;
      setSels((prev) => {
        const existing = prev ?? [];
        const seen = new Set(existing.map(keyOf));
        // it's an acca — every matched leg is on by default; the user only unticks any they
        // didn't play (unmatched legs stay off until resolved via "Find game")
        const additions = parsed
          .filter((p) => !seen.has(keyOf(p)))
          .map((p) => ({ ...p, on: !!p.fixture_id }));
        added = additions.length;
        return [...existing, ...additions];
      });
      return { added, parsed: parsed.length };
    } catch (err) {
      return { added: 0, parsed: 0, error: err instanceof Error ? err.message : "read failed" };
    }
  }

  async function onFiles(e: React.ChangeEvent<HTMLInputElement>) {
    const picked = Array.from(e.target.files ?? []);
    e.target.value = "";
    if (!picked.length) return;
    if (remaining <= 0) {
      setMsg(upsell);
      return;
    }
    setBusy("reading");
    setMsg(null);
    setOk(null);
    // ALL picked screenshots are one slip → one parse → one read (they get combined)
    const r = await readSlip(picked);
    if (!r.error) setReadsUsed((n) => n + 1);
    setBusy(null);
    // one outcome, one message: a green success or a red error — never a quota lecture
    if (r.error) setMsg(r.error);
    else if (r.parsed === 0) setMsg("Couldn't read any games from that slip. Try a clearer, full-length screenshot.");
    else if (r.added === 0) setMsg("Those games are already on your slip.");
    else setOk(`✓ Read ${r.added} game${r.added === 1 ? "" : "s"} from your slip. Track them below.`);
  }

  const chosen = (sels ?? []).filter((s) => s.on && s.fixture_id);

  async function trackChosen() {
    if (!chosen.length) {
      setMsg("Pick at least one matched game to track.");
      return;
    }
    setBusy("tracking");
    setMsg(null);
    let accumulatorId: string | null = null;
    if (chosen.length >= 2) {
      const { data: acca, error } = await supabase
        .from("accumulators")
        .insert({ user_id: userId, leg_count: chosen.length, source: "screenshot", status: "open" })
        .select("id")
        .single();
      if (error || !acca) {
        setBusy(null);
        const limit = error?.message.match(/DAILY_ACCA_LIMIT:(\w+):(\d+)/);
        setMsg(limit ? `Your ${limit[1].replace("_", " ")} plan tracks ${limit[2]} accumulator${limit[2] === "1" ? "" : "s"} a day. Upgrade for more.` : error?.message ?? "Couldn't create the accumulator.");
        return;
      }
      accumulatorId = acca.id;
    }
    const rows = [];
    for (const s of chosen) {
      // run the screenshot's label through the glossary dictionary so uploaded bets get
      // the same canonical key + auto-grading as typed ones; if the deterministic
      // recognizer can't map it, fall back to the Haiku classifier
      let rec = recognizeBet(s.market_label || "");
      if (!rec?.gradeable && s.market_key === "custom") {
        try {
          const { data } = await supabase.functions.invoke("classify-bet", { body: { text: s.market_label, source: "screenshot" } });
          if (data?.gradeable) rec = recognizedFromClassification(s.market_label || "", data);
        } catch {
          /* keep the recognizer result / custom */
        }
      }
      const key = rec?.gradeable ? rec.marketKey : s.market_key === "custom" ? "custom" : s.market_key;
      rows.push({
        user_id: userId,
        accumulator_id: accumulatorId,
        fixture_id: s.fixture_id,
        market_key: key,
        market_label: s.market_label,
        custom_market: key === "custom" ? s.market_label : null,
        line: rec?.line ?? s.line,
        // team totals come from parse-slip as home_goals_ou/away_goals_ou with a side; the label is
        // the team name so recognizeBet won't re-derive it — fall back to the parse-slip side/key.
        side: rec?.side ?? s.side ?? null,
        period: rec?.period ?? "ft",
        bet_value: rec?.value ?? s.value ?? null,
        source: "screenshot",
        status: "pending",
      });
    }
    const { error } = await supabase.from("tickets").insert(rows);
    setBusy(null);
    if (error) {
      setMsg(error.message);
      return;
    }
    // show a clear success, then take them to what they just created
    setOk(`✓ Tracked ${chosen.length} game${chosen.length === 1 ? "" : "s"}${accumulatorId ? " as an accumulator" : ""}.`);
    setTimeout(() => {
      setOpen(false);
      reset();
      router.push(accumulatorId ? "/accumulators" : "/tracker");
      router.refresh();
    }, 1100);
  }

  return (
    <>
      <div className="flex flex-col items-end gap-1">
        <button
          onClick={() => setOpen(true)}
          disabled={remaining <= 0}
          aria-label={`Upload betslip — ${remaining} read${remaining === 1 ? "" : "s"} left today`}
          title="Upload betslip"
          className="relative flex h-11 w-11 flex-none items-center justify-center rounded-xl border border-white/15 font-bold text-chalk transition-colors hover:border-white/30 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-white/15 md:h-auto md:w-auto md:px-4 md:py-3"
        >
          {/* upload icon on mobile, full-text button on desktop */}
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-5 w-5 md:hidden" aria-hidden="true">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="17 8 12 3 7 8" />
            <line x1="12" y1="3" x2="12" y2="15" />
          </svg>
          {/* remaining reads badge (mobile only — desktop shows the caption below) */}
          <span className={`absolute -right-1.5 -top-1.5 grid h-[18px] min-w-[18px] place-items-center rounded-full px-1 font-mono text-[10px] font-bold leading-none md:hidden ${remaining <= 0 ? "bg-brick text-chalk" : "bg-flood text-ink"}`}>
            {remaining}
          </span>
          <span className="hidden md:inline">Upload betslip</span>
        </button>
        <span className={`hidden font-mono text-[10px] md:block ${remaining <= 0 ? "text-flood" : "text-onpitch-mute"}`}>
          {remaining <= 0
            ? "Daily slip reads used — add by hand"
            : `${remaining} of ${uploadQuota} slip read${uploadQuota === 1 ? "" : "s"} left today`}
        </span>
      </div>

      {/* portalled to <body> so the header's sticky/backdrop-blur stacking context can't trap it
          (that was hiding the modal behind the page's search bar) */}
      {open && mounted && createPortal(
        <div className="fixed inset-0 z-[70] flex items-start justify-center overflow-y-auto p-4 sm:p-8">
          <div
            className="fixed inset-0 bg-ink/60 backdrop-blur-sm"
            onClick={() => {
              setOpen(false);
              reset();
            }}
          />
          <div className="relative z-10 w-full max-w-lg rounded-2xl bg-chalk p-5 text-ink shadow-2xl">
            <div className="flex items-start justify-between">
              <div>
                <h2 className="font-disp text-xl font-bold">Upload a betslip</h2>
                <p className="mt-1 text-[13px] text-ink-mute">
                  We read the picks and match them to games. Long slip? Upload each screenshot — we&apos;ll combine them.
                </p>
              </div>
              <button
                onClick={() => {
                  setOpen(false);
                  reset();
                }}
                aria-label="Close"
                className="flex h-8 w-8 items-center justify-center rounded-lg bg-ink/5 font-mono text-lg text-ink-mute"
              >
                ×
              </button>
            </div>

            {/* upload zone */}
            <label
              className={`mt-4 flex items-center justify-center gap-3 rounded-xl border border-dashed px-4 py-6 text-center transition-colors ${
                remaining <= 0 ? "cursor-not-allowed border-ink/15 bg-ink/[0.01] opacity-60" : "cursor-pointer border-ink/25 bg-ink/[0.02] hover:border-flood-deep"
              }`}
            >
              <input
                type="file"
                accept="image/png,image/jpeg,image/webp"
                multiple
                className="hidden"
                onChange={onFiles}
                disabled={busy !== null || remaining <= 0}
              />
              {busy === "reading" ? (
                <span className="flex flex-col items-center gap-1.5">
                  <span className="flex items-center gap-2 font-mono text-[13px] font-bold text-ink">
                    <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-ink/25 border-t-ink motion-reduce:animate-none" />
                    Reading your slips…
                  </span>
                  <span className="font-mono text-[11px] text-ink-mute">This might take a few seconds.</span>
                </span>
              ) : (
                <span className="font-mono text-[13px] text-ink-mute">
                  {remaining <= 0
                    ? "That's your slip reads for today"
                    : sels && sels.length
                      ? "＋ Add more screenshots"
                      : "Tap to choose screenshots (PNG / JPG — pick several)"}
                </span>
              )}
            </label>

            <p className="mt-2 text-center font-mono text-[10.5px] text-ink-mute">
              {remaining <= 0
                ? upsell
                : `${remaining} of ${uploadQuota} slip read${uploadQuota === 1 ? "" : "s"} left today${spentToday > 0 ? ` · ${spentToday} used` : ""}`}
            </p>

            {msg && <p className="mt-3 font-mono text-xs text-brick">{msg}</p>}
            {ok && <p className="mt-3 font-mono text-xs font-bold text-grass-deep">{ok}</p>}

            {sels && sels.length > 0 && (
              <>
                <div className="mt-4 flex items-center justify-between">
                  <span className="font-mono text-[11px] uppercase tracking-wide text-ink-mute">Select the games you played</span>
                  <span className="font-mono text-[11px] text-flood-deep">{sels.length} read</span>
                </div>
                <div className="no-scrollbar mt-2 flex max-h-[46vh] flex-col gap-2 overflow-y-auto">
                  {sels.map((s, i) => {
                    const trackable = !!s.fixture_id;
                    // matched: a toggle row you tick to include
                    if (trackable)
                      return (
                        <button
                          key={i}
                          onClick={() => setSels((xs) => xs!.map((x, j) => (j === i ? { ...x, on: !x.on } : x)))}
                          className={`flex items-center gap-3 rounded-xl border px-3 py-2.5 text-left transition-colors ${
                            s.on ? "border-flood-deep bg-flood/10" : "border-ink/15"
                          }`}
                        >
                          <span
                            className={`flex h-5 w-5 flex-none items-center justify-center rounded-md border font-mono text-xs font-bold ${
                              s.on ? "border-ink bg-ink text-chalk-2" : "border-ink/30 text-transparent"
                            }`}
                          >
                            ✓
                          </span>
                          <div className="min-w-0 flex-1">
                            <SlipLeague name={s.league_name} flag={s.league_flag} tier={s.league_tier} />
                            <div className="truncate text-sm font-bold">{s.matched}</div>
                            <div className="truncate font-mono text-[11px] font-bold uppercase text-flood-deep">{s.market_label}</div>
                          </div>
                          <span
                            className={`flex-none rounded-full px-2 py-0.5 font-mono text-[9.5px] font-bold uppercase ${
                              s.confidence === "high" ? "bg-grass/15 text-grass-deep" : "bg-flood/20 text-flood-deep"
                            }`}
                          >
                            {s.confidence === "high" ? "Read" : "Check"}
                          </span>
                        </button>
                      );
                    // unmatched: show what we read + a "Find game" search to attach a fixture
                    return (
                      <div key={i} className="rounded-xl border border-ink/15 px-3 py-2.5">
                        <div className="flex items-center gap-3">
                          <div className="min-w-0 flex-1">
                            <SlipLeague name={s.league_name} flag={s.league_flag} tier={s.league_tier} />
                            <div className="truncate text-sm font-bold">
                              {s.home} <span className="text-ink-mute">v</span> {s.away}
                            </div>
                            <div className="truncate font-mono text-[11px] font-bold uppercase text-flood-deep">{s.market_label}</div>
                          </div>
                          <button
                            onClick={() => {
                              const opening = findRow !== i;
                              setFindRow(opening ? i : null);
                              setFindQ(opening ? s.home : "");
                            }}
                            className="flex-none rounded-full bg-flood/15 px-2.5 py-1 font-mono text-[9.5px] font-bold uppercase text-flood-deep transition-colors hover:bg-flood/25"
                          >
                            {findRow === i ? "Close" : "Find game"}
                          </button>
                        </div>
                        {findRow === i && (
                          <div className="mt-2">
                            <input
                              value={findQ}
                              onChange={(e) => setFindQ(e.target.value)}
                              placeholder="Search the team or game…"
                              autoFocus
                              className="w-full rounded-lg border border-flood-deep bg-white px-3 py-2 text-sm text-ink focus:outline-none"
                            />
                            <div className="mt-1.5 flex flex-col gap-1">
                              {finding ? (
                                <p className="font-mono text-[11px] text-ink-mute">Searching…</p>
                              ) : findResults && findResults.length === 0 ? (
                                <p className="font-mono text-[11px] text-ink-mute">No games found — try another spelling.</p>
                              ) : (
                                (findResults ?? []).map((g) => (
                                  <button
                                    key={g.id}
                                    onClick={() => resolveMatch(i, g)}
                                    className="flex items-center justify-between gap-2 rounded-lg border border-ink/10 px-2.5 py-1.5 text-left transition-colors hover:border-flood-deep"
                                  >
                                    <span className="truncate text-[13px] font-semibold">
                                      {g.home_team} <span className="text-ink-mute">v</span> {g.away_team}
                                    </span>
                                    <span className="flex-none font-mono text-[10px] text-ink-mute">{g.leagues?.name ?? ""}</span>
                                  </button>
                                ))
                              )}
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>

                <button
                  disabled={busy !== null || !chosen.length}
                  onClick={trackChosen}
                  className="mt-4 w-full rounded-xl bg-ink px-4 py-3 font-bold text-chalk-2 disabled:opacity-40"
                >
                  {busy === "tracking" ? "Tracking…" : `Track ${chosen.length} game${chosen.length === 1 ? "" : "s"}`}
                </button>
              </>
            )}
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
