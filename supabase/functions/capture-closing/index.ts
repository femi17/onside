// Closing-line value capture. Cron every 5 min: for priced pending picks whose fixture kicks off in
// the next ~10 min and that haven't been snapshotted, fetch the fixture's odds once, de-vig the
// closing price for THAT pick's market/side/line, and store close_prob + clv (= close_prob −
// market_prob). Positive clv = the market moved toward our pick by kickoff = we beat the close.
// Only priced markets (market_prob not null) get a CLV; others are left null. Uses the service role
// (bypasses RLS); verify_jwt gates the invocation like poll/run-strategies.
import { createClient } from "npm:@supabase/supabase-js@2";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE = Deno.env.get("SUPABASE_SECRET_KEY") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const sb = createClient(SB_URL, SERVICE);
const AF_BASE = "https://v3.football.api-sports.io";
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { "content-type": "application/json" } });

async function getSecret(name: string): Promise<string> {
  const { data, error } = await sb.rpc("get_secret", { secret_name: name });
  if (error || !data) throw new Error(`secret ${name}`);
  return data as string;
}

// ---- de-vig helpers (same math as run-strategies' marketProb) ----
function oddOf(bet: any, value: string): number | null {
  const v = (bet?.values ?? []).find((z: any) => String(z.value).toLowerCase() === value.toLowerCase());
  return v ? Number(v.odd) : null;
}
function threeWay(bet: any): { home: number; draw: number; away: number } | null {
  const h = oddOf(bet, "Home"), d = oddOf(bet, "Draw"), a = oddOf(bet, "Away");
  if (!h || !d || !a) return null;
  const ih = 1 / h, id = 1 / d, ia = 1 / a, s = ih + id + ia;
  return { home: ih / s, draw: id / s, away: ia / s };
}
function twoWay(bet: any, yes: string, no: string): number | null {
  const y = oddOf(bet, yes), n = oddOf(bet, no);
  if (!y || !n) return null;
  const iy = 1 / y, ino = 1 / n;
  return iy / (iy + ino);
}
function ouProb(bet: any, line: number, sideWant: "over" | "under"): number | null {
  if (!bet) return null;
  const o = oddOf(bet, `Over ${line}`), u = oddOf(bet, `Under ${line}`);
  if (!o || !u) return null;
  const io = 1 / o, iu = 1 / u;
  const over = io / (io + iu);
  return sideWant === "over" ? over : 1 - over;
}
function bookProb(mk: string, side: string | null, line: number | null, bets: any[]): number | null {
  const bet = (id: number) => bets.find((b) => Number(b.id) === id);
  const dc = () => threeWay(bet(1));
  switch (mk) {
    case "home_win": { const t = threeWay(bet(1)); return t ? t.home : null; }
    case "away_win": { const t = threeWay(bet(1)); return t ? t.away : null; }
    case "draw": { const t = threeWay(bet(1)); return t ? t.draw : null; }
    case "result_1x2": { const t = threeWay(bet(1)); return t ? (side === "home" ? t.home : side === "away" ? t.away : t.draw) : null; }
    case "double_chance_1x": { const t = dc(); return t ? Math.min(1, t.home + t.draw) : null; }
    case "double_chance_x2": { const t = dc(); return t ? Math.min(1, t.draw + t.away) : null; }
    case "double_chance_12": { const t = dc(); return t ? Math.min(1, t.home + t.away) : null; }
    case "over_0_5": return ouProb(bet(5), 0.5, "over");
    case "over_1_5": return ouProb(bet(5), 1.5, "over");
    case "over_2_5": return ouProb(bet(5), 2.5, "over");
    case "over_3_5": return ouProb(bet(5), 3.5, "over");
    case "under_2_5": return ouProb(bet(5), 2.5, "under");
    case "under_3_5": return ouProb(bet(5), 3.5, "under");
    case "total_goals_ou": return line == null ? null : ouProb(bet(5), line, side === "under" ? "under" : "over");
    case "btts": { const p = twoWay(bet(8), "Yes", "No"); return p == null ? null : (side === "no" ? 1 - p : p); }
    case "home_to_score": return twoWay(bet(43), "Yes", "No");
    case "away_to_score": return twoWay(bet(44), "Yes", "No");
    default: return null;
  }
}
function marketProb(mk: string, side: string | null, line: number | null, bookmakers: any[]): number | null {
  const ps: number[] = [];
  for (const bm of bookmakers) { const p = bookProb(mk, side, line, bm.bets ?? []); if (p != null && p > 0 && p < 1) ps.push(p); }
  if (!ps.length) return null;
  return ps.reduce((a, b) => a + b, 0) / ps.length;
}

Deno.serve(async () => {
  try {
    const key = await getSecret("api_football_key");
    const nowIso = new Date().toISOString();
    const soonIso = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    // priced pending picks about to kick off, not yet snapshotted
    const { data: due } = await sb.from("deliveries")
      .select("id, fixture_id, market_key, side, line, market_prob, fixtures!inner(kickoff_utc)")
      .eq("result", "pending").not("market_prob", "is", null).is("close_prob", null)
      .gte("fixtures.kickoff_utc", nowIso).lte("fixtures.kickoff_utc", soonIso)
      .limit(1000);

    const byFx = new Map<number, any[]>();
    for (const d of due ?? []) { const arr = byFx.get(d.fixture_id) ?? []; arr.push(d); byFx.set(d.fixture_id, arr); }

    let captured = 0, calls = 0;
    for (const [fxId, ds] of byFx) {
      let bms: any[] = [];
      try {
        const res = await fetch(`${AF_BASE}/odds?fixture=${fxId}`, { headers: { "x-apisports-key": key } });
        calls++; await sb.rpc("bump_api_usage");
        const body = await res.json();
        bms = body?.response?.[0]?.bookmakers ?? [];
      } catch { continue; }
      if (!bms.length) continue;
      for (const d of ds) {
        const cp = marketProb(d.market_key, d.side ?? null, d.line != null ? Number(d.line) : null, bms);
        if (cp == null) continue;
        const clv = cp - Number(d.market_prob);
        await sb.from("deliveries").update({ close_prob: cp, clv, close_captured_at: nowIso }).eq("id", d.id);
        captured++;
      }
    }
    return json({ due: (due ?? []).length, fixtures: byFx.size, captured, calls });
  } catch (e) {
    console.error("capture-closing failed:", e);
    return json({ error: String(e instanceof Error ? e.message : e) }, 500);
  }
});
