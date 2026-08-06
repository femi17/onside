import { createClient } from "@supabase/supabase-js";
import { PLAN_PRICING, type PaidPlan } from "@/lib/plans";

// Server-only Paystack helpers (only imported by server routes + the server checkout page). The
// secret key never leaves the server; the browser only ever receives a plan code (safe to expose)
// so the Inline popup can start a recurring subscription.
const PAYSTACK = "https://api.paystack.co";

export function paystackSecret(): string {
  return process.env.PAYSTACK_SECRET_KEY ?? "";
}

// true only when every server secret needed to grant/change a plan is present
export function billingConfigured(): boolean {
  return !!(
    process.env.PAYSTACK_SECRET_KEY &&
    process.env.SUPABASE_SECRET_KEY &&
    process.env.NEXT_PUBLIC_SUPABASE_URL
  );
}

// Admin client using the Supabase secret key (sb_secret_…, acts as the service_role Postgres role).
export function supabaseAdmin() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!url || !key) {
    throw new Error("SUPABASE_SECRET_KEY is not set — required for billing. Add it to .env.local and restart.");
  }
  return createClient(url, key, { auth: { persistSession: false } });
}

const PLAN_NAME: Record<PaidPlan, string> = {
  pro: "Onside Pro (Monthly)",
  pro_max: "Onside Pro Max (Monthly)",
};

// Returns the Paystack plan code for a tier, creating the plan once and caching it in the DB.
// Falls back to the existing plan on the Paystack account if one with the same name is present.
export async function getPlanCode(plan: PaidPlan): Promise<string | null> {
  // without the full server config we can't create/cache a plan — the checkout page then falls
  // back to a one-off charge rather than crashing
  if (!billingConfigured()) return null;
  const key = paystackSecret();
  const db = supabaseAdmin();

  const { data: cached } = await db.from("paystack_plans").select("plan_code").eq("plan", plan).maybeSingle();
  if (cached?.plan_code) return cached.plan_code;

  const name = PLAN_NAME[plan];
  const amount = PLAN_PRICING[plan].kobo;
  try {
    // reuse a plan already on the account (avoids duplicates if the cache was cleared)
    const listRes = await fetch(`${PAYSTACK}/plan?perPage=200`, {
      headers: { Authorization: `Bearer ${key}` },
      cache: "no-store",
    });
    const list = await listRes.json();
    let code: string | undefined = (list?.data ?? []).find(
      (p: { name?: string; plan_code?: string }) => p.name === name
    )?.plan_code;

    if (!code) {
      const createRes = await fetch(`${PAYSTACK}/plan`, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: JSON.stringify({ name, interval: "monthly", amount, currency: "NGN" }),
      });
      const created = await createRes.json();
      code = created?.data?.plan_code;
    }
    if (!code) return null;

    await db.from("paystack_plans").upsert({ plan, plan_code: code, updated_at: new Date().toISOString() });
    return code;
  } catch {
    return null;
  }
}

// Disables a user's current recurring subscription (used by cancel AND by mid-cycle tier upgrades,
// where the old tier must stop billing before the new one is scheduled). Resolves the code via the
// Paystack customer when the webhook never recorded it. Returns true if something was disabled.
export async function disableSubscriptionFor(userId: string): Promise<boolean> {
  const key = paystackSecret();
  const db = supabaseAdmin();
  const { data: prof } = await db
    .from("profiles")
    .select("paystack_subscription_code, paystack_email_token, paystack_customer_code")
    .eq("id", userId)
    .maybeSingle();
  let code = prof?.paystack_subscription_code ?? null;
  let token = prof?.paystack_email_token ?? null;
  try {
    if ((!code || !token) && prof?.paystack_customer_code) {
      const cRes = await fetch(`${PAYSTACK}/customer/${encodeURIComponent(prof.paystack_customer_code)}`, {
        headers: { Authorization: `Bearer ${key}` },
        cache: "no-store",
      });
      const cBody = await cRes.json();
      const subs = (cBody?.data?.subscriptions ?? []) as Array<{ subscription_code?: string; email_token?: string; status?: string }>;
      const sub = subs.find((s) => s.status === "active" || s.status === "non-renewing" || s.status === "attention") ?? subs[0];
      if (sub?.subscription_code) {
        code = sub.subscription_code;
        token = sub.email_token ?? token;
        if (!token) {
          const sRes = await fetch(`${PAYSTACK}/subscription/${encodeURIComponent(code)}`, {
            headers: { Authorization: `Bearer ${key}` },
            cache: "no-store",
          });
          const sBody = await sRes.json();
          token = sBody?.data?.email_token ?? null;
        }
      }
    }
    if (!code || !token) return false;
    const res = await fetch(`${PAYSTACK}/subscription/disable`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ code, token }),
      cache: "no-store",
    });
    const body = await res.json();
    if (!body?.status) return false;
    await db.from("profiles").update({ paystack_subscription_code: null, paystack_email_token: null }).eq("id", userId);
    return true;
  } catch {
    return false;
  }
}

// Maps a Paystack plan code back to our tier (for webhook events that only carry the plan code).
export async function tierForPlanCode(planCode: string | null | undefined): Promise<PaidPlan | null> {
  if (!planCode) return null;
  const db = supabaseAdmin();
  const { data } = await db.from("paystack_plans").select("plan").eq("plan_code", planCode).maybeSingle();
  return (data?.plan as PaidPlan) ?? null;
}
