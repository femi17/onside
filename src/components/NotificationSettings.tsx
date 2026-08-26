"use client";

// Push notifications (Profile · Delivery). Master device toggle + per-category preferences.
// Enabling subscribes this device (VAPID/SW) and seeds default prefs; the category switches write to
// notification_prefs, which send-push honours for every alert. Goals are opt-in; the rest opt-out.
import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import {
  CATEGORY_DEFAULTS, CATEGORY_META, type NotifCategory,
  pushSupported, subscribeThisDevice, unsubscribeThisDevice,
} from "@/lib/push";

export default function NotificationSettings({ userId }: { userId: string }) {
  const supabase = createClient();
  const [supported, setSupported] = useState(true);
  const [on, setOn] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [prefs, setPrefs] = useState<Record<NotifCategory, boolean>>({ ...CATEGORY_DEFAULTS });
  const [savingKey, setSavingKey] = useState<NotifCategory | null>(null);

  useEffect(() => {
    const ok = pushSupported();
    setSupported(ok);
    if (!ok) return;
    (async () => {
      const reg = await navigator.serviceWorker.ready.catch(() => null);
      const sub = reg ? await reg.pushManager.getSubscription() : null;
      setOn(!!sub && Notification.permission === "granted");
      const { data } = await supabase.from("notification_prefs").select("*").eq("user_id", userId).maybeSingle();
      if (data) {
        setPrefs({
          agent_picks: data.agent_picks, agent_games: data.agent_games ?? false, results: data.results, kickoff: data.kickoff,
          full_time: data.full_time, goals: data.goals, cards: data.cards ?? false,
          build_up: data.build_up ?? false, community: data.community,
          swing: data.swing ?? true, // verdict-flipping goals — default ON
        });
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function sendTest() {
    const { error } = await supabase.functions.invoke("send-push", {
      body: { title: "Onside", body: "Push is working ✅ Your alerts will land here.", url: "/tracker" },
    });
    setMsg(error ? `Enabled, but the test push failed: ${error.message}` : "Test notification sent — check your device.");
  }

  async function enable() {
    setBusy(true); setMsg(null);
    const res = await subscribeThisDevice(supabase, userId);
    if (res.ok) {
      setOn(true);
      setPrefs({ ...CATEGORY_DEFAULTS });
      await sendTest();
    } else if (res.reason !== "dismissed") {
      setMsg(res.message ?? "Couldn't enable notifications.");
    }
    setBusy(false);
  }

  async function disable() {
    setBusy(true); setMsg(null);
    try { await unsubscribeThisDevice(supabase); setOn(false); }
    catch { setMsg("Couldn't turn notifications off."); }
    finally { setBusy(false); }
  }

  async function toggleCat(key: NotifCategory) {
    const next = !prefs[key];
    setPrefs((p) => ({ ...p, [key]: next }));
    setSavingKey(key);
    const { error } = await supabase.from("notification_prefs").upsert(
      { user_id: userId, [key]: next, updated_at: new Date().toISOString() }, { onConflict: "user_id" },
    );
    if (error) { setPrefs((p) => ({ ...p, [key]: !next })); setMsg(error.message); }
    setSavingKey(null);
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
      {/* master device toggle */}
      <button onClick={on ? disable : enable} disabled={busy} role="switch" aria-checked={on} className="flex w-full items-center gap-3 text-left disabled:opacity-60">
        <span className={`relative h-[26px] w-[46px] flex-none rounded-full transition ${on ? "bg-grass-deep" : "bg-ink/20"}`}>
          <span className={`absolute top-[3px] h-5 w-5 rounded-full bg-white shadow transition-all ${on ? "left-[23px]" : "left-[3px]"}`} />
        </span>
        <span className="min-w-0">
          <span className="block text-sm font-bold text-ink">
            Push notifications {on && <span className="ml-1 font-mono text-[10px] text-grass-deep">on</span>}
          </span>
          <span className="mt-0.5 block text-[12.5px] text-ink-mute">Get alerts on this device. Choose what you hear about below.</span>
        </span>
      </button>

      {/* per-category preferences — only meaningful once push is on */}
      {on && (
        <div className="mt-4 space-y-1 border-t border-ink/10 pt-3">
          <p className="mb-1 font-mono text-[10px] uppercase tracking-wide text-ink-mute">Notify me about</p>
          {CATEGORY_META.map(({ key, label, desc }) => {
            const active = prefs[key];
            return (
              <button
                key={key}
                onClick={() => toggleCat(key)}
                disabled={savingKey === key}
                role="switch"
                aria-checked={active}
                className="flex w-full items-center gap-3 rounded-lg px-1 py-2 text-left transition hover:bg-ink/[0.03] disabled:opacity-60"
              >
                <span className={`relative h-[22px] w-[38px] flex-none rounded-full transition ${active ? "bg-grass-deep" : "bg-ink/20"}`}>
                  <span className={`absolute top-[3px] h-4 w-4 rounded-full bg-white shadow transition-all ${active ? "left-[19px]" : "left-[3px]"}`} />
                </span>
                <span className="min-w-0">
                  <span className="block text-[13px] font-semibold text-ink">{label}</span>
                  <span className="block text-[11.5px] text-ink-mute">{desc}</span>
                </span>
              </button>
            );
          })}
        </div>
      )}

      {on && (
        <button onClick={sendTest} disabled={busy} className="mt-3 font-mono text-[11px] font-bold text-flood-deep hover:underline disabled:opacity-50">
          Send a test
        </button>
      )}
      {msg && <p className="mt-1.5 font-mono text-[11px] text-ink-mute">{msg}</p>}
    </div>
  );
}
