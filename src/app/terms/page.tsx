import type { Metadata } from "next";
import Link from "next/link";
import Footer from "@/components/Footer";
import BackButton from "@/components/BackButton";

export const metadata: Metadata = {
  title: "Terms of Service — Onside",
  description: "The terms governing use of Onside, including subscription billing and payments.",
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

export default function TermsPage() {
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

        <h1 className="font-disp text-4xl font-bold tracking-tight text-chalk">Terms of Service</h1>
        <p className="mt-2 font-mono text-[12px] text-onpitch-mute">Last updated {UPDATED}</p>

        <H>1. What Onside is</H>
        <P>
          Onside is a software product operated by {COMPANY} (&quot;Onside&quot;, &quot;we&quot;, &quot;us&quot;). It helps you
          <b className="text-chalk"> track your own football bets</b> and gives you AI &quot;agents&quot; that scan publicly
          available fixtures and odds for value and deliver suggestions on your schedule.
        </P>
        <P>
          <b className="text-chalk">Onside is not a bookmaker or gambling operator.</b> You cannot place bets, deposit
          money, stake, or receive winnings on Onside. Any actual bets are placed by you, at your own discretion, with
          third-party licensed bookmakers that are entirely separate from Onside. We do not handle betting funds.
        </P>

        <H>2. Eligibility</H>
        <P>
          You must be at least <b className="text-chalk">18 years old</b> (or the legal gambling age in your jurisdiction,
          whichever is higher) and legally permitted to use betting-related tools where you live. By using Onside you
          confirm that you meet these requirements.
        </P>

        <H>3. Your account</H>
        <P>
          You are responsible for your login credentials and for activity under your account. Keep your password secure
          and tell us promptly of any unauthorised use.
        </P>

        <H>4. Subscriptions, billing &amp; payments</H>
        <P>
          Onside offers a free tier and paid subscription plans. <b className="text-chalk">Payments are processed by
          Paystack</b>, our third-party payment processor. We never see or store your full card details.
        </P>
        <p className="mt-4 rounded-xl border border-flood/30 bg-flood/[0.06] p-4 text-[14.5px] leading-relaxed text-chalk">
          <b>What you are paying for:</b> a paid Onside subscription buys access to <b>software features</b> only — for
          example more leagues for your agents, more agents and runs, learning agents, larger predictions, and longer
          history. <b>Payments through Paystack are solely for this software subscription.</b> They are not bets,
          deposits, stakes, top-ups, or gambling of any kind, and no winnings are ever paid out through Onside or Paystack.
        </p>
        <ul className="mt-3 flex list-disc flex-col gap-1.5 pl-5">
          <LI><b className="text-chalk">Plans &amp; pricing (NGN):</b> Free — ₦0; Pro — ₦500/month; Pro Max — ₦1,000/month.</LI>
          <LI><b className="text-chalk">Recurring billing:</b> paid plans renew automatically each month via Paystack until you cancel.</LI>
          <LI><b className="text-chalk">Cancellation:</b> cancel any time from your Profile. You keep your paid plan until the end of the period you&apos;ve already paid for, then move to Free. We do not charge you again after you cancel.</LI>
          <LI><b className="text-chalk">Refunds:</b> subscription fees are generally non-refundable once a billing period has begun, since access is granted immediately. If you were charged in error (e.g. a duplicate charge or a charge after cancellation), contact us at {SUPPORT} within 14 days and we will investigate and refund valid cases.</LI>
          <LI><b className="text-chalk">Failed payments:</b> if a renewal fails, your account moves to the Free plan.</LI>
          <LI><b className="text-chalk">Price changes:</b> we may change prices with reasonable advance notice; changes never apply to a period you have already paid for.</LI>
        </ul>

        <H>5. No guarantees &amp; not financial advice</H>
        <P>
          Onside&apos;s suggestions are probabilistic estimates for information only. They are <b className="text-chalk">not
          financial, investment, or betting advice</b>, and we do not promise any outcome, profit, or winning bet.
          Betting involves real risk of loss. You are solely responsible for any bets you choose to place.
        </P>
        <P>
          <b className="text-chalk">Bet responsibly.</b> Only stake what you can afford to lose. If gambling is affecting
          you or someone you know, please seek help from a responsible-gambling support service.
        </P>

        <H>6. Acceptable use</H>
        <P>
          Don&apos;t misuse Onside: no unlawful use, no attempts to break, overload, reverse-engineer, or gain
          unauthorised access to the service or other users&apos; data, and no abusive, illegal, or harmful content in the
          community. We may remove content and suspend accounts that breach these terms.
        </P>

        <H>7. Community</H>
        <P>
          If you post in the community, you&apos;re responsible for your content and grant us permission to display it
          within Onside. We may moderate, hide, or remove content and may remove access for repeated or serious breaches.
        </P>

        <H>8. Intellectual property</H>
        <P>
          Onside, its software, branding, and content are owned by {COMPANY} and protected by law. We grant you a
          personal, non-transferable licence to use the service under these terms.
        </P>

        <H>9. Termination</H>
        <P>
          You may stop using Onside at any time. We may suspend or terminate access if you breach these terms or where
          required by law. On termination, your right to use the service ends.
        </P>

        <H>10. Liability</H>
        <P>
          To the fullest extent permitted by law, Onside is provided &quot;as is&quot; without warranties, and {COMPANY}
          is not liable for betting losses or for indirect or consequential losses arising from your use of the service.
        </P>

        <H>11. Changes to these terms</H>
        <P>We may update these terms from time to time; material changes will be notified in-app or by email. Continued use means you accept the updated terms.</P>

        <H>12. Contact</H>
        <P>
          Questions about these terms or billing? Email us at <a href={`mailto:${SUPPORT}`} className="text-flood hover:underline">{SUPPORT}</a>.
          See also our <Link href="/privacy" className="text-flood hover:underline">Privacy Policy</Link>.
        </P>
      </div>
      <Footer />
    </>
  );
}
