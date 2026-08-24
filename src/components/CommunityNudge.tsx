"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

// Post-activation nudge: once a user is tracking (the ActivationNudge's job is done), the
// tracker offers the two rooms the crowd lives in — the in-app community and the @onsideai
// Telegram channel. One strip, one ask at a time in the lifecycle. Politeness rules:
// dismissible forever (localStorage), never shown alongside the activation card, and it
// retires itself once the user has BOTH joined the community and linked Telegram.
const DISMISS_KEY = "onside_nudge_community_dismissed";

export default function CommunityNudge({ optedIn, telegramLinked }: { optedIn: boolean; telegramLinked: boolean }) {
  const [show, setShow] = useState(false);
  useEffect(() => {
    setShow(localStorage.getItem(DISMISS_KEY) !== "1");
  }, []);
  if (!show || (optedIn && telegramLinked)) return null;

  return (
    <div className="relative mx-auto mt-4 max-w-2xl rounded-2xl border border-white/10 bg-pitch-2 p-5">
      <button
        onClick={() => { localStorage.setItem(DISMISS_KEY, "1"); setShow(false); }}
        aria-label="Dismiss"
        className="absolute right-3 top-3 rounded-md px-1.5 text-onpitch-mute transition-colors hover:text-chalk"
      >
        ✕
      </button>
      <p className="font-mono text-[10.5px] font-bold uppercase tracking-[0.2em] text-flood">The Onside crowd</p>
      <p className="mt-1.5 pr-6 text-[13.5px] leading-relaxed text-onpitch-mute">
        <span className="font-bold text-chalk">You&apos;re not tracking alone.</span> Compare slips and
        show off your agent in the community — and get the day&apos;s picks and results in the Telegram channel.
      </p>
      <div className="mt-3.5 flex flex-wrap gap-2.5">
        {!optedIn && (
          <Link href="/community" className="rounded-xl bg-flood px-4 py-2 text-[13.5px] font-bold text-ink transition-transform hover:-translate-y-0.5">
            Join the community
          </Link>
        )}
        <a
          href="https://t.me/onsideai"
          target="_blank"
          rel="noopener noreferrer"
          className="rounded-xl border border-white/15 px-4 py-2 text-[13.5px] font-bold text-chalk transition-colors hover:border-white/30"
        >
          Join @onsideai on Telegram
        </a>
      </div>
    </div>
  );
}
