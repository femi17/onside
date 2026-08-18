"use client";

import { useEffect } from "react";

// After every deploy, the new build's JS chunks get new hashed filenames. A tab still running
// the PREVIOUS build asks for the old names on navigation, the CDN no longer has them, and the
// router throws ChunkLoadError / "failed to fetch dynamically imported module" — the page then
// looks broken until a manual reload. This detects exactly that failure class and reloads ONCE
// to pick up the fresh build. Loop-guarded: if the reloaded page fails the same way within 15s,
// we don't reload again (a genuinely broken build shouldn't spin).
const GUARD = "onside-chunk-reload";
const CHUNK_ERR = /ChunkLoadError|Loading chunk .* failed|dynamically imported module|Importing a module script failed|error loading dynamically imported/i;

export default function ChunkReload() {
  useEffect(() => {
    // survived 15s after a chunk-triggered reload → the new build works; re-arm for next deploy
    const disarm = window.setTimeout(() => sessionStorage.removeItem(GUARD), 15_000);
    const reload = () => {
      if (sessionStorage.getItem(GUARD)) return;
      sessionStorage.setItem(GUARD, "1");
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
