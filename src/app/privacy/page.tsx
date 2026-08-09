import type { Metadata } from "next";
import Link from "next/link";
import Footer from "@/components/Footer";
import BackButton from "@/components/BackButton";

export const metadata: Metadata = {
  title: "Privacy Policy — Onside",
  description: "How Onside collects, uses, and protects your personal data.",
};

const COMPANY = process.env.NEXT_PUBLIC_COMPANY_NAME ?? "Thinka Platforms LTD";
const SUPPORT = process.env.NEXT_PUBLIC_SUPPORT_EMAIL ?? "support@onside.com.ng";
const UPDATED = "5 August 2026";

function H({ children }: { children: React.ReactNode }) {
  return <h2 className="mt-8 font-disp text-xl font-bold text-chalk">{children}</h2>;
}
function P({ children }: { children: React.ReactNode }) {
  return <p className="mt-3 text-[14.5px] leading-relaxed text-onpitch-mute">{children}</p>;
}
function LI({ children }: { children: React.ReactNode }) {
  return <li className="text-[14.5px] leading-relaxed text-onpitch-mute">{children}</li>;
}

export default function PrivacyPage() {
  return (
    <>
      <div className="mx-auto w-full max-w-3xl flex-1 px-6 py-12">
        <div className="mb-8 flex items-center justify-between gap-3">
          <Link href="/" className="flex items-center gap-3">
            <span className="glyph" />
            <span className="font-disp text-xl font-extrabold tracking-tight text-chalk">
              ON<span className="text-flood">SIDE</span>
            </span>
          </Link>
          <BackButton />
        </div>

        <h1 className="font-disp text-4xl font-bold tracking-tight text-chalk">Privacy Policy</h1>
        <p className="mt-2 font-mono text-[12px] text-onpitch-mute">Last updated {UPDATED}</p>

        <P>
          This policy explains how {COMPANY} (&quot;Onside&quot;) collects, uses, and protects your information when you
          use our software. We collect only what we need to run the service.
        </P>

        <H>1. Information we collect</H>
        <ul className="mt-3 flex list-disc flex-col gap-1.5 pl-5">
          <LI><b className="text-chalk">Account:</b> email address, display name, and (optional) a public community handle and avatar colour.</LI>
          <LI><b className="text-chalk">Your activity:</b> the bets/slips you track, the agents you build, your predictions and results, and any community posts, comments, or reactions.</LI>
          <LI><b className="text-chalk">Billing:</b> your plan and billing status, plus payment references from Paystack (customer/subscription identifiers). <b className="text-chalk">We do not collect or store your card numbers</b> — card data is handled entirely by Paystack.</LI>
          <LI><b className="text-chalk">Device / notifications:</b> if you enable push notifications, a browser push subscription for your device; if you link Telegram, your Telegram chat ID.</LI>
          <LI><b className="text-chalk">Technical:</b> basic logs needed to operate and secure the service.</LI>
        </ul>

        <H>2. How we use your information</H>
        <ul className="mt-3 flex list-disc flex-col gap-1.5 pl-5">
          <LI>To provide and run Onside — track your bets, run your agents, and deliver picks and results.</LI>
          <LI>To process your subscription and payments (via Paystack).</LI>
          <LI>To send notifications you&apos;ve asked for (in-app, push, or Telegram).</LI>
          <LI>To operate the community and keep it safe (moderation, reports, blocking).</LI>
          <LI>To secure the service, prevent abuse, and meet legal obligations.</LI>
        </ul>

        <H>3. Who we share it with (processors)</H>
        <P>We don&apos;t sell your data. We share the minimum necessary with trusted providers who process it on our behalf:</P>
        <ul className="mt-3 flex list-disc flex-col gap-1.5 pl-5">
          <LI><b className="text-chalk">Paystack</b> — payment processing and subscription billing.</LI>
          <LI><b className="text-chalk">Supabase</b> — database, authentication, and backend hosting.</LI>
          <LI><b className="text-chalk">Vercel</b> — application hosting.</LI>
          <LI><b className="text-chalk">Anthropic (Claude)</b> — AI processing of your agent rules and uploaded betslips.</LI>
          <LI><b className="text-chalk">API-Football</b> — fixtures, results, and odds data.</LI>
          <LI><b className="text-chalk">Telegram</b> — only if you choose to link it for delivery.</LI>
        </ul>

        <H>4. Cookies &amp; local storage</H>
        <P>
          We use essential cookies/local storage to keep you signed in and remember preferences. We don&apos;t use them
          for third-party advertising.
        </P>

        <H>5. Data retention</H>
        <P>
          We keep your data while your account is active and as needed to provide the service and meet legal or
          accounting obligations. You can delete your content or ask us to close your account.
        </P>

        <H>6. Your rights</H>
        <P>
          You can access and update your profile in-app, cancel your subscription, turn off notifications, and request a
          copy or deletion of your data by emailing us. We&apos;ll respond within a reasonable time.
        </P>

        <H>7. Security</H>
        <P>
          We use industry-standard measures (encryption in transit, access controls, row-level security on your data).
          No system is perfectly secure, but we work to protect your information.
        </P>

        <H>8. Children</H>
        <P>Onside is for adults (18+). We do not knowingly collect data from anyone under 18.</P>

        <H>9. Changes</H>
        <P>We may update this policy; material changes will be notified in-app or by email.</P>

        <H>10. Contact</H>
        <P>
          For any privacy request or question, email <a href={`mailto:${SUPPORT}`} className="text-flood hover:underline">{SUPPORT}</a>.
          See also our <Link href="/terms" className="text-flood hover:underline">Terms of Service</Link>.
        </P>
      </div>
      <Footer />
    </>
  );
}
