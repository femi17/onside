"use client";

// The danger zone on Profile: permanent, self-service account deletion. Two deliberate
// frictions before anything happens — an explicit consequences list, then typing DELETE —
// because this is the one action in the product with no undo. The edge function only ever
// deletes the caller's own account (from their JWT), so nothing here passes a user id.
import { useState } from "react";
import { createClient } from "@/lib/supabase/client";

export default function DeleteAccount() {
  const supabase = createClient();
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function deleteForever() {
    if (confirm.trim().toUpperCase() !== "DELETE") return;
    setBusy(true);
    setErr(null);
    const { data, error } = await supabase.functions.invoke("delete-account", { method: "POST" });
    if (error || !data?.ok) {
      setBusy(false);
      setErr(data?.error ?? error?.message ?? "Couldn't delete the account — try again.");
      return;
    }
    // the account is gone; clear the local session and land on the public site
    await supabase.auth.signOut();
    window.location.href = "/";
  }

  return (
    <section className="mt-4 rounded-2xl border border-brick/40 bg-chalk p-5 text-ink shadow-xl">
      <div className="mb-1 font-disp text-[17px] font-bold text-brick">Danger zone</div>
      {!open ? (
        <>
          <p className="text-[13px] leading-relaxed text-ink-mute">
            Delete your account and everything in it, forever. This cannot be undone.
          </p>
          <button
            onClick={() => setOpen(true)}
            className="mt-3 rounded-xl border border-brick/50 px-4 py-2 text-[13.5px] font-bold text-brick transition-colors hover:bg-brick/10"
          >
            Delete my account…
          </button>
        </>
      ) : (
        <>
          <p className="text-[13px] leading-relaxed text-ink-mute">This permanently removes:</p>
          <ul className="mt-2 flex flex-col gap-1 text-[13px] leading-relaxed text-ink-mute">
            <li>• your agents and every pick they delivered</li>
            <li>• your tracked bets, accumulators and slip uploads</li>
            <li>• your community posts, comments and likes</li>
            <li>• your profile, notification and Telegram links</li>
          </ul>
          <p className="mt-2 text-[13px] leading-relaxed text-ink-mute">
            There is no undo and no recovery. If you have an active paid plan, it stops billing
            with the account.
          </p>
          <label className="mt-3 block font-mono text-[11px] font-bold uppercase tracking-wide text-ink-mute">
            Type DELETE to confirm
          </label>
          <input
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            placeholder="DELETE"
            className="mt-1.5 w-full rounded-lg border border-brick/40 bg-white px-3 py-2 font-mono text-sm text-ink focus:outline-none"
          />
          {err && <p className="mt-2 font-mono text-[11px] text-brick">{err}</p>}
          <div className="mt-3 flex items-center gap-2.5">
            <button
              onClick={deleteForever}
              disabled={busy || confirm.trim().toUpperCase() !== "DELETE"}
              className="rounded-xl bg-brick px-4 py-2 text-[13.5px] font-bold text-white transition hover:brightness-110 disabled:opacity-40"
            >
              {busy ? "Deleting…" : "Delete forever"}
            </button>
            <button
              onClick={() => { setOpen(false); setConfirm(""); setErr(null); }}
              disabled={busy}
              className="rounded-xl px-4 py-2 text-[13.5px] font-semibold text-ink-mute transition hover:bg-ink/5 disabled:opacity-40"
            >
              Keep my account
            </button>
          </div>
        </>
      )}
    </section>
  );
}
