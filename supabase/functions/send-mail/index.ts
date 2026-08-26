// send-mail: internal one-off email utility (Resend). For owner/ops emails that don't fit a
// scheduled mailer (apologies, announcements to a single user). Guarded by x-internal-secret
// (push_internal_secret from the vault — same trust model as send-push); never exposed to
// browsers. Body: { to, subject, html }. Logs nothing itself — callers keep their own records.
import { createClient } from "npm:@supabase/supabase-js@2";

const SB_KEY = Deno.env.get("SUPABASE_SECRET_KEY") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const sb = createClient(Deno.env.get("SUPABASE_URL")!, SB_KEY);
const RESEND_KEY = Deno.env.get("RESEND_API_KEY");
const FROM = "Onside <support@onside.com.ng>";

Deno.serve(async (req) => {
  const given = req.headers.get("x-internal-secret");
  const { data: expect } = await sb.rpc("get_secret", { secret_name: "push_internal_secret" });
  if (!given || !expect || given !== String(expect)) {
    return Response.json({ error: "forbidden" }, { status: 403 });
  }
  if (!RESEND_KEY) return Response.json({ error: "RESEND_API_KEY not set" }, { status: 500 });

  let to = "", subject = "", html = "";
  try {
    const b = await req.json();
    to = String(b.to ?? ""); subject = String(b.subject ?? ""); html = String(b.html ?? "");
  } catch { /* fall through to the check below */ }
  if (!to || !subject || !html) return Response.json({ error: "to, subject, html required" }, { status: 400 });

  const resp = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${RESEND_KEY}` },
    body: JSON.stringify({ from: FROM, to, subject, html }),
  });
  return Response.json({ ok: resp.ok, status: resp.status });
});
