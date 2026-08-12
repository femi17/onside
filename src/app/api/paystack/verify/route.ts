import { NextResponse } from "next/server";
import { createClient as createServerClient } from "@/lib/supabase/server";
import { supabaseAdmin, paystackSecret, billingConfigured, disableSubscriptionFor, getPlanCode } from "@/lib/paystack";
import { PLAN_PRICING, isPaidPlan } from "@/lib/plans";

export const runtime = "nodejs";

// Verifies a Paystack transaction server-side (the browser can never be trusted to say it paid),
// then activates the plan with the service-role key so a client can't self-upgrade. Called by the
// checkout page after the Paystack popup returns a reference. The subscription's renewals and
// cancellation are kept in sync afterwards by the webhook route.
export async function POST(req: Request) {
  let payload: { reference?: string; plan?: string; upgrade?: boolean };
  try {
    payload = await req.json();
  } catch {
    return NextResponse.json({ error: "Bad request." }, { status: 400 });
  }
  const { reference, plan } = payload;
  if (!reference || !isPaidPlan(plan)) {
    return NextResponse.json({ error: "Missing payment reference or plan." }, { status: 400 });
  }
  // client says this was a prorated Pro → Pro Max upgrade; verified against the DB below, never trusted
  const claimsUpgrade = payload.upgrade === true && plan === "pro_max";

  // who's paying — from the auth cookie, not the request body
  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Sign in to continue." }, { status: 401 });

  if (!billingConfigured()) {
    return NextResponse.json({ error: "Payments aren't fully configured on the server." }, { status: 500 });
  }
  const secret = paystackSecret();

  // confirm the charge with Paystack
  type Tx = {
    status?: string;
    amount?: number;
    currency?: string;
    metadata?: { user_id?: string };
    customer?: { customer_code?: string };
    authorization?: { authorization_code?: string; reusable?: boolean };
  };
  let tx: Tx | undefined;
  try {
    const res = await fetch(`https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`, {
      headers: { Authorization: `Bearer ${secret}` },
      cache: "no-store",
    });
    const body = await res.json();
    if (!body?.status) return NextResponse.json({ error: "Payment could not be verified." }, { status: 402 });
    tx = body.data;
  } catch {
    return NextResponse.json({ error: "Couldn't reach the payment provider." }, { status: 502 });
  }

  if (tx?.status !== "success") {
    return NextResponse.json({ error: "That payment didn't complete." }, { status: 402 });
  }
  const admin = supabaseAdmin();

  // A prorated Pro → Pro Max upgrade pays the full Pro Max month MINUS the unused share of the
  // Pro month. The credit is recomputed here from the DB (plan + plan_until), never from the
  // browser; a small tolerance covers the minutes between page render and payment.
  let isUpgrade = false;
  let expected = PLAN_PRICING[plan].kobo;
  if (claimsUpgrade) {
    const { data: prof } = await admin.from("profiles").select("plan, plan_until").eq("id", user.id).maybeSingle();
    if (prof?.plan === "pro" && prof.plan_until && Date.parse(prof.plan_until) > Date.now()) {
      const msLeft = Math.max(0, Date.parse(prof.plan_until) - Date.now());
      const credit = Math.round(PLAN_PRICING.pro.kobo * Math.min(1, msLeft / (30 * 86400000)));
      const TOLERANCE = 5000; // ₦50 of drift between page render and charge
      expected = Math.max(0, PLAN_PRICING.pro_max.kobo - credit - TOLERANCE);
      isUpgrade = true;
    }
    // no live Pro plan behind the claim → fall through with the full-price expectation
  }

  // the amount must cover the plan the user is claiming, in the right currency, for this account
  if (Number(tx.amount) < expected || tx.currency !== "NGN") {
    return NextResponse.json({ error: "The amount paid didn't match this plan." }, { status: 402 });
  }
  if (tx.metadata?.user_id && tx.metadata.user_id !== user.id) {
    return NextResponse.json({ error: "That payment belongs to another account." }, { status: 403 });
  }

  // grant the plan with the service role (bypasses RLS so the browser can't do this itself).
  // give a full month of access up front; the webhook corrects plan_until to the real next-payment
  // date and records the subscription code once Paystack emits subscription.create.
  const until = new Date();
  until.setMonth(until.getMonth() + 1);
  const { error } = await admin
    .from("profiles")
    .update({
      plan,
      onboarded: true,
      plan_until: until.toISOString(),
      paystack_customer_code: tx.customer?.customer_code ?? null,
    })
    .eq("id", user.id);
  if (error) return NextResponse.json({ error: "Couldn't activate your plan — try again." }, { status: 500 });

  if (isUpgrade) {
    // stop the old Pro subscription billing ₦500 behind the new plan (non-fatal — worst case the
    // webhook's charge would extend a plan the user no longer has, and they can cancel from Profile)
    await disableSubscriptionFor(user.id);
    // keep the money flowing after the prorated month: schedule the Pro Max recurring subscription
    // to start when this upgraded month ends, on the card just charged. Non-fatal — without it the
    // plan simply lapses at plan_until (hourly downgrade cron) and the user can resubscribe.
    try {
      const authCode = tx.authorization?.authorization_code;
      const customer = tx.customer?.customer_code;
      const planCode = await getPlanCode("pro_max");
      if (authCode && customer && planCode) {
        await fetch("https://api.paystack.co/subscription", {
          method: "POST",
          headers: { Authorization: `Bearer ${secret}`, "content-type": "application/json" },
          body: JSON.stringify({ customer, plan: planCode, authorization: authCode, start_date: until.toISOString() }),
          cache: "no-store",
        });
      }
    } catch { /* one-off month; renewal handled by resubscribing */ }
  }

  // record the payment for revenue reporting (deduped on the Paystack reference — the webhook's
  // charge.success may also fire for this same charge)
  await admin.from("payments").upsert(
    {
      user_id: user.id,
      plan,
      amount_kobo: Number(tx.amount),
      currency: tx.currency ?? "NGN",
      reference,
      paystack_customer_code: tx.customer?.customer_code ?? null,
      status: "success",
      source: isUpgrade ? "upgrade" : "checkout",
      paid_at: new Date().toISOString(),
    },
    { onConflict: "reference", ignoreDuplicates: true },
  );

  return NextResponse.json({ ok: true, plan });
}
