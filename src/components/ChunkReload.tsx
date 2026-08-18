"use client";

import { useEffect } from "react";

// After every deploy, the new build's JS chunks get new hashed filenames. A tab still running
// the PREVIOUS build asks for the old names on navigation, the CDN no longer has them, and the
// router throws ChunkLoadError / "failed to fetch dynamically imported module" — the page then
// looks broken until a manual reload. This detects exactly that failure class and reloads ONCE
// to pick up the fresh build. Loop-guarded via sessionStorage — but storage itself THROWS in
// Safari private mode and some in-app webviews (Instagram/Facebook), so every touch is wrapped:
// this guard must never be the thing that crashes the page.
const GUARD = "onside-chunk-reload";
const CHUNK_ERR = /ChunkLoadError|Loading chunk .* failed|dynamically imported module|Importing a module script failed|error loading dynamically imported/i;

const safeGet = (k: string): string | null => { try { return sessionStorage.getItem(k); } catch { return null; } };
const safeSet = (k: string, v: string) => { try { sessionStorage.setItem(k, v); } catch { /* storage blocked — reload still works, just unguarded once */ } };
const safeDel = (k: string) => { try { sessionStorage.removeItem(k); } catch { /* ditto */ } };

export default function ChunkReload() {
  useEffect(() => {
    // survived 15s after a chunk-triggered reload → the new build works; re-arm for next deploy
    const disarm = window.setTimeout(() => safeDel(GUARD), 15_000);
    const reload = () => {
      if (safeGet(GUARD)) return;
      safeSet(GUARD, "1");
      window.location.reload();
    };
    const onError = (e: ErrorEvent) => {
      if (CHUNK_ERR.test(e.message ?? "")) reload();
    };
    const onRejection = (e: PromiseRejectionEvent) => {
      const m = e.reason instanceof Error ? e.reason.message : String(e.reason ?? "");
      if (CHUNK_ERR.test(m)) reload();
    };
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    return () => {
      window.clearTimeout(disarm);
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
    };
  }, []);
  return null;
}
