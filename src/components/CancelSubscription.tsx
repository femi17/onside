"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useConfirm } from "@/components/ConfirmDialog";

// A quiet "Cancel subscription" action for the profile plan card. Confirms, hits the server (which
// disables the Paystack subscription), then refreshes so the card reflects the change.
export default function CancelSubscription() {
  const router = useRouter();
  const confirm = useConfirm();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null); // non-error confirmation / info
  const [done, setDone] = useState(false); // hide the button once there's nothing left to do

  async function cancel() {
    if (!(await confirm({
      title: "Cancel subscription?",
      body: "You'll keep your current plan until the end of the paid period, then move to Free.",
      confirmLabel: "Cancel subscription",
      cancelLabel: "Keep plan",
      tone: "danger",
    }))) return;
    setBusy(true);
    setMsg(null);
    setNote(null);
    try {
      const res = await fetch("/api/paystack/cancel", { method: "POST" });
      const body = await res.json();
      if (!res.ok) {
        setMsg(body.error ?? "Couldn't cancel — try again.");
        setBusy(false);
        return;
      }
      // the plan is already non-recurring (one-off) — nothing was disabled, just reassure the user
      if (body.nothingToCancel) {
        setNote(body.message ?? "Your plan won't renew.");
        setDone(true);
        setBusy(false);
        return;
      }
      setNote("Subscription cancelled — you keep your plan until it expires.");
      setDone(true);
      setBusy(false);
      router.refresh();
    } catch {
      setMsg("Couldn't cancel — try again.");
      setBusy(false);
    }
  }

  return (
    <div className="mt-3">
      {!done && (
        <button
          onClick={cancel}
          disabled={busy}
          className="text-[12.5px] font-semibold text-brick transition-opacity hover:underline disabled:opacity-50"
        >
          {busy ? "Cancelling…" : "Cancel subscription"}
        </button>
      )}
      {note && <p className="font-mono text-[11px] text-ink-mute">{note}</p>}
      {msg && <p className="mt-1 font-mono text-[11px] text-brick">{msg}</p>}
    </div>
  );
}
