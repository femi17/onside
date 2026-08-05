"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

// Subscribes to the live DB changes the poller writes and refreshes on the spot — but ONLY for
// the fixtures actually shown on this page. Previously it watched the UNFILTERED global
// `fixture_stats` feed, so every stat write for every live game worldwide fired a
// router.refresh() (which re-runs the whole server render). During match windows that was a
// refresh storm that made navigation crawl. We now bind per tracked fixture (filtered
// server-side) and coalesce bursts into a single refresh.
export default function RealtimeRefresh({ fixtureIds = [] }: { fixtureIds?: number[] }) {
  const router = useRouter();
  const key = fixtureIds.join(","); // stable dependency
  useEffect(() => {
    const supabase = createClient();
    const ids = key ? key.split(",") : [];

    // collapse a burst of change events into at most one refresh per window
    let timer: ReturnType<typeof setTimeout> | null = null;
    const refresh = () => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        router.refresh();
      }, 1200);
    };

    let channel = supabase
      .channel("onside-live")
      // tickets are RLS-scoped to the current user, so this only carries their own bets
      .on("postgres_changes", { event: "*", schema: "public", table: "tickets" }, refresh);

    // per-game bindings: a goal (fixtures) or a corner/momentum change (fixture_stats) for a game
    // on THIS page updates immediately, without subscribing to the worldwide live feed
    for (const id of ids) {
      channel = channel
        .on("postgres_changes", { event: "UPDATE", schema: "public", table: "fixtures", filter: `id=eq.${id}` }, refresh)
        .on("postgres_changes", { event: "*", schema: "public", table: "fixture_stats", filter: `fixture_id=eq.${id}` }, refresh);
    }
    channel.subscribe();

    // safety net if the socket drops; long enough that it isn't itself a load
    const fallback = setInterval(() => router.refresh(), 60000);
    return () => {
      if (timer) clearTimeout(timer);
      supabase.removeChannel(channel);
      clearInterval(fallback);
    };
  }, [router, key]);
  return null;
}
