// "Your Week" receipt — the Sunday-night recap that makes the app a weekly ritual. Audience
// and numbers come from recap_targets() (any graded activity in the last 7 days); the
// platform's own week (public_record) rides along as the honest comparison line. One send
// per (ISO week, user) EVER via the api_cache claim — reruns and stray invocations can't
// double-mail. Magic link lands the reader signed-in on /my-record. Purely additive.
import { createClient } from "npm:@supabase/supabase-js@2";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_KEY = Deno.env.get("SUPABASE_SECRET_KEY") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const sb = createClient(SB_URL, SB_KEY);
const RESEND_KEY = Deno.env.get("RESEND_API_KEY");
const FROM = "Onside <support@onside.com.ng>";
const SITE = "https://onside.com.ng";

function isoWeek(): string {
  const d = new Date();
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7));
  const y = t.getUTCFullYear();
  const week = Math.ceil((((t.getTime() - Date.UTC(y, 0, 1)) / 86400000) + 1) / 7);
  return `${y}-W${String(week).padStart(2, "0")}`;
}
const pct = (w: number, g: number) => (g > 0 ? Math.round((w / g) * 100) : 0);

function shell(inner: string): string {
  return `<!doctype html><html><body style="margin:0;padding:0;background:#0e1a1b;">
  <div style="max-width:520px;margin:0 auto;padding:36px 24px;font-family:Arial,Helvetica,sans-serif;">
    <div style="font-size:22px;font-weight:800;letter-spacing:-0.5px;margin-bottom:24px;">
      <span style="color:#f3f6f4;">ON</span><span style="color:#f0a828;">SIDE</span>
    </div>
    ${inner}
    <p style="color:#7d8f8a;font-size:11px;line-height:1.6;margin-top:32px;border-top:1px solid #223432;padding-top:16px;">
      18+ · Track responsibly · Graded exactly like the bookie grades, voids excluded.<br>
      Onside · Thinka Platforms LTD · <a href="${SITE}" style="color:#7d8f8a;">onside.com.ng</a>
    </p>
  </div></body></html>`;
}
const statRow = (label: string, won: number, graded: number) =>
  `<tr>
    <td style="padding:10px 0;color:#c9d6d2;font-size:14px;border-bottom:1px solid #223432;">${label}</td>
    <td style="padding:10px 0;text-align:right;border-bottom:1px solid #223432;">
      <span style="color:#39d98a;font-weight:700;font-size:15px;">${won}</span>
      <span style="color:#c9d6d2;font-size:14px;"> of ${graded}</span>
      <span style="color:#7d8f8a;font-size:12px;"> · ${pct(won, graded)}%</span>
    </td>
  </tr>`;

Deno.serve(async (_req) => {
  if (!RESEND_KEY) return Response.json({ error: "RESEND_API_KEY not set" }, { status: 500 });

  const { data: targets, error: tErr } = await sb.rpc("recap_targets");
  if (tErr) return Response.json({ error: tErr.message }, { status: 500 });

  // the platform's week — same numbers /record shows, as the comparison line
  const { data: rec } = await sb.rpc("public_record");
  const wk = { graded: 0, won: 0 };
  for (const d of (rec?.days ?? []) as { graded: number; won: number }[]) { wk.graded += d.graded; wk.won += d.won; }

  const week = isoWeek();
  const sent: string[] = [], skipped: string[] = [], failed: string[] = [];
  for (const t of (targets ?? []) as { user_id: string; email: string; slips_graded: number; slips_won: number; agents_graded: number; agents_won: number }[]) {
    const claim = `recap:${week}:${t.user_id}`;
    const { error: dupe } = await sb.from("api_cache").insert({ cache_key: claim, payload: { email: t.email, at: new Date().toISOString() } });
    if (dupe) { skipped.push(t.email); continue; }

    let link = `${SITE}/my-record`;
    try {
      const { data: lk, error: lkErr } = await sb.auth.admin.generateLink({
        type: "magiclink", email: t.email, options: { redirectTo: `${SITE}/my-record` },
      });
      if (!lkErr && lk?.properties?.action_link) link = lk.properties.action_link;
    } catch { /* plain link fallback stays */ }

    const rows = [
      t.slips_graded > 0 ? statRow("Your slips", t.slips_won, t.slips_graded) : "",
      t.agents_graded > 0 ? statRow("Your agents' picks", t.agents_won, t.agents_graded) : "",
      wk.graded > 0 ? statRow("All Onside agents", wk.won, wk.graded) : "",
    ].join("");
    const totalWon = t.slips_won + t.agents_won, totalGraded = t.slips_graded + t.agents_graded;
    const html = shell(
      `<p style="color:#c9d6d2;font-size:15px;line-height:1.65;margin:0 0 6px;">Your week, graded:</p>
       <p style="color:#f3f6f4;font-size:26px;font-weight:800;margin:0 0 14px;">${totalWon} of ${totalGraded} landed <span style="color:#7d8f8a;font-size:15px;font-weight:400;">(${pct(totalWon, totalGraded)}%)</span></p>
       <table style="width:100%;border-collapse:collapse;">${rows}</table>
       <a href="${link}" style="display:inline-block;background:#f0a828;color:#101613;font-weight:700;font-size:15px;text-decoration:none;padding:13px 26px;border-radius:12px;margin-top:20px;">See my full record →</a>
       <p style="color:#7d8f8a;font-size:12px;line-height:1.6;margin:14px 0 0;">Every number graded in the open — the platform's live record is public at <a href="${SITE}/record" style="color:#f0a828;">onside.com.ng/record</a>.</p>`
    );
    const resp = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${RESEND_KEY}` },
      body: JSON.stringify({ from: FROM, to: t.email, subject: `Your week: ${totalWon} of ${totalGraded} landed`, html }),
    });
    if (resp.ok) sent.push(t.email);
    else { failed.push(`${t.email}:${resp.status}`); await sb.from("api_cache").delete().eq("cache_key", claim); }
  }

  return Response.json({ week, candidates: (targets ?? []).length, sent: sent.length, skipped: skipped.length, failed });
});
