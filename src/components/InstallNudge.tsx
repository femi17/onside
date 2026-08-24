"use client";

// PWA install nudge — the missing top of the push funnel (on iPhone, push REQUIRES the
// installed app). Shows only in a browser tab (never when already installed — the sibling
// InstallPushPrompt owns that world), only from a user's SECOND distinct day in the app
// (first-visit installs convert poorly and feel pushy), and never again once dismissed.
//   Chromium (Android/desktop): captures beforeinstallprompt → one-tap native install sheet.
//   iOS Safari: no install API exists — shows the two-step Share → Add to Home Screen path.
//   Anything else: renders nothing.
import { useEffect, useRef, useState } from "react";
import { isInstalled } from "@/lib/push";

const DISMISS_KEY = "onside-install-nudge-dismissed";
const DAYS_KEY = "onside-install-nudge-days";

type BipEvent = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: string }> };

function secondDayReached(): boolean {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const days: string[] = JSON.parse(localStorage.getItem(DAYS_KEY) ?? "[]");
    if (!days.includes(today)) {
      days.push(today);
      localStorage.setItem(DAYS_KEY, JSON.stringify(days.slice(-14)));
    }
    return days.length >= 2;
  } catch {
    return false;
  }
}

export default function InstallNudge() {
  const [mode, setMode] = useState<"hidden" | "android" | "ios">("hidden");
  const [busy, setBusy] = useState(false);
  const bip = useRef<BipEvent | null>(null);

  useEffect(() => {
    if (isInstalled()) return;
    try { if (localStorage.getItem(DISMISS_KEY)) return; } catch { /* ignore */ }
    const eligible = secondDayReached();
    const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
    if (isIOS) {
      if (eligible) { const t = setTimeout(() => setMode("ios"), 1500); return () => clearTimeout(t); }
      return;
    }
    // Chromium fires this only when install criteria are met and the app isn't installed
    const onBip = (e: Event) => {
      e.preventDefault();
      bip.current = e as BipEvent;
      if (eligible) setMode("android");
    };
    window.addEventListener("beforeinstallprompt", onBip);
    const onInstalled = () => { dismiss(); };
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onBip);
      window.removeEventListener("appinstalled", onInstalled);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function dismiss() {
    try { localStorage.setItem(DISMISS_KEY, "1"); } catch { /* ignore */ }
    setMode("hidden");
  }

  async function install() {
    const e = bip.current;
    if (!e) { dismiss(); return; }
    setBusy(true);
    try {
      await e.prompt();
      await e.userChoice; // accepted or dismissed — either way the ask is spent
    } catch { /* the sheet failing to open is not worth an error state */ }
    setBusy(false);
    dismiss();
  }

  if (mode === "hidden") return null;

  return (
    <div className="fixed inset-x-0 bottom-0 z-[60] px-3 pb-3 pt-2 md:inset-x-auto md:bottom-6 md:right-6 md:w-[360px] md:px-0 md:pb-0">
      <div className="mx-auto max-w-md rounded-2xl border border-ink/10 bg-chalk p-4 shadow-2xl md:max-w-none">
        <div className="flex items-start gap-3">
          <span className="grid h-10 w-10 flex-none place-items-center rounded-xl bg-flood/15 text-xl">📲</span>
          <div className="min-w-0">
            <p className="text-sm font-bold text-ink">Put Onside on your home screen</p>
            {mode === "android" ? (
              <p className="mt-0.5 text-[12.5px] leading-relaxed text-ink-mute">
                One tap from your slips, live scores and your agents — full-screen, with push notifications.
              </p>
            ) : (
              <p className="mt-0.5 text-[12.5px] leading-relaxed text-ink-mute">
                Tap <b className="text-ink">Share</b> (the square with the ↑) then{" "}
                <b className="text-ink">Add to Home Screen</b>. Full-screen app, with push notifications.
              </p>
            )}
          </div>
        </div>
        <div className="mt-3 flex items-center gap-2">
          {mode === "android" ? (
            <button
              onClick={install}
              disabled={busy}
              className="flex-1 rounded-xl bg-flood px-4 py-2.5 text-sm font-bold text-ink transition hover:brightness-110 disabled:opacity-60"
            >
              {busy ? "Opening…" : "Install Onside"}
            </button>
          ) : (
            <button onClick={dismiss} className="flex-1 rounded-xl bg-flood px-4 py-2.5 text-sm font-bold text-ink transition hover:brightness-110">
              Got it
            </button>
          )}
          <button onClick={dismiss} disabled={busy} className="rounded-xl px-4 py-2.5 text-sm font-semibold text-ink-mute transition hover:bg-ink/5 disabled:opacity-60">
            Not now
          </button>
        </div>
      </div>
    </div>
  );
}
