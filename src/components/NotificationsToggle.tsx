"use client";

// Push notifications opt-in (profile · Delivery). Subscribes this device via the service worker +
// VAPID, stores the subscription (RLS own-rows), and can fire a test. Disable unsubscribes + deletes.
import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";

const VAPID = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY ?? "";

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const arr = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
  return arr;
}

export default function NotificationsToggle({ userId }: { userId: string }) {
  const supabase = createClient();
  const [supported, setSupported] = useState(true);
  const [on, setOn] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    const ok = typeof window !== "undefined" && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
    setSupported(ok);
    if (!ok) return;
    (async () => {
      const reg = await navigator.serviceWorker.ready.catch(() => null);
      const sub = reg ? await reg.pushManager.getSubscription() : null;
      setOn(!!sub && Notification.permission === "granted");
    })();
  }, []);

  async function sendTest() {
    const { error } = await supabase.functions.invoke("send-push", {
      body: { title: "Onside", body: "Push is working ✅ Your agent's picks will land here.", url: "/agent" },
    });
    setMsg(error ? `Enabled, but the test push failed: ${error.message}` : "Test notification sent — check your device.");
  }

  async function enable() {
    setBusy(true); setMsg(null);
    try {
      if (!VAPID) { setMsg("Push isn't configured on this build yet."); return; }
      const perm = await Notification.requestPermission();
      if (perm !== "granted") {
        setMsg(perm === "denied" ? "Notifications are blocked — enable them in your browser/site settings." : "Permission wasn't granted.");
        return;
      }
      const reg = await navigator.serviceWorker.ready;
      let sub = await reg.pushManager.getSubscription();
      if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(VAPID) as BufferSource });
      const j = sub.toJSON();
      const { error } = await supabase.from("push_subscriptions").upsert(
        { user_id: userId, endpoint: sub.endpoint, p256dh: j.keys?.p256dh ?? "", auth: j.keys?.auth ?? "", user_agent: navigator.userAgent },
        { onConflict: "endpoint" },
      );
      if (error) { setMsg(error.message); return; }
      setOn(true);
      await sendTest();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Couldn't enable notifications.");
    } finally {
      setBusy(false);
    }
  }

  async function disable() {
    setBusy(true); setMsg(null);
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        await supabase.from("push_subscriptions").delete().eq("endpoint", sub.endpoint);
        await sub.unsubscribe();
      }
      setOn(false);
    } catch {
      setMsg("Couldn't turn notifications off.");
    } finally {
      setBusy(false);
    }
  }

  if (!supported) {
    return (
      <p className="mt-2 font-mono text-[11px] leading-relaxed text-ink-mute">
        This browser doesn&apos;t support push. On iPhone, install Onside to your home screen first (Share → Add to Home Screen), then turn this on.
      </p>
    );
  }

  return (
    <div className="mt-2">
      <button onClick={on ? disable : enable} disabled={busy} role="switch" aria-checked={on} className="flex w-full items-center gap-3 text-left disabled:opacity-60">
        <span className={`relative h-[26px] w-[46px] flex-none rounded-full transition ${on ? "bg-grass-deep" : "bg-ink/20"}`}>
          <span className={`absolute top-[3px] h-5 w-5 rounded-full bg-white shadow transition-all ${on ? "left-[23px]" : "left-[3px]"}`} />
        </span>
        <span className="min-w-0">
          <span className="block text-sm font-bold text-ink">
            Push notifications {on && <span className="ml-1 font-mono text-[10px] text-grass-deep">on</span>}
          </span>
          <span className="mt-0.5 block text-[12.5px] text-ink-mute">Get your agent&apos;s picks and results on this device.</span>
        </span>
      </button>
      {on && (
        <button onClick={sendTest} disabled={busy} className="mt-2 font-mono text-[11px] font-bold text-flood-deep hover:underline disabled:opacity-50">
          Send a test
        </button>
      )}
      {msg && <p className="mt-1.5 font-mono text-[11px] text-ink-mute">{msg}</p>}
    </div>
  );
}
