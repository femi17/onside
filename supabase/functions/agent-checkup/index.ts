// agent-checkup: the Friday ritual for starving agents. One email per affected user, ever
// per ISO week (api_cache claim nudge:checkup:{user}:{week} — the nudge: prefix keeps it
// out of the cache prune). Diagnosis is deterministic from agent_checkup_targets():
//   - its leagues had no/few games this week  → widen the net / flip to surprise mode
//   - games existed but nothing passed        → the rule/quality bar filtered everything
// then one platform-proven suggestion with live receipts from starter_recipes(). Fires
// Friday 10:00 Lagos so users can retune before the weekend slate.
import { createClient } from "npm:@supabase/supabase-js@2";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_KEY = Deno.env.get("SUPABASE_SECRET_KEY") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const sb = createClient(SB_URL, SB_KEY);
const RESEND_KEY = Deno.env.get("RESEND_API_KEY");
const FROM = "Onside <support@onside.com.ng>";
const SITE = "https://onside.com.ng";

type AgentInfo = { name: string; market: string; leagues: number; mode: string; has_rule: boolean; games_7d: number | null };
type Target = { user_id: string; email: string; agents: AgentInfo[] };
type Recipes = Record<string, { won: number; graded: number }>;

const RECIPE_META: Record<string, { label: string; how: string }> = {
  safe_double: { label: "Safe Double", how: "double chance, only when the model is ≥75% sure" },
  goals_banker: { label: "Goals Banker", how: "Over 1.5 goals, only when the model is ≥82% sure" },
  home_scorers: { label: "Home Scorers", how: "home team to score, only when the model is ≥85% sure" },
};

function isoWeek(d: Date): string {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7));
  const y = t.getUTCFullYear();
  const wk = Math.ceil(((t.getTime() - Date.UTC(y, 0, 1)) / 86400000 + 1) / 7);
  return `${y}-W${String(wk).padStart(2, "0")}`;
}

const para = (t: string) => `<p style="color:#c9d6d2;font-size:15px;line-height:1.65;margin:0 0 12px;">${t}</p>`;
function shell(inner: string): string {
  return `<!doctype html><html><body style="margin:0;padding:0;background:#0e1a1b;">
  <div style="max-width:520px;margin:0 auto;padding:36px 24px;font-family:Arial,Helvetica,sans-serif;">
    <div style="font-size:22px;font-weight:800;letter-spacing:-0.5px;margin-bottom:24px;">
      <span style="color:#f3f6f4;">ON</span><span style="color:#f0a828;">SIDE</span>
    </div>
    ${inner}
    <p style="color:#7d8f8a;font-size:11px;line-height:1.6;margin-top:32px;border-top:1px solid #223432;padding-top:16px;">
      18+ · Track responsibly · You get this because an agent of yours found no games this week.<br>
      Onside · Thinka Platforms LTD · <a href="${SITE}" style="color:#7d8f8a;">onside.com.ng</a>
    </p>
  </div></body></html>`;
}

function diagnose(a: AgentInfo): string {
  if (a.mode === "surprise") return "it re-rolls fresh leagues daily but nothing passed its quality bar this week — a simpler rule usually opens the tap";
  if (a.games_7d != null && a.games_7d === 0) return `its ${a.leagues} league${a.leagues === 1 ? "" : "s"} had NO games at all this week — widen the net or flip it to 🎲 surprise mode`;
  if (a.games_7d != null && a.games_7d < 10) return `its leagues only had ${a.games_7d} games this week — a thin hunting ground; add a few more leagues`;
  if (a.has_rule) return `its leagues had ${a.games_7d ?? "plenty of"} games, but the rule + quality bar filtered every one out — try relaxing the rule to ONE clear condition`;
  return `its leagues had ${a.games_7d ?? "plenty of"} games but none met the quality bar — the engine only delivers picks it can stand behind; a different market may bite sooner`;
}

Deno.serve(async (_req) => {
  if (!RESEND_KEY) return Response.json({ error: "RESEND_API_KEY not set" }, { status: 500 });

  const [{ data: rows, error: tgErr }, { data: rec }] = await Promise.all([
    sb.rpc("agent_checkup_targets"),
    sb.rpc("starter_recipes"),
  ]);
  if (tgErr) return Response.json({ error: tgErr.message }, { status: 500 });

  // the best live receipt to suggest: highest hit-rate recipe with a real sample
  let best: { label: string; how: string; won: number; graded: number } | null = null;
  for (const [key, v] of Object.entries((rec ?? {}) as Recipes)) {
    const meta = RECIPE_META[key];
    if (!meta || !v || v.graded < 15) continue;
    if (!best || v.won / v.graded > best.won / best.graded) best = { ...meta, ...v };
  }

  const week = isoWeek(new Date());
  const sent: string[] = [], skipped: string[] = [], failed: string[] = [];
  for (const t of (rows ?? []) as Target[]) {
    const claimKey = `nudge:checkup:${t.user_id}:${week}`;
    const { error: dupe } = await sb.from("api_cache").insert({
      cache_key: claimKey, payload: { email: t.email, agents: t.agents.length, at: new Date().toISOString() },
    });
    if (dupe) { skipped.push(t.email); continue; }

    const many = t.agents.length > 1;
    const agentLines = t.agents.slice(0, 3).map((a) =>
      para(`<b style="color:#f3f6f4;">${a.name}</b> (${a.market.replace(/_/g, " ")}) delivered nothing this week — ${diagnose(a)}.`)
    ).join("");
    const suggestion = best
      ? para(`If you want a setup that's biting right now: <b style="color:#f3f6f4;">${best.label}</b> — ${best.how} — landed <b style="color:#f3f6f4;">${best.won} of ${best.graded}</b> graded picks (${Math.round((best.won / best.graded) * 100)}%) across Onside in the last two weeks. Set your agent's market and rule to that and let it hunt.`)
      : "";

    let link = `${SITE}/login`;
    try {
      const { data: lk, error: lkErr } = await sb.auth.admin.generateLink({
        type: "magiclink", email: t.email, options: { redirectTo: `${SITE}/strategies` },
      });
      if (!lkErr && lk?.properties?.action_link) link = lk.properties.action_link;
    } catch { /* plain login link stays */ }

    const html = shell(
      para(`Quick checkup: ${many ? "some of your agents went" : "your agent went"} quiet.`) +
      agentLines +
      para("A quiet week isn't a broken agent — it's an agent whose net or bar doesn't fit this week's football. Small tweaks reopen the tap.") +
      suggestion +
      `<a href="${link}" style="display:inline-block;background:#f0a828;color:#101613;font-weight:700;font-size:15px;text-decoration:none;padding:13px 26px;border-radius:12px;margin-top:18px;">Tune my agent${many ? "s" : ""} →</a>`
    );
    const resp = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${RESEND_KEY}` },
      body: JSON.stringify({ from: FROM, to: t.email, subject: many ? "Your agents found nothing this week — here's why" : "Your agent found nothing this week — here's why", html }),
    });
    if (resp.ok) sent.push(t.email);
    else {
      failed.push(`${t.email}:${resp.status}`);
      await sb.from("api_cache").delete().eq("cache_key", claimKey);
    }
  }

  return Response.json({ candidates: (rows ?? []).length, sent, skipped, failed });
});
