"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

// Lightweight "live" refresh: re-runs the server component on an interval so
// tracked bets pick up the poller's updates without a manual reload.
export default function AutoRefresh({ seconds = 20 }: { seconds?: number }) {
  const router = useRouter();
  useEffect(() => {
    const id = setInterval(() => router.refresh(), seconds * 1000);
    return () => clearInterval(id);
  }, [router, seconds]);
  return null;
}
