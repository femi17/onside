"use client";

// Last-seen presence ping. A user who only READS their picks leaves no row anywhere and looks
// churned, so on mount we fire mark_seen() (one (user, day) row, idempotent server-side).
// Throttled to once per hour via localStorage so page-to-page navigation doesn't spam the RPC.
// Fire-and-forget: renders nothing, blocks nothing, swallows every error.
import { useEffect } from "react";
import { createClient } from "@/lib/supabase/client";

const KEY = "onside:seen:at";
const HOUR_MS = 60 * 60 * 1000;

export default function SeenPing() {
  useEffect(() => {
    try {
      const last = Number(localStorage.getItem(KEY) ?? 0);
      if (Number.isFinite(last) && Date.now() - last < HOUR_MS) return;
      localStorage.setItem(KEY, String(Date.now()));
      // thenable builder — attach both handlers so a network/RPC failure never surfaces
      createClient()
        .rpc("mark_seen")
        .then(
          () => {},
          () => {}
        );
    } catch {
      // storage blocked (private mode) or client init failed — presence is best-effort
    }
  }, []);
  return null;
}
