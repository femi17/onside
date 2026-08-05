"use client";

// In-app chime: when a push arrives and this tab is focused, play a short two-note "ding" via the
// Web Audio API (no audio file needed). The service worker postMessages open tabs on every push.
// Browsers gate audio behind a user gesture, so we arm the AudioContext on first interaction.
import { useEffect, useRef } from "react";

export default function PushChime() {
  const ctxRef = useRef<AudioContext | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const AC = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC || !("serviceWorker" in navigator)) return;

    const ensureCtx = () => {
      if (!ctxRef.current) {
        try { ctxRef.current = new AC(); } catch { return; }
      }
      if (ctxRef.current.state === "suspended") ctxRef.current.resume().catch(() => {});
    };
    // audio can only start after a user gesture — arm the context on the first interaction
    window.addEventListener("pointerdown", ensureCtx, { once: true });
    window.addEventListener("keydown", ensureCtx, { once: true });

    function playChime() {
      const ctx = ctxRef.current;
      if (!ctx || ctx.state !== "running") return;
      const now = ctx.currentTime;
      const notes = [{ f: 880, t: 0 }, { f: 1174.66, t: 0.13 }]; // A5 → D6, a soft rising "ding-dong"
      for (const nt of notes) {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = "sine";
        osc.frequency.value = nt.f;
        const start = now + nt.t;
        gain.gain.setValueAtTime(0.0001, start);
        gain.gain.exponentialRampToValueAtTime(0.16, start + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.32);
        osc.connect(gain).connect(ctx.destination);
        osc.start(start);
        osc.stop(start + 0.36);
      }
    }

    function onMessage(e: MessageEvent) {
      if (e.data?.type !== "onside-push") return;
      if (document.visibilityState === "visible") playChime();
    }
    navigator.serviceWorker.addEventListener("message", onMessage);

    return () => {
      window.removeEventListener("pointerdown", ensureCtx);
      window.removeEventListener("keydown", ensureCtx);
      navigator.serviceWorker.removeEventListener("message", onMessage);
    };
  }, []);

  return null;
}
