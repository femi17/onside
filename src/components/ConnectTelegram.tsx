"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";

// Deep-link connect: mint a one-time code onto the profile, then open the bot with ?start=<code>.
// The telegram webhook matches the code and sets telegram_chat_id + telegram_linked_at (bot:
// @OnsideAIbot). Since that happens over in Telegram, we poll the profile after opening the bot —
// and re-check whenever the user switches back to this tab — so the button flips to "Connected"
// on its own, with no page refresh. `onLinked` lets a parent (e.g. onboarding) react to the link.
export default function ConnectTelegram({ linked, onLinked }: { linked: boolean; onLinked?: () => void }) {
  const supabase = createClient();
  const [isLinked, setIsLinked] = useState(linked);
  const [busy, setBusy] = useState(false);
  const [waiting, setWaiting] = useState(false); // opened the bot, watching for the link to land
  const [err, setErr] = useState<string | null>(null);
  const onLinkedRef = useRef(onLinked);
  onLinkedRef.current = onLinked;

  // keep in sync if a parent later reports the account as linked
  useEffect(() => {
    if (linked) setIsLinked(true);
  }, [linked]);

  const checkLinked = useCallback(async (): Promise<boolean> => {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return false;
    const { data } = await supabase.from("profiles").select("telegram_linked_at").eq("id", user.id).maybeSingle();
    return !!data?.telegram_linked_at;
  }, [supabase]);

  const markLinked = useCallback(() => {
    setIsLinked(true);
    setWaiting(false);
    onLinkedRef.current?.();
  }, []);

  // while waiting, poll every 3s and re-check on focus/visibility; give up after ~3 min
  useEffect(() => {
    if (!waiting) return;
    const poll = setInterval(async () => {
      if (await checkLinked()) markLinked();
    }, 3000);
    const onFocus = async () => {
      if (await checkLinked()) markLinked();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    const giveUp = setTimeout(() => setWaiting(false), 180000);
    return () => {
      clearInterval(poll);
      clearTimeout(giveUp);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
    };
  }, [waiting, checkLinked, markLinked]);

  async function connect() {
    setBusy(true);
    setErr(null);
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) { setErr("Please sign in again."); setBusy(false); return; }
    const code = crypto.randomUUID().replace(/-/g, "").slice(0, 24);
    const { error } = await supabase.from("profiles").update({ telegram_link_code: code }).eq("id", user.id);
    if (error) { setErr("Couldn't start linking. Try again."); setBusy(false); return; }
    window.open(`https://t.me/OnsideAIbot?start=${code}`, "_blank", "noopener");
    setBusy(false);
    setWaiting(true); // start watching for the tap-Start to complete the link
  }

  if (isLinked) {
    return (
      <div className="mt-3 rounded-xl border border-emerald-500/30 bg-emerald-50 px-4 py-3 text-[13.5px] font-semibold text-emerald-700">
        Telegram connected. Your agent picks will arrive as DMs.
      </div>
    );
  }

  return (
    <div className="mt-3">
      <button
        onClick={connect}
        disabled={busy}
        className="w-full rounded-xl bg-flood px-4 py-2.5 font-bold text-ink transition-transform hover:-translate-y-0.5 disabled:opacity-60"
      >
        {busy ? "Opening Telegram…" : waiting ? "Waiting for Telegram…" : "Connect Telegram"}
      </button>
      {waiting ? (
        <button
          onClick={async () => { if (await checkLinked()) markLinked(); }}
          className="mt-2 w-full text-center text-[12.5px] font-semibold text-flood-deep hover:underline"
        >
          Tapped Start in Telegram? Check now
        </button>
      ) : err ? (
        <p className="mt-2 text-[12.5px] text-red-600">{err}</p>
      ) : (
        <p className="mt-2 text-[12px] text-ink-mute">
          Opens @OnsideAIbot — tap Start there to finish linking, then your agent picks arrive as DMs.
        </p>
      )}
    </div>
  );
}
