import { NextResponse } from "next/server";
import { createClient as createServerClient } from "@/lib/supabase/server";
import { supabaseAdmin, paystackSecret, billingConfigured } from "@/lib/paystack";
import { PLAN_PRICING, isPaidPlan } from "@/lib/plans";

export const runtime = "nodejs";

// Verifies a Paystack transaction server-side (the browser can never be trusted to say it paid),
// then activates the plan with the service-role key so a client can't self-upgrade. Called by the
// checkout page after the Paystack popup returns a reference. The subscription's renewals and
// cancellation are kept in sync afterwards by the webhook route.
export async function POST(req: Request) {
  let payload: { reference?: string; plan?: string };
  try {
    payload = await req.json();
  } catch {
    return NextResponse.json({ error: "Bad request." }, { status: 400 });
  }
  const { reference, plan } = payload;
  if (!reference || !isPaidPlan(plan)) {
    return NextResponse.json({ error: "Missing payment reference or plan." }, { status: 400 });
  }

  // who's paying — from the auth cookie, not the request body
  const supabase = createServerClient();
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
  // the amount must cover the plan the user is claiming, in the right currency, for this account
  const expected = PLAN_PRICING[plan].kobo;
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
  const admin = supabaseAdmin();
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
      source: "checkout",
      paid_at: new Date().toISOString(),
    },
    { onConflict: "reference", ignoreDuplicates: true },
  );

  return NextResponse.json({ ok: true, plan });
}
