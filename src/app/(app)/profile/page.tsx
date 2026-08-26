import Link from "next/link";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { createClient } from "@/lib/supabase/server";
import SignOutButton from "@/components/SignOutButton";
import ConnectTelegram from "@/components/ConnectTelegram";
import CancelSubscription from "@/components/CancelSubscription";
import ChangePassword from "@/components/ChangePassword";
import NotificationSettings from "@/components/NotificationSettings";
import AppVersionStatus from "@/components/AppVersionStatus";
import DeleteAccount from "@/components/DeleteAccount";
import StickyHeader from "@/components/StickyHeader";
import MobileLogo from "@/components/MobileLogo";

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between border-b border-ink/10 py-3 last:border-0">
      <div className="text-sm font-semibold text-ink">{label}</div>
      <div className="font-mono text-[13px] text-ink-mute">{value}</div>
    </div>
  );
}

// The header (the LCP element) renders immediately; the profile/plan queries + the hydrated
// settings sections stream in behind Suspense — same pattern as /performance, which took that
// page from a failing mobile LCP to passing. First paint no longer waits on the data.
export default function ProfilePage() {
  return (
    <div>
      {/* fixed header on every width; transparent at rest, fills in only when scrolled */}
      <StickyHeader>
        <div className="mx-auto max-w-2xl px-5 pb-3 pt-6 md:px-8">
          <MobileLogo />
          <p className="font-mono text-[11px] uppercase tracking-[0.25em] text-flood">Settings</p>
          <h1 className="mt-2 font-disp text-3xl font-bold tracking-tight text-chalk sm:text-4xl">
            Your <span className="text-onpitch-mute">profile.</span>
          </h1>
        </div>
      </StickyHeader>
      <div className="mx-auto max-w-2xl px-5 pb-6 pt-2 md:px-8">
        <Suspense fallback={<ProfileFallback />}>
          <ProfileData />
        </Suspense>
      </div>
    </div>
  );
}

async function ProfileData() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  // one round trip: the profile and ALL plan tiers in parallel (3 tiny rows), pick ours after
  const [{ data: profile }, { data: allLimits }] = await Promise.all([
    supabase
      .from("profiles")
      .select("display_name, plan, currency, timezone, telegram_linked_at, created_at, plan_until, paystack_subscription_code")
      .eq("id", user.id)
      .single(),
    supabase.from("plan_limits").select("plan, max_leagues, max_accas_per_day, max_slip_uploads_per_day"),
  ]);

  const plan = profile?.plan ?? "free";
  const limits = (allLimits ?? []).find((l) => l.plan === plan) ?? null;

  const planLabel = plan === "pro_max" ? "Pro Max" : plan === "pro" ? "Pro" : "Free";
  const cur = profile?.currency ?? "NGN";
  const tz = profile?.timezone ?? "Africa/Lagos";
  const leagues = limits?.max_leagues ?? 5;
  const telegram = profile?.telegram_linked_at ? "Connected" : "Not linked";

  const isPaid = plan === "pro" || plan === "pro_max";
  const subActive = !!profile?.paystack_subscription_code;
  const renewLabel = profile?.plan_until
    ? new Date(profile.plan_until).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" })
    : null;
  // upgrade goes straight to checkout for the next tier (free → Pro, Pro → Pro Max)
  const upgradeHref = plan === "pro" ? "/checkout?plan=pro_max" : "/checkout?plan=pro";

  return (
    <>
      {/* plan */}
      <section className="mt-6 rounded-2xl bg-chalk p-5 text-ink shadow-xl">
        <div className="mb-3 font-disp text-[17px] font-bold">Plan</div>
        <div className="flex items-center justify-between rounded-xl border border-flood/30 bg-gradient-to-br from-flood/10 to-transparent p-4">
          <div>
            <div className="font-disp text-lg font-extrabold">{planLabel}</div>
            <div className="mt-0.5 text-[12.5px] text-ink-mute">
              {leagues} leagues · {limits?.max_accas_per_day ?? 1} acca{(limits?.max_accas_per_day ?? 1) === 1 ? "" : "s"}/day · {limits?.max_slip_uploads_per_day ?? 1} slip read{(limits?.max_slip_uploads_per_day ?? 1) === 1 ? "" : "s"}/day
            </div>
            {isPaid && renewLabel && (
              <div className="mt-1 font-mono text-[11px] text-ink-mute">
                {subActive ? `Renews ${renewLabel}` : `Active until ${renewLabel}`}
              </div>
            )}
          </div>
          {plan !== "pro_max" && (
            <Link href={upgradeHref} className="flex-none rounded-xl bg-flood px-4 py-2.5 font-bold text-ink transition-transform hover:-translate-y-0.5">
              Upgrade
            </Link>
          )}
        </div>
        {isPaid && <CancelSubscription />}
      </section>

      {/* profile details */}
      <section className="mt-4 rounded-2xl bg-chalk p-5 text-ink shadow-xl">
        <div className="mb-1 font-disp text-[17px] font-bold">Details</div>
        <Field label="Name" value={profile?.display_name ?? "—"} />
        <Field label="Email" value={user.email ?? "—"} />
        <Field label="Currency" value={cur === "NGN" ? "₦ NGN" : cur} />
        <Field label="Timezone" value={tz === "Africa/Lagos" ? "WAT (UTC+1)" : tz} />
        <Field label="Member since" value={profile?.created_at ? new Date(profile.created_at).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }) : "—"} />
      </section>

      {/* delivery */}
      <section className="mt-4 rounded-2xl bg-chalk p-5 text-ink shadow-xl">
        <div className="mb-1 font-disp text-[17px] font-bold">Delivery</div>
        <Field label="Telegram" value={telegram} />
        <Field label="In-app alerts" value="On" />
        <ConnectTelegram linked={!!profile?.telegram_linked_at} />
        <div className="mt-3 border-t border-ink/10 pt-3">
          <NotificationSettings userId={user.id} />
        </div>
      </section>

      {/* security */}
      <section className="mt-4 rounded-2xl bg-chalk p-5 text-ink shadow-xl">
        <div className="mb-1 font-disp text-[17px] font-bold">Security</div>
        <p className="text-[13px] text-ink-mute">Update the password you use to sign in.</p>
        <ChangePassword />
      </section>

      {/* app */}
      <section className="mt-4 rounded-2xl bg-chalk p-5 text-ink shadow-xl">
        <div className="mb-2 font-disp text-[17px] font-bold">App</div>
        <AppVersionStatus />
      </section>

      {/* danger zone — permanent account deletion, last on purpose */}
      <DeleteAccount />

      <div className="mt-5 md:hidden">
        <SignOutButton />
      </div>
    </>
  );
}

// card skeletons so the streamed body doesn't shift layout (background-only — never the LCP)
function ProfileFallback() {
  return (
    <div aria-hidden>
      <div className="mt-6 h-[140px] animate-pulse rounded-2xl bg-white/5" />
      <div className="mt-4 h-[230px] animate-pulse rounded-2xl bg-white/5" />
      <div className="mt-4 h-[260px] animate-pulse rounded-2xl bg-white/5" />
      <div className="mt-4 h-[120px] animate-pulse rounded-2xl bg-white/5" />
    </div>
  );
}
