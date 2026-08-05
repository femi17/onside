import Link from "next/link";

// The wordmark for the top of a page header on MOBILE only — on desktop the fixed sidebar already
// carries it. Links home, matches the sidebar's glyph + ON·SIDE treatment.
export default function MobileLogo({ className = "" }: { className?: string }) {
  return (
    <Link href="/" className={`mb-3 flex items-center gap-2 md:hidden ${className}`}>
      <span className="glyph" />
      <span className="font-disp text-lg font-extrabold tracking-tight text-chalk">
        ON<span className="text-flood">SIDE</span>
      </span>
    </Link>
  );
}
