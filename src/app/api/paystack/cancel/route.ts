import { NextResponse } from "next/server";
import { createClient as createServerClient } from "@/lib/supabase/server";
import { supabaseAdmin, paystackSecret, billingConfigured } from "@/lib/paystack";

export const runtime = "nodejs";

// Disables the caller's Paystack subscription (no more renewals). The subscription code + email
// token are read server-side and never exposed to the browser. Access stays until plan_until; the
// hourly cron then drops the account to free.
export async function POST() {
  const supabase = createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Sign in to continue." }, { status: 401 });

  if (!billingConfigured()) {
    return NextResponse.json({ error: "Payments aren't fully configured on the server." }, { status: 500 });
  }
  const secret = paystackSecret();

  const admin = supabaseAdmin();
  const { data: prof } = await admin
    .from("profiles")
    .select("paystack_subscription_code, paystack_email_token, paystack_customer_code")
    .eq("id", user.id)
    .maybeSingle();
  let code = prof?.paystack_subscription_code ?? null;
  let token = prof?.paystack_email_token ?? null;

  // The webhook normally records code + token on subscription.create. If that never synced (webhook
  // not configured, or a one-off charge), resolve the live subscription straight from Paystack via
  // the customer code so the user can still cancel.
  if ((!code || !token) && prof?.paystack_customer_code) {
    try {
      const cRes = await fetch(`https://api.paystack.co/customer/${encodeURIComponent(prof.paystack_customer_code)}`, {
        headers: { Authorization: `Bearer ${secret}` },
        cache: "no-store",
      });
      const cBody = await cRes.json();
      const subs = (cBody?.data?.subscriptions ?? []) as Array<{ subscription_code?: string; email_token?: string; status?: string }>;
      // prefer one that will still bill; otherwise take whatever exists
      const sub = subs.find((s) => s.status === "active" || s.status === "non-renewing" || s.status === "attention") ?? subs[0];
      if (sub?.subscription_code) {
        code = sub.subscription_code;
        token = sub.email_token ?? token;
        if (!token) {
          const sRes = await fetch(`https://api.paystack.co/subscription/${encodeURIComponent(code)}`, {
            headers: { Authorization: `Bearer ${secret}` },
            cache: "no-store",
          });
          const sBody = await sRes.json();
          token = sBody?.data?.email_token ?? null;
        }
      }
    } catch {
      /* fall through to the no-subscription response below */
    }
  }

  if (!code || !token) {
    // nothing recurring to disable — a one-off plan simply lapses at plan_until
    return NextResponse.json(
      { ok: true, nothingToCancel: true, message: "You're not on a recurring subscription — your plan won't renew and ends on its expiry date." },
      { status: 200 },
    );
  }

  try {
    const res = await fetch("https://api.paystack.co/subscription/disable", {
      method: "POST",
      headers: { Authorization: `Bearer ${secret}`, "content-type": "application/json" },
      body: JSON.stringify({ code, token }),
      cache: "no-store",
    });
    const body = await res.json();
    if (!body?.status) {
      return NextResponse.json({ error: body?.message ?? "Couldn't cancel the subscription." }, { status: 502 });
    }
  } catch {
    return NextResponse.json({ error: "Couldn't reach the payment provider." }, { status: 502 });
  }

  // reflect the cancellation right away; the subscription.disable webhook would do the same
  await admin.from("profiles").update({ paystack_subscription_code: null }).eq("id", user.id);
  return NextResponse.json({ ok: true });
}
