"use client";

// App-like permission prompt. When Onside is running as an installed PWA and notification permission
// is still "default", we show a one-time soft-ask on launch (a tap is required to open the real OS
// dialog — browsers don't allow a silent grant on install). "Not now" is remembered so we don't nag.
import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { pushSupported, isInstalled, subscribeThisDevice } from "@/lib/push";

const DISMISS_KEY = "onside-push-prompt-dismissed";

export default function InstallPushPrompt({ userId }: { userId: string }) {
  const supabase = createClient();
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!pushSupported() || !isInstalled()) return;
    if (Notification.permission !== "default") return; // already granted or blocked
    try { if (localStorage.getItem(DISMISS_KEY)) return; } catch { /* ignore */ }
    const t = setTimeout(() => setShow(true), 1200); // let the app paint first
    return () => clearTimeout(t);
  }, []);

  async function enable() {
    setBusy(true); setErr(null);
    const res = await subscribeThisDevice(supabase, userId);
    setBusy(false);
    if (res.ok) { setShow(false); return; }
    if (res.reason === "denied") { dismiss(); return; } // OS-blocked: nothing more to ask
    if (res.reason === "dismissed") { setShow(false); return; } // they closed the OS dialog
    setErr(res.message ?? "Couldn't enable notifications.");
  }

  function dismiss() {
    try { localStorage.setItem(DISMISS_KEY, "1"); } catch { /* ignore */ }
    setShow(false);
  }

  if (!show) return null;

  return (
    <div className="fixed inset-x-0 bottom-0 z-[60] px-3 pb-3 pt-2 md:inset-x-auto md:right-6 md:bottom-6 md:w-[360px] md:px-0 md:pb-0">
      <div className="mx-auto max-w-md rounded-2xl border border-ink/10 bg-chalk p-4 shadow-2xl md:max-w-none">
        <div className="flex items-start gap-3">
          <span className="grid h-10 w-10 flex-none place-items-center rounded-xl bg-grass-deep/10 text-xl">🔔</span>
          <div className="min-w-0">
            <p className="text-sm font-bold text-ink">Turn on notifications</p>
            <p className="mt-0.5 text-[12.5px] leading-relaxed text-ink-mute">
              Get your agent&apos;s picks, kick-offs, results and more — right on this device. You choose exactly what in Profile.
            </p>
          </div>
        </div>
        {err && <p className="mt-2 font-mono text-[11px] text-red-600">{err}</p>}
        <div className="mt-3 flex items-center gap-2">
          <button
            onClick={enable}
            disabled={busy}
            className="flex-1 rounded-xl bg-grass-deep px-4 py-2.5 text-sm font-bold text-white transition hover:brightness-110 disabled:opacity-60"
          >
            {busy ? "Turning on…" : "Turn on"}
          </button>
          <button onClick={dismiss} disabled={busy} className="rounded-xl px-4 py-2.5 text-sm font-semibold text-ink-mute transition hover:bg-ink/5 disabled:opacity-60">
            Not now
          </button>
        </div>
      </div>
    </div>
  );
}
