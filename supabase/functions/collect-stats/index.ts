// Historical match-stats collector: fills fixture_stats for FINISHED fixtures so run-strategies
// can model corners/cards markets with real per-team rates. Since 2026-08-29 it also KEEPS the
// xG / shots / possession numbers that were always in the same response but were being discarded
// (zero extra API calls) — accumulating the history the future xG-based ratings model needs.
// The live poll only captures stats for games someone tracked; this backfills everything else,
// newest first.
// API-Football returns full statistics for up to 20 fixtures per call (/fixtures?ids=a-b-c...), so
// a 60-call daily run covers ~1200 fixtures — comfortably more than a day's finished matches.
// Fixtures whose provider has no stats get a {"no_stats":true} marker row so they're attempted once.
// Invoke: POST {} (cron; 60 calls, 3-day window) or { max_calls, days_back } for seeding.
//
// XG BACKFILL MODE — POST { task: "xg", max_calls, days_back }: targets fixtures MISSING xG in
// delivery leagues (xg_backfill_candidates, yield-ordered) and MERGES what it finds into existing
// rows via merge_fixture_stats (stats || new; corners columns filled only when null) — the normal
// mode's never-clobber upsert skips existing rows, which is right for live snapshots but would
// leave every already-collected fixture xG-less forever. Probed-but-barren games get a no_xg
// marker so they're attempted once. Finished fixtures only, so merging finals is always safe.
import { createClient } from "npm:@supabase/supabase-js@2";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_KEY = Deno.env.get("SUPABASE_SECRET_KEY") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const sb = createClient(SB_URL, SB_KEY);

function json(b: unknown, s = 200) { return new Response(JSON.stringify(b), { status: s, headers: { "Content-Type": "application/json" } }); }
async function getSecret(name: string): Promise<string> {
  const { data, error } = await sb.rpc("get_secret", { secret_name: name });
  if (error || !data) throw new Error(`secret ${name}`);
  return data as string;
}

const statVal = (side: any, type: string): number | null => {
  const v = (side?.statistics ?? []).find((s: any) => s.type === type)?.value;
  if (v == null) return null;
  // xG arrives as a string ("1.33"), possession as "52%" — normalise both to a number
  const n = typeof v === "string" ? Number(v.replace("%", "")) : Number(v);
  return Number.isFinite(n) ? n : null;
};

// Extra per-team stats worth keeping (same name -> [home, away] map format the live poll writes).
// expected_goals is the headline: the future xG-ratings model needs this history accumulating NOW.
const EXTRA_STATS = ["expected_goals", "Total Shots", "Shots on Goal", "Shots insidebox", "Ball Possession"] as const;

// xG backfill pass: batch-fetch, then MERGE stat keys into rows that may already exist.
async function runXg(ids: number[], key: string, maxCalls: number): Promise<Response> {
  let calls = 0, processed = 0, withXg = 0;
  for (let i = 0; i < ids.length && calls < maxCalls; i += 20) {
    const batch = ids.slice(i, i + 20);
    calls++;
    let items: any[] = [];
    try {
      const res = await fetch(`https://v3.football.api-sports.io/fixtures?ids=${batch.join("-")}`, { headers: { "x-apisports-key": key } });
      await sb.rpc("bump_api_usage");
      const body = await res.json();
      items = body?.response ?? [];
    } catch { continue; }

    const got = new Set<number>();
    const rows: any[] = [];
    for (const it of items) {
      const fid = it?.fixture?.id;
      if (fid == null) continue;
      got.add(Number(fid));
      const st = it?.statistics ?? [];
      const home = st.find((s: any) => s?.team?.id === it?.teams?.home?.id);
      const away = st.find((s: any) => s?.team?.id === it?.teams?.away?.id);
      const stats: Record<string, unknown> = {};
      for (const t of EXTRA_STATS) {
        const h = statVal(home, t), a = statVal(away, t);
        if (h != null || a != null) stats[t] = [h ?? 0, a ?? 0];
      }
      // cards ride along too — final numbers for a finished game, safe to (re)merge
      const yh = statVal(home, "Yellow Cards"), ya = statVal(away, "Yellow Cards");
      if (yh != null || ya != null) {
        stats["Yellow Cards"] = [yh ?? 0, ya ?? 0];
        stats["Red Cards"] = [statVal(home, "Red Cards") ?? 0, statVal(away, "Red Cards") ?? 0];
      }
      if (stats["expected_goals"]) withXg++;
      else stats["no_xg"] = true; // probed, provider has no xG here — never re-probe
      const ch = statVal(home, "Corner Kicks"), ca = statVal(away, "Corner Kicks");
      rows.push({ fixture_id: fid, corners_home: ch, corners_away: ca, stats });
    }
    // fixtures the provider didn't return: mark probed so the queue drains
    for (const fid of batch) if (!got.has(fid)) rows.push({ fixture_id: fid, stats: { no_xg: true } });
    if (rows.length) {
      const { data: n, error } = await sb.rpc("merge_fixture_stats", { p_rows: rows });
      if (!error) processed += Number(n ?? 0);
    }
  }
  return json({ task: "xg", calls, processed, with_xg: withXg });
}

