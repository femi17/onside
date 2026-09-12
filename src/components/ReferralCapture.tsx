"use client";
import { useEffect } from "react";
import { createClient } from "@/lib/supabase/client";

// Reads the `onside_ref` cookie (set by middleware from /?ref=CODE) once the user is signed in and
// inside the app, credits the referrer via attribute_referral (safe: once, never self), then clears
// the cookie so it can't re-fire. Renders nothing.
export default function ReferralCapture() {
  useEffect(() => {
    const m = document.cookie.match(/(?:^|; )onside_ref=([^;]+)/);
    if (!m) return;
    const code = decodeURIComponent(m[1]);
    const sb = createClient();
    sb.rpc("attribute_referral", { p_code: code }).finally(() => {
      document.cookie = "onside_ref=; Max-Age=0; path=/";
    });
  }, []);
  return null;
}
