"use client";

// The push stage of the tracker nudge ladder: a user actively tracking games with NO push
// subscription is watching them blind — kick-off, goal alerts and the landed/missed verdict
// all go silent. This card enables push in place (one tap → OS dialog → subscribed), and it
// works in a plain browser tab, unlike InstallPushPrompt which only fires as an installed
// app. Politeness: one lifecycle card at a time — when this device can't do push (iOS tab),
// permission is OS-blocked, or the user dismissed it, we render the `fallback` card instead.
import { useEffect, useState, type ReactNode } from "react";
import { createClient } from "@/lib/supabase/client";
import { pushSupported, subscribeThisDevice } from "@/lib/push";

const DISMISS_KEY = "onside_nudge_push_dismissed";

export default function PushNudge({ userId, hasPush, fallback }: { userId: string; hasPush: boolean; fallback?: ReactNode }) {
  const supabase = createClient();
  const [state, setState] = useState<"checking" | "show" | "fallback" | "on">("checking");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (hasPush || !pushSupported() || Notification.permission === "denied") { setState("fallback"); return; }
    try { if (localStorage.getItem(DISMISS_KEY)) { setState("fallback"); return; } } catch { /* ignore */ }
    setState("show");
  }, [hasPush]);

  async function enable() {
    setBusy(true);
    setErr(null);
    const res = await subscribeThisDevice(supabase, userId);
    setBusy(false);
    if (res.ok) { setState("on"); return; }
    if (res.reason === "denied") { dismiss(); return; } // OS-blocked now — nothing more to ask
    if (res.reason === "dismissed") return; // they closed the OS dialog — card stays, no nag
    setErr(res.message ?? "Couldn't enable notifications.");
  }

  function dismiss() {
    try { localStorage.setItem(DISMISS_KEY, "1"); } catch { /* ignore */ }
    setState("fallback");
  }

  if (state === "checking") return null;
  if (state === "fallback") return <>{fallback ?? null}</>;

  if (state === "on") {
    return (
      <div className="mx-auto mt-4 max-w-2xl rounded-2xl border border-grass/40 bg-pitch-2 p-5">
        <p className="font-mono text-[10.5px] font-bold uppercase tracking-[0.2em] text-grass">Notifications on</p>
        <p className="mt-1.5 text-[13.5px] leading-relaxed text-onpitch-mute">
          <span className="font-bold text-chalk">This device is live.</span> Kick-off, goal alerts on your
          bets and the landed/missed verdict now reach you the moment they happen. Fine-tune what arrives in Profile.
        </p>
      </div>
    );
  }

  return (
    <div className="relative mx-auto mt-4 max-w-2xl rounded-2xl border border-white/10 bg-pitch-2 p-5">
      <button
        onClick={dismiss}
        aria-label="Dismiss"
        className="absolute right-3 top-3 rounded-md px-1.5 text-onpitch-mute transition-colors hover:text-chalk"
      >
        ✕
      </button>
      <p className="font-mono text-[10.5px] font-bold uppercase tracking-[0.2em] text-flood">Never watch blind</p>
      <p className="mt-1.5 pr-6 text-[13.5px] leading-relaxed text-onpitch-mute">
        <span className="font-bold text-chalk">Your tracked games can&apos;t reach you.</span> Turn on
        notifications and this device gets kick-off, goal alerts on your bets, and the landed or missed
        verdict the second it settles.
      </p>
      {err && <p className="mt-2 font-mono text-[11px] text-brick">{err}</p>}
      <div className="mt-3.5">
        <button
          onClick={enable}
          disabled={busy}
          className="rounded-xl bg-flood px-4 py-2 text-[13.5px] font-bold text-ink transition-transform hover:-translate-y-0.5 disabled:opacity-60"
        >
          {busy ? "Turning on…" : "🔔 Turn on notifications"}
        </button>
      </div>
    </div>
  );
}
