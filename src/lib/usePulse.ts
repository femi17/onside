"use client";

import { useEffect, useRef, useState } from "react";

// Flashes true for ~0.7s whenever the tracked figure changes (a corner/goal lands),
// so the number can "pop" the moment something happens. First render never pulses.
export function usePulse(sig: string | number): boolean {
  const prev = useRef(sig);
  const [on, setOn] = useState(false);
  useEffect(() => {
    if (prev.current !== sig) {
      prev.current = sig;
      setOn(true);
      const id = setTimeout(() => setOn(false), 700);
      return () => clearTimeout(id);
    }
  }, [sig]);
  return on;
}
