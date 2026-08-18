"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

// Mobile-only floating shortcut to the agent feed — parked middle-right in the thumb zone.
// Hidden on the agent pages themselves (you're already there) and on desktop, where the
// sidebar carries the link. Sparkles = the AI doing the picking.
export default function AgentFab() {
  const pathname = usePathname();
  if (pathname === "/agent" || pathname.startsWith("/agent/")) return null;
  return (
    <Link
      href="/agent"
      aria-label="Open the agent feed"
      title="Your agents' picks"
      className="fixed right-2 top-1/2 z-40 grid h-9 w-9 -translate-y-1/2 place-items-center rounded-full bg-flood text-ink shadow-[0_8px_20px_-8px_rgba(255,180,60,0.9)] ring-2 ring-flood/20 transition-transform active:scale-95 md:hidden"
    >
      {/* bot: antenna + head with eyes and a mouth line */}
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-[18px] w-[18px]" aria-hidden="true">
        <circle cx="12" cy="4" r="1.3" fill="currentColor" stroke="none" />
        <path d="M12 5.3V8" strokeLinecap="round" />
        <rect x="4.5" y="8" width="15" height="11" rx="3.5" />
        <circle cx="9.25" cy="12.5" r="1.15" fill="currentColor" stroke="none" />
        <circle cx="14.75" cy="12.5" r="1.15" fill="currentColor" stroke="none" />
        <path d="M9.5 16h5" strokeLinecap="round" />
      </svg>
    </Link>
  );
}
