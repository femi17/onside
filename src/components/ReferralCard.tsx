"use client";
import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";

type Stats = { code: string; joined: number; subscribed: number; days_earned: number };

// "Invite friends" card on Profile: shows the user's referral link + one-tap WhatsApp/Telegram
// share, and the running tally. Reward (referrer +30d Pro, friend +14d) lands when a friend first
// subscribes — granted server-side in the Paystack verify route.
export default function ReferralCard() {
  const [s, setS] = useState<Stats | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const sb = createClient();
    sb.rpc("my_referral_stats").then(({ data }) => { if (data) setS(data as Stats); });
  }, []);

  const link = s ? `https://onside.com.ng/?ref=${s.code}` : "";
  const msg = `I'm using Onside — AI agents that hunt football value bets, and every pick is graded in public. Join with my link and we both get free Pro 👇\n${link}`;
  const wa = `https://wa.me/?text=${encodeURIComponent(msg)}`;
  const tg = `https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent("I'm using Onside — AI agents that hunt football value bets, graded in public. Join with my link and we both get free Pro 👇")}`;

  async function copy() {
    try { await navigator.clipboard.writeText(link); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* clipboard blocked */ }
  }

  return (
    <section className="mt-4 rounded-2xl bg-chalk p-5 text-ink shadow-xl">
      <div className="mb-1 font-disp text-[17px] font-bold">Invite friends</div>
      <p className="text-[13px] text-ink-mute">
        Share your link — when a friend subscribes, <b className="text-ink">you get 30 days of Pro free</b> and they get 14 days on their first month.
      </p>

      <div className="mt-3 flex items-center gap-2 rounded-xl border border-ink/15 bg-ink/[0.03] p-2.5">
        <span className="min-w-0 flex-1 truncate font-mono text-[12.5px] text-ink">{s ? link : "loading…"}</span>
        <button
          type="button" onClick={copy} disabled={!s}
          className="flex-none rounded-lg bg-ink px-3 py-1.5 font-mono text-[11px] font-bold uppercase text-chalk disabled:opacity-40"
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>

      <div className="mt-2.5 flex gap-2">
        <a href={s ? wa : undefined} target="_blank" rel="noopener noreferrer"
           className="flex-1 rounded-xl bg-grass-deep px-3 py-2.5 text-center font-bold text-chalk transition-transform hover:-translate-y-0.5">
          Share on WhatsApp
        </a>
        <a href={s ? tg : undefined} target="_blank" rel="noopener noreferrer"
           className="flex-1 rounded-xl bg-flood px-3 py-2.5 text-center font-bold text-ink transition-transform hover:-translate-y-0.5">
          Telegram
        </a>
      </div>

      <div className="mt-3 flex items-center justify-between border-t border-ink/10 pt-3 font-mono text-[12px] text-ink-mute">
        <span><b className="text-ink">{s?.joined ?? 0}</b> joined</span>
        <span><b className="text-ink">{s?.subscribed ?? 0}</b> subscribed</span>
        <span><b className="text-ink">{s?.days_earned ?? 0}</b> free days earned</span>
      </div>
    </section>
  );
}
