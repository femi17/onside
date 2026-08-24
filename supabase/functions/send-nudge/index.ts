// Onside nudge mailer (Resend). Two audiences, computed server-side on every call:
//   confirm — email-provider signups who never confirmed (never signed in): the blocker is the
//             confirmation step, so the mail carries a fresh magic link (proves inbox ownership,
//             confirms + signs them in, lands on onboarding).
//   onboard — confirmed accounts with profiles.onboarded=false: "finish your setup" with a magic
//             link straight to /onboarding.
// Idempotent by design: api_cache row nudge:{kind}:{user_id} is written before sending — a user
// is nudged ONCE per kind ever, so repeated invocations (or a stranger hitting the endpoint with
// the anon key) cannot spam anyone. No request input is trusted; the audience is always derived
// from the database.
import { createClient } from "npm:@supabase/supabase-js@2";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_KEY = Deno.env.get("SUPABASE_SECRET_KEY") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const sb = createClient(SB_URL, SB_KEY);
const RESEND_KEY = Deno.env.get("RESEND_API_KEY");
const FROM = "Onside <support@onside.com.ng>";
const SITE = "https://onside.com.ng";

type Nudge = { kind: "confirm" | "onboard"; userId: string; email: string };

function shell(inner: string): string {
  return `<!doctype html><html><body style="margin:0;padding:0;background:#0e1a1b;">
  <div style="max-width:520px;margin:0 auto;padding:36px 24px;font-family:Arial,Helvetica,sans-serif;">
    <div style="font-size:22px;font-weight:800;letter-spacing:-0.5px;margin-bottom:24px;">
      <span style="color:#f3f6f4;">ON</span><span style="color:#f0a828;">SIDE</span>
    </div>
    ${inner}
    <p style="color:#7d8f8a;font-size:11px;line-height:1.6;margin-top:32px;border-top:1px solid #223432;padding-top:16px;">
      18+ · Track responsibly · If this wasn't you, just ignore this email.<br>
      Onside · Thinka Platforms LTD · <a href="${SITE}" style="color:#7d8f8a;">onside.com.ng</a>
    </p>
  </div></body></html>`;
}
const button = (href: string, label: string) =>
  `<a href="${href}" style="display:inline-block;background:#f0a828;color:#101613;font-weight:700;font-size:15px;text-decoration:none;padding:13px 26px;border-radius:12px;margin-top:18px;">${label}</a>`;
const para = (t: string) => `<p style="color:#c9d6d2;font-size:15px;line-height:1.65;margin:0 0 12px;">${t}</p>`;

function emailFor(kind: Nudge["kind"], link: string): { subject: string; html: string } {
  if (kind === "confirm") {
    return {
      subject: "Finish creating your Onside account",
      html: shell(
        para("You're one click from in.") +
        para("You started an Onside account but never got through the door — the confirmation step is all that's left. This link confirms your email and signs you straight in:") +
        button(link, "Confirm my account →") +
        para(`<br>Then upload any betslip screenshot and watch every leg track itself, live.`)
      ),
    };
  }
  return {
    subject: "Your Onside setup is 2 minutes from done",
    html: shell(
      para("You're in — but your account isn't working for you yet.") +
      para("Finish setup to upload your first betslip (a screenshot is enough) and put an AI agent on your leagues:") +
      button(link, "Finish my setup →") +
      para(`<br>Every pick on Onside is graded in the open — misses included. See the live record at <a href="${SITE}/record" style="color:#f0a828;">onside.com.ng/record</a>.`)
    ),
  };
}

Deno.serve(async (_req) => {
  if (!RESEND_KEY) return Response.json({ error: "RESEND_API_KEY not set" }, { status: 500 });

  // audiences computed in SQL against auth.users directly (nudge_targets(), service-role only):
  // the admin listUsers API dropped unconfirmed users' fields in practice, so the DB is the truth
  const { data: rows, error: tgErr } = await sb.rpc("nudge_targets");
  if (tgErr) return Response.json({ error: tgErr.message }, { status: 500 });
  const targets: Nudge[] = (rows ?? []).map((r: { kind: string; user_id: string; email: string }) => ({
    kind: r.kind as Nudge["kind"], userId: r.user_id, email: r.email,
  }));

  const sent: string[] = [], skipped: string[] = [], failed: string[] = [];
  for (const t of targets) {
    // claim BEFORE sending: the insert failing (row exists) = already nudged = skip forever
    const { error: dupe } = await sb.from("api_cache").insert({
      cache_key: `nudge:${t.kind}:${t.userId}`,
      payload: { email: t.email, at: new Date().toISOString() },
    });
    if (dupe) { skipped.push(`${t.kind}:${t.email}`); continue; }

    // magic link: confirms inbox ownership + signs in + lands on onboarding
    let link = `${SITE}/login`;
    try {
      const { data: lk, error: lkErr } = await sb.auth.admin.generateLink({
        type: "magiclink", email: t.email,
        options: { redirectTo: `${SITE}/onboarding` },
      });
      if (!lkErr && lk?.properties?.action_link) link = lk.properties.action_link;
    } catch { /* plain login link fallback stays */ }

    const msg = emailFor(t.kind, link);
    const resp = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${RESEND_KEY}` },
      body: JSON.stringify({ from: FROM, to: t.email, subject: msg.subject, html: msg.html }),
    });
    if (resp.ok) sent.push(`${t.kind}:${t.email}`);
    else {
      failed.push(`${t.kind}:${t.email}:${resp.status}`);
      // release the claim so a rerun can retry a transient Resend failure
      await sb.from("api_cache").delete().eq("cache_key", `nudge:${t.kind}:${t.userId}`);
    }
  }

  return Response.json({ candidates: targets.length, sent, skipped, failed });
});
