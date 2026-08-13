"use client";

// One-tap "Agent game alerts" switch on the Agent feed — writes the `agent_games` notification_prefs
// category (live build-up + results for the agent's picked games; off by default). Turning it on also
// subscribes this device to push if it isn't already, so the toggle actually results in notifications.
// Full per-category control still lives in Profile · Notifications.
import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { pushSupported, subscribeThisDevice } from "@/lib/push";

export default function AgentAlertsToggle({ userId }: { userId: string }) {
  const supabase = createClient();
  const [supported, setSupported] = useState(true);
  const [on, setOn] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    setSupported(pushSupported());
    (async () => {
      const { data } = await supabase.from("notification_prefs").select("agent_games").eq("user_id", userId).maybeSingle();
      setOn(!!data?.agent_games);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function toggle() {
    const next = !on;
    setBusy(true);
    setNote(null);
    try {
      // turning ON with no push subscription would silently do nothing — subscribe this device first
      if (next) {
        const perm = typeof Notification !== "undefined" ? Notification.permission : "denied";
        const reg = "serviceWorker" in navigator ? await navigator.serviceWorker.ready.catch(() => null) : null;
        const sub = reg ? await reg.pushManager.getSubscription() : null;
        if (perm !== "granted" || !sub) {
          const res = await subscribeThisDevice(supabase, userId);
          if (!res.ok) {
            if (res.reason !== "dismissed") setNote(res.message ?? "Couldn't turn on notifications.");
            setBusy(false);
            return;
          }
        }
      }
      const { error } = await supabase.from("notification_prefs").upsert(
        { user_id: userId, agent_games: next, updated_at: new Date().toISOString() },
        { onConflict: "user_id" },
      );
      if (error) setNote(error.message);
      else {
        setOn(next);
        setNote(next ? "On — live updates & results for your agents' games." : "Off.");
      }
    } finally {
      setBusy(false);
    }
  }

  if (!supported) return null;

  return (
    <div className="mt-3 flex flex-wrap items-center gap-x-2.5 gap-y-1">
      <button
        onClick={toggle}
        disabled={busy}
        role="switch"
        aria-checked={on}
        aria-label="Agent game alerts"
        className="flex items-center gap-2.5 disabled:opacity-60"
      >
        <span className={`relative h-[22px] w-[38px] flex-none rounded-full transition ${on ? "bg-grass-deep" : "bg-white/20"}`}>
          <span className={`absolute top-[3px] h-4 w-4 rounded-full bg-white shadow transition-all ${on ? "left-[19px]" : "left-[3px]"}`} />
        </span>
        <span className="font-mono text-[11px] uppercase tracking-wide text-chalk">
          Game alerts{" "}
          <span className={on ? "text-grass" : "text-onpitch-mute"}>{on ? "on" : "off"}</span>
        </span>
      </button>
      {note && <span className="font-mono text-[10.5px] text-onpitch-mute">{note}</span>}
    </div>
  );
}
