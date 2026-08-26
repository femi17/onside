// Shared Web Push helpers used by NotificationSettings (Profile) and InstallPushPrompt (launch).
// Keeps the subscribe flow in one place: request permission → subscribe via the SW + VAPID → store
// the subscription (RLS own-rows) → seed a default notification_prefs row so opt-in/out reflects the
// documented defaults (goals off, everything else on).
import type { SupabaseClient } from "@supabase/supabase-js";

export const VAPID = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY ?? "";

// Category defaults MUST mirror send-push's CATEGORY_DEFAULT_ON so the UI and the sender agree.
export type NotifCategory = "agent_picks" | "agent_games" | "results" | "kickoff" | "full_time" | "goals" | "cards" | "build_up" | "community" | "swing";
export const CATEGORY_DEFAULTS: Record<NotifCategory, boolean> = {
  agent_picks: false, agent_games: false, results: true, kickoff: true, full_time: true, goals: false, cards: false, build_up: false, community: true, swing: true,
};
export const CATEGORY_META: { key: NotifCategory; label: string; desc: string }[] = [
  { key: "agent_picks", label: "Agent predictions", desc: "When your agent submits new picks (off by default — picks always show in the app)" },
  { key: "agent_games", label: "Agent game alerts", desc: "Live build-up and results for your agents' picked games (off by default)" },
  { key: "results", label: "Results", desc: "When your picks land or miss" },
  { key: "swing", label: "Bet swings", desc: "A goal puts your 1X2/double-chance pick ahead or behind — only verdict-changing goals" },
  { key: "kickoff", label: "Kick-off", desc: "When a match you're on starts" },
  { key: "full_time", label: "Full-time", desc: "When a match you're on ends" },
  { key: "goals", label: "Goals", desc: "Every goal in a match you're on (can get busy)" },
  { key: "cards", label: "Cards", desc: "Yellow 🟨 and red 🟥 cards in a match you're on (can get busy)" },
  { key: "build_up", label: "Live build-up", desc: "Progress on your goals/corners bets as it happens — building up or counting down (busy)" },
  { key: "community", label: "Community replies", desc: "When someone replies to your post" },
];

export function pushSupported(): boolean {
  return typeof window !== "undefined" && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

export function isInstalled(): boolean {
  if (typeof window === "undefined") return false;
  return window.matchMedia?.("(display-mode: standalone)").matches
    || (navigator as unknown as { standalone?: boolean }).standalone === true;
}

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const arr = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
  return arr;
}

export type SubscribeResult = { ok: boolean; reason?: "unsupported" | "unconfigured" | "denied" | "dismissed" | "error"; message?: string };

// Request permission, subscribe this device, persist it, and seed default prefs. Idempotent.
export async function subscribeThisDevice(supabase: SupabaseClient, userId: string): Promise<SubscribeResult> {
  if (!pushSupported()) return { ok: false, reason: "unsupported" };
  if (!VAPID) return { ok: false, reason: "unconfigured", message: "Push isn't configured on this build yet." };
  try {
    const perm = await Notification.requestPermission();
    if (perm !== "granted") {
      return perm === "denied"
        ? { ok: false, reason: "denied", message: "Notifications are blocked — enable them in your device/site settings." }
        : { ok: false, reason: "dismissed" };
    }
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(VAPID) as BufferSource });
    const j = sub.toJSON();
    const { error } = await supabase.from("push_subscriptions").upsert(
      { user_id: userId, endpoint: sub.endpoint, p256dh: j.keys?.p256dh ?? "", auth: j.keys?.auth ?? "", user_agent: navigator.userAgent },
      { onConflict: "endpoint" },
    );
    if (error) return { ok: false, reason: "error", message: error.message };
    // seed a prefs row (DB column defaults fill the rest) so the categories reflect real defaults.
    // ignoreDuplicates so we never clobber a user's existing choices.
    await supabase.from("notification_prefs").upsert({ user_id: userId }, { onConflict: "user_id", ignoreDuplicates: true });
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: "error", message: e instanceof Error ? e.message : "Couldn't enable notifications." };
  }
}

export async function unsubscribeThisDevice(supabase: SupabaseClient): Promise<void> {
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  if (sub) {
    await supabase.from("push_subscriptions").delete().eq("endpoint", sub.endpoint);
    await sub.unsubscribe();
  }
}
