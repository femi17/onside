import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { isPaidPlan, PLAN_PRICING } from "@/lib/plans";

// Paystack's "return to merchant" (used by transfer/USSD and other hosted flows) sends the user
// here — it's the account's Callback URL. Card inline payments never reach this page (their JS
// callback routes in-app), so this is purely the graceful landing for non-card returns. The plan
// itself is already applied by the charge.success webhook; this page just confirms it and puts the
// user back into Onside instead of a dead browser tab. Paystack appends ?reference=&trxref=.
export default async function CheckoutComplete({
  searchParams,
}: {
  searchParams: Promise<{ reference?: string; trxref?: string }>;
}) {
  await searchParams; // consume Paystack's query params; the webhook is the source of truth, not these
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: profile } = await supabase
    .from("profiles")
    .select("plan, plan_until, onboarded")
    .eq("id", user.id)
    .maybeSingle();

  const paidPlan = isPaidPlan(profile?.plan) ? profile.plan : null; // PaidPlan | null (narrowed)
  const untilTs = profile?.plan_until ?? null;
  const paid = paidPlan !== null && untilTs !== null && Date.parse(untilTs) > Date.now();
  const label = paidPlan ? PLAN_PRICING[paidPlan].label : null;
  const until = untilTs
    ? new Date(untilTs).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" })
    : null;
  // existing member upgrading → back to the app; a fresh signup → bring in their first slip
  const continueHref = profile?.onboarded ? "/tracker" : "/add";

  return (
    <div className="mx-auto flex min-h-[100dvh] w-full max-w-md flex-col items-center justify-center px-5 py-10 text-center">
      <Link href="/tracker" className="mb-8 flex items-center gap-2">
        <span className="glyph" />
        <span className="font-disp text-lg font-extrabold tracking-tight text-chalk">
          ON<span className="text-flood">SIDE</span>
        </span>
      </Link>

      {paid ? (
        <>
          <div className="grid h-16 w-16 place-items-center rounded-full bg-grass/15 text-3xl text-grass">✓</div>
          <h1 className="mt-5 font-disp text-2xl font-bold tracking-tight text-chalk">Payment received 🎉</h1>
          <p className="mt-2 text-[14px] leading-relaxed text-onpitch-mute">
            You&apos;re on <span className="font-semibold text-chalk">{label}</span>
            {until ? <> — active until {until}.</> : "."}
          </p>
        </>
      ) : (
        <>
          <div className="grid h-16 w-16 place-items-center rounded-full bg-flood/15 text-3xl text-flood">⏳</div>
          <h1 className="mt-5 font-disp text-2xl font-bold tracking-tight text-chalk">Payment received</h1>
          <p className="mt-2 max-w-[34ch] text-[14px] leading-relaxed text-onpitch-mute">
            We&apos;re activating your plan — this can take a few seconds. Tap continue, and if it isn&apos;t showing on
            your Profile shortly, refresh or reach us at support@onside.com.ng.
          </p>
        </>
      )}

      <Link
        href={continueHref}
        className="mt-7 w-full rounded-xl bg-flood px-5 py-3.5 font-bold text-ink transition-transform hover:-translate-y-0.5"
      >
        Continue to Onside →
      </Link>
      <Link href="/profile" className="mt-3 text-[13px] text-onpitch-mute hover:text-chalk">
        View my plan
      </Link>
    </div>
  );
}
