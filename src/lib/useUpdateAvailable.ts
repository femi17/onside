"use client";

// Polls for a newer deployment: on mount, when the tab regains focus, and every 5 min. Returns true
// once the live build differs from the one this app is running. No-ops in local dev (build "dev").
import { useEffect, useState } from "react";
import { CURRENT_BUILD, fetchLatestBuild } from "@/lib/version";

export function useUpdateAvailable(): boolean {
  const [stale, setStale] = useState(false);

  useEffect(() => {
    if (CURRENT_BUILD === "dev") return; // no version tracking locally
    let cancelled = false;
    const check = async () => {
      const latest = await fetchLatestBuild();
      if (!cancelled && latest && latest !== CURRENT_BUILD) setStale(true);
    };
    check();
    const iv = setInterval(check, 5 * 60 * 1000);
    const onVis = () => { if (document.visibilityState === "visible") check(); };
    document.addEventListener("visibilitychange", onVis);
    // also nudge the service worker to look for a fresh sw.js while we're at it
    navigator.serviceWorker?.ready?.then((r) => r.update()).catch(() => {});
    return () => { cancelled = true; clearInterval(iv); document.removeEventListener("visibilitychange", onVis); };
  }, []);

  return stale;
}

// SW does no page caching, so a plain reload always pulls the newest bundle from the network.
export function reloadForUpdate() {
  if (typeof window !== "undefined") window.location.reload();
}
