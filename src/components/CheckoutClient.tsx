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
  currentPlan = null,
  creditKobo = 0,
}: {
  userId: string;
  email: string;
  plan: PaidPlan;
  planCode: string | null;
  upgrading?: boolean;
  currentPlan?: PaidPlan | null; // the still-active paid plan being upgraded FROM (drives proration)
  creditKobo?: number; // credit for the unused share of the current plan's month (kobo)
}) {
  const router = useRouter();
  const price = PLAN_PRICING[plan];
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  // prorated tier upgrade: pay the full next-tier month minus the unused-time credit, as a one-off
  // charge (the server then moves the recurring subscription over)
  const prorated = creditKobo > 0 && currentPlan != null;
  const dueKobo = Math.max(0, price.kobo - creditKobo);
  const dueNaira = Math.round(dueKobo / 100);
  const creditNaira = Math.round(creditKobo / 100);

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
    else opts.amount = prorated ? dueKobo : price.kobo;
    const handler = Pop.setup(opts);
    handler.openIframe();
  }

  async function finish(reference: string) {
    setBusy(true);
    try {
      const res = await fetch("/api/paystack/verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reference, plan, upgrade: prorated }),
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

        {/* prorated upgrade: show the plus-and-minus so the price is never a surprise */}
        {prorated && (
          <div className="mt-4 rounded-xl bg-ink/[0.04] p-3.5 font-mono text-[12px]">
            <div className="flex justify-between text-ink-mute">
              <span>{price.label} · one month</span>
              <span>₦{price.naira.toLocaleString()}</span>
            </div>
            <div className="mt-1 flex justify-between text-grass-deep">
              <span>Unused {currentPlan === "pro" ? "Pro" : "plan"} time</span>
              <span>−₦{creditNaira.toLocaleString()}</span>
            </div>
            <div className="mt-2 flex justify-between border-t border-dashed border-ink/15 pt-2 font-bold text-ink">
              <span>Due today</span>
              <span>₦{dueNaira.toLocaleString()}</span>
            </div>
          </div>
        )}

        {msg && <p className="mt-4 font-mono text-xs text-brick">{msg}</p>}

        <button
          onClick={pay}
          disabled={busy}
          className="mt-5 w-full rounded-xl bg-flood px-5 py-3.5 font-bold text-ink transition-transform hover:-translate-y-0.5 disabled:opacity-50"
        >
          {busy
            ? "Processing…"
            : prorated
              ? `Upgrade · ₦${dueNaira.toLocaleString()} today`
              : planCode
                ? `Subscribe · ₦${price.naira.toLocaleString()}/mo`
                : `Pay ₦${price.naira.toLocaleString()} for a month`}
        </button>
        <p className="mt-2.5 text-center font-mono text-[10.5px] text-ink-mute">
          {prorated
            ? `Your ${currentPlan === "pro" ? "Pro" : "current"} subscription stops · ${price.label} renews at ₦${price.naira.toLocaleString()}/mo`
            : planCode
              ? "Renews monthly · cancel anytime"
              : "Secured by Paystack · card, transfer & USSD"}
        </p>
        <p className="mt-2 text-center font-mono text-[10px] text-ink-mute">
          Payment is for an Onside software subscription. By subscribing you agree to our{" "}
          <Link href="/terms" className="text-flood-deep hover:underline">Terms</Link> &amp;{" "}
          <Link href="/privacy" className="text-flood-deep hover:underline">Privacy Policy</Link>.
        </p>
      </section>

      {upgrading ? (
        <div className="mt-5 flex flex-col items-center gap-2">
          {/* never offer the plan the user is already on (that's not a switch, it's a re-buy) */}
          {otherPlan !== currentPlan && (
            <Link href={`/checkout?plan=${otherPlan}`} className="text-[13px] text-onpitch-mute hover:text-chalk">
              Prefer {PLAN_PRICING[otherPlan].label}? Switch &rarr;
            </Link>
          )}
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
