import { NextResponse } from "next/server";
import crypto from "node:crypto";
import { supabaseAdmin, paystackSecret, tierForPlanCode, billingConfigured } from "@/lib/paystack";

export const runtime = "nodejs";

// Paystack calls this on subscription lifecycle events. It's the source of truth for renewals and
// cancellations: the initial charge is activated synchronously by /verify, but every month after
// that (and any cancellation) arrives here. Every request is HMAC-verified against the secret key.
export async function POST(req: Request) {
  const raw = await req.text();
  if (!billingConfigured()) return NextResponse.json({ error: "not configured" }, { status: 500 });
  const secret = paystackSecret();

  const signature = req.headers.get("x-paystack-signature");
  const expected = crypto.createHmac("sha512", secret).update(raw).digest("hex");
  if (!signature || signature !== expected) {
    return NextResponse.json({ error: "invalid signature" }, { status: 401 });
  }

  let event: { event?: string; data?: Record<string, unknown> };
  try {
    event = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "bad payload" }, { status: 400 });
  }

  const db = supabaseAdmin();
  const data = (event.data ?? {}) as {
    subscription_code?: string;
    email_token?: string;
    next_payment_date?: string;
    customer?: { customer_code?: string };
    plan?: { plan_code?: string } | string;
    metadata?: { user_id?: string };
    reference?: string;
    amount?: number;
    currency?: string;
    paid_at?: string;
  };
  const customerCode = data.customer?.customer_code ?? null;
  const metaUserId = data.metadata?.user_id ?? null;
  const planCode = typeof data.plan === "string" ? data.plan : data.plan?.plan_code;

  switch (event.event) {
    // first charge cleared → the subscription now exists; record its code + real next-payment date
    case "subscription.create": {
      if (!customerCode) break;
      const tier = await tierForPlanCode(planCode);
      const patch: Record<string, unknown> = {
        paystack_subscription_code: data.subscription_code ?? null,
        paystack_email_token: data.email_token ?? null,
      };
      if (data.next_payment_date) patch.plan_until = data.next_payment_date;
      if (tier) patch.plan = tier;
      await db.from("profiles").update(patch).eq("paystack_customer_code", customerCode);
      break;
    }

    // a monthly renewal (or the initial charge) succeeded → extend access one more period.
    // match on our own metadata when present (most reliable), else the Paystack customer.
    case "charge.success": {
      if (!planCode) break; // non-subscription charges carry no plan
      const until = new Date();
      until.setMonth(until.getMonth() + 1);
      const patch = { plan_until: until.toISOString() };
      if (metaUserId) await db.from("profiles").update(patch).eq("id", metaUserId);
      else if (customerCode) await db.from("profiles").update(patch).eq("paystack_customer_code", customerCode);

      // record the renewal for revenue reporting. deduped on reference so the initial charge (already
      // written by /verify) isn't counted twice. resolve the user by metadata, else by customer code.
      if (data.reference && data.amount != null) {
        let uid = metaUserId ?? null;
        if (!uid && customerCode) {
          const { data: p } = await db.from("profiles").select("id").eq("paystack_customer_code", customerCode).maybeSingle();
          uid = (p?.id as string) ?? null;
        }
        await db.from("payments").upsert(
          {
            user_id: uid,
            plan: (await tierForPlanCode(planCode)) ?? null,
            amount_kobo: data.amount,
            currency: data.currency ?? "NGN",
            reference: data.reference,
            paystack_customer_code: customerCode,
            status: "success",
            source: "renewal",
            paid_at: data.paid_at ?? new Date().toISOString(),
          },
          { onConflict: "reference", ignoreDuplicates: true },
        );
      }
      break;
    }

    // cancelled or won't renew → stop renewing but keep access until plan_until; the hourly cron
    // then drops the account to free once that date passes (see downgrade_expired_plans)
    case "subscription.disable":
    case "subscription.not_renew": {
      if (!data.subscription_code) break;
      await db
        .from("profiles")
        .update({ paystack_subscription_code: null })
        .eq("paystack_subscription_code", data.subscription_code);
      break;
    }
  }

  return NextResponse.json({ received: true });
}
