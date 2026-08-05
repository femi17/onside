"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

// A page header that's transparent at rest and fills in with a body-matching frosted background
// ONLY once the page is scrolled. A 1px sentinel rendered just above the sticky bar tells us when
// the header has left its resting position (IntersectionObserver against the viewport), so the
// header never shows a coloured seam over the body gradient while you're at the top.
export default function StickyHeader({ children, className = "" }: { children: ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [stuck, setStuck] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => setStuck(!e.isIntersecting), { threshold: 0 });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return (
    <>
      <div ref={ref} aria-hidden className="h-px" />
      <div className={`sticky top-0 z-20 transition-colors duration-200 ${stuck ? "bg-pitch/80 backdrop-blur" : ""} ${className}`}>
        {children}
      </div>
    </>
  );
}