Deno.serve(async (req) => {
  try {
    let maxCalls = 60, daysBack = 3, task = "corners";
    try {
      const b = await req.json();
      if (b?.max_calls) maxCalls = Math.min(200, Number(b.max_calls));
      if (b?.days_back) daysBack = Math.min(400, Number(b.days_back)); // xg backfill reaches a full season back
      if (b?.task === "xg") task = "xg";
    } catch { /* cron */ }

    const since = new Date(Date.now() - daysBack * 86400000).toISOString();
    const { data: cand, error } = await sb.rpc(
      task === "xg" ? "xg_backfill_candidates" : "stats_backfill_candidates",
      { p_since: since, p_limit: maxCalls * 20 },
    );
    if (error) return json({ error: error.message }, 500);
    const ids: number[] = (cand ?? []).map((r: any) => Number(r.id ?? r));
    if (!ids.length) return json({ task, calls: 0, processed: 0, with_corners: 0 });

    const key = await getSecret("api_football_key");
    if (task === "xg") return await runXg(ids, key, maxCalls);
    let calls = 0, processed = 0, withCorners = 0;
    for (let i = 0; i < ids.length && calls < maxCalls; i += 20) {
      const batch = ids.slice(i, i + 20);
      calls++;
      let items: any[] = [];
      try {
        const res = await fetch(`https://v3.football.api-sports.io/fixtures?ids=${batch.join("-")}`, { headers: { "x-apisports-key": key } });
        await sb.rpc("bump_api_usage");
        const body = await res.json();
        items = body?.response ?? [];
      } catch { continue; }

      const got = new Set<number>();
      const rows: any[] = [];
      for (const it of items) {
        const fid = it?.fixture?.id;
        if (fid == null) continue;
        got.add(Number(fid));
        const st = it?.statistics ?? [];
        const home = st.find((s: any) => s?.team?.id === it?.teams?.home?.id);
        const away = st.find((s: any) => s?.team?.id === it?.teams?.away?.id);
        const ch = statVal(home, "Corner Kicks"), ca = statVal(away, "Corner Kicks");
        const yh = statVal(home, "Yellow Cards") ?? 0, ya = statVal(away, "Yellow Cards") ?? 0;
        const rh = statVal(home, "Red Cards") ?? 0, ra = statVal(away, "Red Cards") ?? 0;
        const hasCards = statVal(home, "Yellow Cards") != null || statVal(away, "Yellow Cards") != null;
        // the xG / shots / possession keys, only when the provider actually has them
        const extra: Record<string, [number, number]> = {};
        for (const t of EXTRA_STATS) {
          const h = statVal(home, t), a = statVal(away, t);
          if (h != null || a != null) extra[t] = [h ?? 0, a ?? 0];
        }
        const hasExtra = Object.keys(extra).length > 0;
        if (ch == null && ca == null && !hasCards && !hasExtra) {
          rows.push({ fixture_id: fid, stats: { no_stats: true }, updated_at: new Date().toISOString() });
          continue;
        }
        if (ch != null) withCorners++;
        // stat names match the live poll's team-stats map format (name -> [home, away])
        rows.push({
          fixture_id: fid, corners_home: ch, corners_away: ca,
          stats: { ...(hasCards ? { "Yellow Cards": [yh, ya], "Red Cards": [rh, ra] } : {}), ...extra },
          updated_at: new Date().toISOString(),
        });
      }
      // fixtures the provider didn't return at all: mark attempted so they don't clog the queue
      for (const fid of batch) if (!got.has(fid)) rows.push({ fixture_id: fid, stats: { no_stats: true }, updated_at: new Date().toISOString() });
      if (rows.length) {
        // never clobber a row the live poll already wrote (it may hold HT snapshots)
        await sb.from("fixture_stats").upsert(rows, { onConflict: "fixture_id", ignoreDuplicates: true });
        processed += rows.length;
      }
    }
    return json({ calls, processed, with_corners: withCorners });
  } catch (e) {
    console.error("collect-stats failed:", e);
    return json({ error: String(e instanceof Error ? e.message : e) }, 500);
  }
});
