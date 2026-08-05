"use client";

import { useState } from "react";
import Script from "next/script";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { PLAN_PRICING, type PaidPlan } from "@/lib/plans";

// Paystack Inline drops a global `PaystackPop` once its script loads.
declare global {
  interface Window {
    PaystackPop?: { setup: (opts: Record<string, unknown>) => { openIframe: () => void } };
  }
}

export default function CheckoutClient({
  userId,
  email,
  plan,
  planCode,
  upgrading = false,
}: {
  userId: string;
  email: string;
  plan: PaidPlan;
  planCode: string | null;
  upgrading?: boolean;
}) {
  const router = useRouter();
  const price = PLAN_PRICING[plan];
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  // where the brand mark + "back" lead depends on why you're here: a new signup steps back into
  // onboarding; an existing member upgrading steps back into the app.
  const backHref = upgrading ? "/tracker" : "/onboarding";
  const otherPlan: PaidPlan = plan === "pro" ? "pro_max" : "pro";

  function pay() {
    setMsg(null);
    const Pop = window.PaystackPop;
    if (!Pop) {
      setMsg("Payment is still loading — try again in a moment.");
      return;
    }
    setBusy(true);
    // with a plan code Paystack sets up a recurring monthly subscription and takes the amount from
    // the plan; without one we fall back to a single charge for this month
    const opts: Record<string, unknown> = {
      key: process.env.NEXT_PUBLIC_PAYSTACK_PUBLIC_KEY,
      email,
      currency: "NGN",
      metadata: { user_id: userId, plan, plan_label: price.label },
      callback: (res: { reference: string }) => {
        // Paystack's callback runs outside React — hand off to the async verifier
        void finish(res.reference);
      },
      onClose: () => setBusy(false),
    };
    if (planCode) opts.plan = planCode;
    else opts.amount = price.kobo;
    const handler = Pop.setup(opts);
    handler.openIframe();
  }

  async function finish(reference: string) {
    setBusy(true);
    try {
      const res = await fetch("/api/paystack/verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reference, plan }),
      });
      const body = await res.json();
      if (!res.ok) {
        setMsg(body.error ?? "We couldn't confirm the payment.");
        setBusy(false);
        return;
      }
      // new signup → bring in their first slip; an upgrade → back to the plan card in Profile
      router.push(upgrading ? "/profile" : "/add");
      router.refresh();
    } catch {
      setMsg("We couldn't confirm the payment. If you were charged, contact support.");
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-md flex-1 flex-col px-5 py-10">
      <Script src="https://js.paystack.co/v1/inline.js" strategy="afterInteractive" />

      <Link href={backHref} className="mb-8 flex items-center gap-2">
        <span className="glyph" />
        <span className="font-disp text-lg font-extrabold tracking-tight text-chalk">
          ON<span className="text-flood">SIDE</span>
        </span>
      </Link>

      <p className="font-mono text-[11px] font-bold uppercase tracking-[0.18em] text-flood-deep">
        {upgrading ? `Upgrade · ${price.label}` : "Last step · Checkout"}
      </p>
      <h1 className="mt-2 font-disp text-[26px] font-bold tracking-tight text-chalk">
        {upgrading ? `Upgrade to ${price.label}.` : "Confirm your plan."}
      </h1>
      <p className="mt-1.5 text-[14px] text-onpitch-mute">Billed monthly. Cancel anytime — you keep the plan until the month you&apos;ve paid for ends.</p>

      <section className="mt-5 rounded-2xl bg-chalk p-6 text-ink shadow-xl">
        <div className="flex items-baseline justify-between">
          <span className="font-disp text-xl font-extrabold">{price.label}</span>
          <span className="font-disp text-2xl font-extrabold">
            ₦{price.naira.toLocaleString()}
            <span className="ml-1 font-mono text-[12px] font-semibold text-ink-mute">/mo</span>
          </span>
        </div>

        <ul className="mt-4 flex flex-col gap-2 border-t border-dashed border-ink/15 pt-4">
          {price.perks.map((f) => (
            <li key={f} className="flex gap-2 text-[13.5px] text-ink-mute">
              <span className="font-bold text-flood-deep">✓</span>
              {f}
            </li>
          ))}
        </ul>

        {msg && <p className="mt-4 font-mono text-xs text-brick">{msg}</p>}

        <button
          onClick={pay}
          disabled={busy}
          className="mt-5 w-full rounded-xl bg-flood px-5 py-3.5 font-bold text-ink transition-transform hover:-translate-y-0.5 disabled:opacity-50"
        >
          {busy
            ? "Processing…"
            : planCode
              ? `Subscribe · ₦${price.naira.toLocaleString()}/mo`
              : `Pay ₦${price.naira.toLocaleString()} for a month`}
        </button>
        <p className="mt-2.5 text-center font-mono text-[10.5px] text-ink-mute">
          {planCode ? "Renews monthly · cancel anytime" : "Secured by Paystack · card, transfer & USSD"}
        </p>
        <p className="mt-2 text-center font-mono text-[10px] text-ink-mute">
          Payment is for an Onside software subscription. By subscribing you agree to our{" "}
          <Link href="/terms" className="text-flood-deep hover:underline">Terms</Link> &amp;{" "}
          <Link href="/privacy" className="text-flood-deep hover:underline">Privacy Policy</Link>.
        </p>
      </section>

      {upgrading ? (
        <div className="mt-5 flex flex-col items-center gap-2">
          <Link href={`/checkout?plan=${otherPlan}`} className="text-[13px] text-onpitch-mute hover:text-chalk">
            Prefer {PLAN_PRICING[otherPlan].label}? Switch &rarr;
          </Link>
          <Link href="/tracker" className="text-[12px] text-onpitch-mute/70 hover:text-chalk">
            &larr; Back to app
          </Link>
        </div>
      ) : (
        <button
          onClick={() => router.push("/onboarding")}
          className="mt-5 self-center text-[13px] text-onpitch-mute hover:text-chalk"
        >
          ← Choose a different plan
        </button>
      )}
    </div>
  );
}
