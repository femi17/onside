import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import SignOutButton from "@/components/SignOutButton";
import SidebarNav from "@/components/SidebarNav";
import MobileNav from "@/components/MobileNav";
import LiveGamesFab from "@/components/LiveGamesFab";
import AgentFab from "@/components/AgentFab";
import PushChime from "@/components/PushChime";
import InstallPushPrompt from "@/components/InstallPushPrompt";
import InstallNudge from "@/components/InstallNudge";
import UpdateWatcher from "@/components/UpdateWatcher";
import FounderQuestion from "@/components/FounderQuestion";
import ConfirmProvider from "@/components/ConfirmDialog";
import Footer from "@/components/Footer";

const NAV = [
  { label: "Tracker", href: "/tracker" },
  { label: "Accumulators", href: "/accumulators" },
  { label: "Strategies", href: "/strategies" },
  { label: "Agent", href: "/agent" },
  { label: "Performance", href: "/performance" },
  { label: "My record", href: "/my-record" },
  { label: "Community", href: "/community" },
];

// the Menu sheet mirrors the sidebar but surfaces "Add bet" as a primary destination
const MOBILE_NAV = [{ label: "Tracker", href: "/tracker" }, { label: "Add bet", href: "/add" }, ...NAV.slice(1)];

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: profile } = await supabase
    .from("profiles")
    .select("plan, display_name, onboarded, is_admin")
    .eq("id", user.id)
    .single();

  // staff-only nav — admins sign in as normal users but see Analytics here. Moderation is a
  // lightweight tool, so it lives as a top-right link on the Community page instead of the menu.
  const adminLinks = [{ label: "Analytics", href: "/analytics" }];
  const nav = profile?.is_admin ? [...NAV, ...adminLinks] : NAV;
  const mobileNav = profile?.is_admin ? [...MOBILE_NAV, ...adminLinks] : MOBILE_NAV;

  // first-run: send brand-new accounts through onboarding (route lives outside this layout group).
  if (profile && profile.onboarded === false) redirect("/onboarding");

  // api_usage is now a sharded counter — sum via the admin-gated RPC. Only admins ever see the
  // number, so skip the round-trip entirely for everyone else (this layout renders on every page).
  const apiToday = profile?.is_admin ? (await supabase.rpc("api_usage_today")).data : null;

  const planLabel =
    profile?.plan === "pro_max" ? "Pro Max" : profile?.plan === "pro" ? "Pro" : "Free";
  // Upgrade goes straight to checkout for the next tier up (Free → Pro, Pro → Pro Max); the
  // checkout page has a "choose a different plan" link if they want the other one.
  const upgradeHref = profile?.plan === "pro" ? "/checkout?plan=pro_max" : "/checkout?plan=pro";

  return (
    <ConfirmProvider>
    <div className="flex h-screen overflow-hidden">
      {/* fixed sidebar */}
      <aside className="no-scrollbar hidden w-[236px] shrink-0 flex-col gap-8 overflow-y-auto border-r border-white/10 p-6 md:flex">
        <Link href="/" className="flex items-center gap-3">
          <span className="glyph" />
          <span className="font-disp text-xl font-extrabold tracking-tight text-chalk">
            ON<span className="text-flood">SIDE</span>
          </span>
        </Link>

        <SidebarNav items={nav} />

        <div className="mt-auto flex flex-col gap-3">
          <div className="rounded-xl border border-white/15 bg-pitch-2 p-3.5">
            <div className="flex items-center justify-between gap-2">
              <Link href="/profile" prefetch={false} className="font-mono text-[10px] uppercase tracking-wide text-onpitch-mute transition-colors hover:text-chalk">
                Your plan
              </Link>
              {profile?.plan !== "pro_max" && (
                <Link href={upgradeHref} prefetch={false} className="font-mono text-[10px] font-bold uppercase tracking-wide text-flood transition-colors hover:text-flood-deep">
                  Upgrade &rarr;
                </Link>
              )}
            </div>
            <div className="mt-1 font-bold text-chalk">{planLabel}</div>
            <Link href="/profile" prefetch={false} className="mt-1.5 block truncate font-mono text-[11px] text-flood hover:underline">
              {profile?.display_name ?? user.email}
            </Link>
          </div>
          <div className="px-1 font-mono text-[10px] text-onpitch-mute">
            {profile?.is_admin ? `API today · ${apiToday ?? 0}/75000` : "18+ · Bet responsibly"}
          </div>
          <SignOutButton />
        </div>
      </aside>

      {/* main column: scrollable content + fixed footer; mobile tab bar overlays the bottom */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* overflow-x-hidden: without an explicit x-rule, overflow-y-auto makes x resolve to auto too,
            so any too-wide child (e.g. a long agent card) produced a horizontal scrollbar. Clipping x
            here kills sideways scroll app-wide; sticky headers (this is their scroll container) and the
            fixed nav/FAB/drawers are unaffected. */}
        <div className="no-scrollbar flex-1 overflow-x-hidden overflow-y-auto pb-[72px] md:pb-0">{children}</div>
        <Footer className="hidden md:block" />
        <MobileNav
          items={mobileNav}
          planLabel={planLabel}
          name={profile?.display_name ?? user.email ?? ""}
          usage={apiToday ?? 0}
          upgradeHref={profile?.plan !== "pro_max" ? upgradeHref : null}
          isAdmin={profile?.is_admin ?? false}
        />
      </div>

      {/* floating live-games peek — rides along on every page except the tracker itself */}
      <LiveGamesFab />
      {/* mobile-only middle-right shortcut to the agent feed */}
      <AgentFab />
      {/* plays a short chime when a push arrives and this tab is focused */}
      <PushChime />
      {/* app-like soft-ask for notification permission on first launch when installed */}
      <InstallPushPrompt userId={user.id} />
      {/* install-the-PWA ask for browser users (mutually exclusive with the prompt above:
          this renders only when NOT installed, that one only when installed) */}
      <InstallNudge />
      {/* prompts a reload when an already-open app is behind a new deploy */}
      <UpdateWatcher />
      {/* one founder question at a time, targeted server-side by what the user actually did */}
      <FounderQuestion />
    </div>
    </ConfirmProvider>
  );
}
