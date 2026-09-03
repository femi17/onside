import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import CheckoutClient from "@/components/CheckoutClient";
import { isPaidPlan, PLAN_PRICING, type PaidPlan } from "@/lib/plans";
import { getPlanCode } from "@/lib/paystack";

// Standalone checkout (outside the app shell, like /onboarding) so the "must onboard" gate never
// bounces a paying user away. Only reachable for a valid paid plan and a signed-in account.
export default async function CheckoutPage({ searchParams }: { searchParams: Promise<{ plan?: string }> }) {
  const { plan } = await searchParams;
  if (!isPaidPlan(plan)) redirect("/onboarding");

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  // an already-onboarded account reaching checkout is UPGRADING, not signing up — so the page drops
  // the signup framing (logo/links → onboarding, "last step", "bring in first slip" on success).
  const { data: profile } = await supabase
    .from("profiles")
    .select("onboarded, plan, plan_until")
    .eq("id", user.id)
    .maybeSingle();
  const upgrading = profile?.onboarded === true;

  // the plan the user is CURRENTLY paying for, if it's still running (an expired paid plan
  // checks out at full price like a new signup)
  const activePaid: PaidPlan | null =
    isPaidPlan(profile?.plan) && profile?.plan_until && Date.parse(profile.plan_until) > Date.now()
      ? profile.plan
      : null;

  // buying the plan you're already on isn't a purchase — bounce to the real next step
  if (activePaid === plan) redirect(plan === "pro" ? "/checkout?plan=pro_max" : "/profile");
  // active Pro Max asking for Pro is a downgrade, not an upgrade — that's managed from Profile
  // (cancel; Pro Max runs until its paid month ends)
  if (activePaid === "pro_max" && plan === "pro") redirect("/profile");

  // active Pro → Pro Max is a PRORATED upgrade: a full month of Pro Max starting today, minus a
  // credit for the unused share of the Pro month already paid (creditKobo). The first charge is a
  // one-off for the difference; /api/paystack/verify stops the old Pro subscription and schedules
  // the Pro Max recurring one to start when this upgraded month ends.
  let creditKobo = 0;
  if (activePaid === "pro" && plan === "pro_max") {
    const msLeft = Math.max(0, Date.parse(profile!.plan_until!) - Date.now());
    creditKobo = Math.round(PLAN_PRICING.pro.kobo * Math.min(1, msLeft / (30 * 86400000)));
  }

  // a plan code turns the charge into a recurring monthly subscription; if it can't be resolved
  // (Paystack unreachable) the client falls back to a one-off charge for the month. A prorated
  // upgrade is always a one-off (a plan code would charge the full plan amount).
  const planCode = creditKobo > 0 ? null : await getPlanCode(plan);

  // read server-side and pass down, so the browser gets the (publishable) key via a prop instead of
  // a NEXT_PUBLIC_ env var — keeps both Paystack keys as ordinary, non-public Vercel variables
  const publicKey = process.env.PAYSTACK_PUBLIC_KEY ?? "";

  return (
    <CheckoutClient
      userId={user.id}
      email={user.email ?? ""}
      plan={plan}
      planCode={planCode}
      publicKey={publicKey}
      upgrading={upgrading}
      currentPlan={activePaid}
      creditKobo={creditKobo}
    />
  );
}
