import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import CheckoutClient from "@/components/CheckoutClient";
import { isPaidPlan } from "@/lib/plans";
import { getPlanCode } from "@/lib/paystack";

// Standalone checkout (outside the app shell, like /onboarding) so the "must onboard" gate never
// bounces a paying user away. Only reachable for a valid paid plan and a signed-in account.
export default async function CheckoutPage({ searchParams }: { searchParams: { plan?: string } }) {
  const plan = searchParams.plan;
  if (!isPaidPlan(plan)) redirect("/onboarding");

  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  // a plan code turns the charge into a recurring monthly subscription; if it can't be resolved
  // (Paystack unreachable) the client falls back to a one-off charge for the month
  const planCode = await getPlanCode(plan);

  // an already-onboarded account reaching checkout is UPGRADING, not signing up — so the page drops
  // the signup framing (logo/links → onboarding, "last step", "bring in first slip" on success).
  const { data: profile } = await supabase.from("profiles").select("onboarded").eq("id", user.id).maybeSingle();
  const upgrading = profile?.onboarded === true;

  return <CheckoutClient userId={user.id} email={user.email ?? ""} plan={plan} planCode={planCode} upgrading={upgrading} />;
}
