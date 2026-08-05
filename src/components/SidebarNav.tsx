"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

export default function SidebarNav({ items }: { items: { label: string; href: string }[] }) {
  const pathname = usePathname();
  return (
    <nav className="flex flex-col gap-1">
      <p className="mb-2 ml-3 font-mono text-[10.5px] uppercase tracking-[0.2em] text-onpitch-mute">Matchday</p>
      {items.map((n) => {
        const active = n.href !== "#" && (pathname === n.href || pathname.startsWith(`${n.href}/`));
        return (
          <Link
            key={n.label}
            href={n.href}
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
  );
}
