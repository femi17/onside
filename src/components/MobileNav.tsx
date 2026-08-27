"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import SignOutButton from "@/components/SignOutButton";

type NavItem = { label: string; href: string };

const ICON = "h-5 w-5";

function TrackerIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className={ICON} aria-hidden="true">
      <rect x="4" y="4" width="16" height="6" rx="2" />
      <rect x="4" y="14" width="16" height="6" rx="2" />
    </svg>
  );
}
function AccasIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={ICON} aria-hidden="true">
      <path d="M12 3l8 4-8 4-8-4 8-4z" />
      <path d="M4 12l8 4 8-4" />
      <path d="M4 17l8 4 8-4" />
    </svg>
  );
}
function PlusIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" className={ICON} aria-hidden="true">
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  );
}
function MenuIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className={ICON} aria-hidden="true">
      <line x1="4" y1="7" x2="20" y2="7" />
      <line x1="4" y1="12" x2="20" y2="12" />
      <line x1="4" y1="17" x2="20" y2="17" />
    </svg>
  );
}

const TABS = [
  { href: "/tracker", label: "Tracker", icon: <TrackerIcon /> },
  { href: "/accumulators", label: "Accas", icon: <AccasIcon /> },
  { href: "/add", label: "Add", icon: <PlusIcon />, accent: true },
];

export default function MobileNav({
  items,
  planLabel,
  name,
  usage,
  upgradeHref = null,
  isAdmin = false,
}: {
  items: NavItem[];
  planLabel: string;
  name: string;
  usage: number;
  upgradeHref?: string | null;
  isAdmin?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();
  const close = () => setOpen(false);

  return (
    <>
      {/* bottom tab bar — mobile only (sidebar takes over from md up) */}
      <nav className="fixed inset-x-0 bottom-0 z-40 flex items-stretch justify-around border-t border-white/10 bg-pitch/95 pb-[env(safe-area-inset-bottom)] backdrop-blur md:hidden">
        {TABS.map((tab) => {
          const active = pathname === tab.href;
          return (
            <Link
              key={tab.href}
              href={tab.href}
              prefetch={false}
              className={`flex flex-1 flex-col items-center gap-1 py-2.5 font-mono text-[10px] uppercase tracking-wide transition-colors ${
                tab.accent ? "text-flood" : active ? "text-flood" : "text-onpitch-mute"
              }`}
            >
              <span
                className={`flex h-9 w-9 items-center justify-center rounded-xl ${
                  tab.accent ? "bg-flood text-ink" : active ? "bg-pitch-2 text-flood" : "text-onpitch-mute"
                }`}
              >
                {tab.icon}
              </span>
              {tab.label}
            </Link>
          );
        })}
        <button
          onClick={() => setOpen(true)}
          className="flex flex-1 flex-col items-center gap-1 py-2.5 font-mono text-[10px] uppercase tracking-wide text-onpitch-mute"
        >
          <span className="flex h-9 w-9 items-center justify-center rounded-xl">
            <MenuIcon />
          </span>
          Menu
        </button>
      </nav>

      {/* overflow sheet — full nav, plan, sign out */}
      <div className={`fixed inset-0 z-50 md:hidden ${open ? "" : "pointer-events-none"}`} aria-hidden={!open}>
        <div
          onClick={close}
          className={`absolute inset-0 bg-ink/60 transition-opacity motion-reduce:transition-none ${open ? "opacity-100" : "opacity-0"}`}
        />
        <aside
          className={`absolute inset-x-0 bottom-0 flex max-h-[85%] flex-col rounded-t-2xl border-t border-white/10 bg-pitch p-6 pb-[calc(1.5rem+env(safe-area-inset-bottom))] shadow-2xl transition-transform duration-300 motion-reduce:transition-none ${
            open ? "translate-y-0" : "translate-y-full"
          }`}
        >
          <div className="mb-4 flex shrink-0 items-center justify-between">
            <Link href="/" onClick={close} className="flex items-center gap-2.5">
              <span className="glyph" />
              <span className="font-disp text-lg font-extrabold tracking-tight text-chalk">
                ON<span className="text-flood">SIDE</span>
              </span>
            </Link>
            <button
              onClick={close}
              aria-label="Close menu"
              className="flex h-9 w-9 items-center justify-center rounded-lg bg-pitch-2 font-mono text-lg text-onpitch-mute"
            >
              ×
            </button>
          </div>

          <nav className="no-scrollbar flex flex-1 flex-col gap-0.5 overflow-y-auto">
            {items.map((n) => {
              const active = n.href !== "#" && pathname === n.href;
              return (
                <Link
                  key={n.label}
                  href={n.href}
                  prefetch={false}
                  onClick={close}
                  className={`flex items-center gap-3 rounded-[10px] px-3 py-2.5 text-sm font-semibold transition ${
                    active ? "bg-pitch-2 text-chalk" : "text-onpitch-mute hover:bg-pitch-2 hover:text-onpitch"
                  }`}
                >
                  <span className={`h-2 w-2 rounded-sm ${active ? "bg-flood" : "bg-current opacity-50"}`} />
                  {n.label}
                </Link>
              );
            })}
          </nav>

          <div className="mt-4 flex shrink-0 flex-col gap-3 border-t border-white/10 pt-4">
            <div className="rounded-xl border border-white/15 bg-pitch-2 p-3.5">
              <div className="flex items-center justify-between gap-2">
                <Link href="/profile" prefetch={false} onClick={close} className="font-mono text-[10px] uppercase tracking-wide text-onpitch-mute transition-colors hover:text-chalk">
                  Your plan · profile
                </Link>
                {upgradeHref && (
                  <Link href={upgradeHref} prefetch={false} onClick={close} className="font-mono text-[10px] font-bold uppercase tracking-wide text-flood transition-colors hover:text-flood-deep">
                    Upgrade &rarr;
                  </Link>
                )}
              </div>
              <Link href="/profile" prefetch={false} onClick={close} className="mt-1 block">
                <div className="font-bold text-chalk">{planLabel}</div>
                <div className="mt-1.5 truncate font-mono text-[11px] text-flood">{name}</div>
              </Link>
            </div>
            <div className="px-1 font-mono text-[10px] text-onpitch-mute">
              {isAdmin ? `API today · ${usage}/75000` : "18+ · Bet responsibly"}
            </div>
            <SignOutButton />
          </div>
        </aside>
      </div>
    </>
  );
}
