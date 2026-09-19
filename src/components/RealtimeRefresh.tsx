"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

// Refreshes the page on live DB changes. We subscribe ONLY to `tickets` (RLS-scoped to this user, so
// it carries just their own bets) for instant settlement updates. We deliberately do NOT subscribe to
// `fixtures` / `fixture_stats`: those are high-write internal tables (fixtures alone takes millions of
// score/status updates), and having them in the realtime publication made the server decode every
// live-game write worldwide — the top Disk-IO / CPU sink (2026-09-19). They were removed from the
// publication; live scores now refresh on the 60s interval below and the match clock ticks client-side
// (see adjustElapsed), so a goal shows within ~a minute. Tighten the interval if snappier scores are
// wanted, weighed against server-render load.
export default function RealtimeRefresh({ fixtureIds = [] }: { fixtureIds?: number[] }) {
  const router = useRouter();
  const key = fixtureIds.join(","); // stable dependency (re-subscribe when the tracked set changes)
  useEffect(() => {
    const supabase = createClient();

    // collapse a burst of change events into at most one refresh per window
    let timer: ReturnType<typeof setTimeout> | null = null;
    const refresh = () => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        router.refresh();
      }, 1200);
    };

    const channel = supabase
      .channel("onside-live")
      // tickets are RLS-scoped to the current user, so this only carries their own bets
      .on("postgres_changes", { event: "*", schema: "public", table: "tickets" }, refresh)
      .subscribe();

    // primary path for live score/stat updates now that fixtures aren't pushed: poll a fresh render
    // every 60s (also the reconnect safety net). Long enough that it isn't itself a load.
    const fallback = setInterval(() => router.refresh(), 60000);
    return () => {
      if (timer) clearTimeout(timer);
      supabase.removeChannel(channel);
      clearInterval(fallback);
    };
  }, [router, key]);
  return null;
}
