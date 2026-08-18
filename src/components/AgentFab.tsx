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
      className="fixed right-2.5 top-1/2 z-40 grid h-12 w-12 -translate-y-1/2 place-items-center rounded-full bg-flood text-ink shadow-[0_10px_28px_-10px_rgba(255,180,60,0.9)] ring-4 ring-flood/15 transition-transform active:scale-95 md:hidden"
    >
      <svg viewBox="0 0 24 24" fill="currentColor" className="h-6 w-6" aria-hidden="true">
        {/* sparkles — big star + two companions */}
        <path d="M12 3.5c.3 0 .56.2.64.48l.9 3.24a3 3 0 0 0 2.09 2.09l3.24.9a.66.66 0 0 1 0 1.28l-3.24.9a3 3 0 0 0-2.09 2.09l-.9 3.24a.66.66 0 0 1-1.28 0l-.9-3.24a3 3 0 0 0-2.09-2.09l-3.24-.9a.66.66 0 0 1 0-1.28l3.24-.9a3 3 0 0 0 2.09-2.09l.9-3.24a.66.66 0 0 1 .64-.48Z" />
        <path d="M19 3.2c.14 0 .27.1.31.24l.3 1.08c.1.35.37.62.72.72l1.08.3a.32.32 0 0 1 0 .62l-1.08.3a1 1 0 0 0-.72.72l-.3 1.08a.32.32 0 0 1-.62 0l-.3-1.08a1 1 0 0 0-.72-.72l-1.08-.3a.32.32 0 0 1 0-.62l1.08-.3a1 1 0 0 0 .72-.72l.3-1.08A.32.32 0 0 1 19 3.2Z" />
        <path d="M5.5 15.7c.14 0 .26.09.3.23l.26.9c.08.3.31.53.61.61l.9.26a.31.31 0 0 1 0 .6l-.9.26a.85.85 0 0 0-.61.61l-.26.9a.31.31 0 0 1-.6 0l-.26-.9a.85.85 0 0 0-.61-.61l-.9-.26a.31.31 0 0 1 0-.6l.9-.26c.3-.08.53-.31.61-.61l.26-.9a.31.31 0 0 1 .3-.23Z" />
      </svg>
    </Link>
  );
}
