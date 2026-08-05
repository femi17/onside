"use client";

import { useEffect, useState } from "react";

// Re-renders once a minute so live match clocks tick smoothly (69'→70'→71')
// between the 2-minute polls — no extra API calls, just distributing the last
// poll's data across the minute.
export function useMinuteTick(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);
  return now;
}
