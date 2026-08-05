"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";

// Change password from inside the app (already signed in) — updates the Supabase auth user.
// Collapsed by default; expands to a new-password + confirm form.
export default function ChangePassword() {
  const supabase = createClient();
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [ok, setOk] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setMsg(null);
    if (password.length < 6) {
      setMsg("Use at least 6 characters.");
      return;
    }
    if (password !== confirm) {
      setMsg("Those passwords don't match.");
      return;
    }
    setBusy(true);
    const { error } = await supabase.auth.updateUser({ password });
    setBusy(false);
    if (error) {
      setMsg(error.message);
      return;
    }
    setPassword("");
    setConfirm("");
    setOpen(false);
    setOk(true);
  }

  if (!open) {
    return (
      <div className="mt-3">
        <button
          onClick={() => { setOpen(true); setOk(false); }}
          className="text-[12.5px] font-semibold text-flood-deep transition-opacity hover:underline"
        >
          Change password
        </button>
        {ok && <p className="mt-1 font-mono text-[11px] text-grass-deep">✓ Password updated.</p>}
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="mt-3 flex flex-col gap-2">
      <input
        type="password"
        autoComplete="new-password"
        required
        minLength={6}
        placeholder="New password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        className="rounded-lg border border-ink/20 bg-white px-3 py-2 text-sm text-ink placeholder:text-ink-mute focus:outline-none focus:ring-2 focus:ring-flood"
      />
      <input
        type="password"
        autoComplete="new-password"
        required
        minLength={6}
        placeholder="Confirm new password"
        value={confirm}
        onChange={(e) => setConfirm(e.target.value)}
        className="rounded-lg border border-ink/20 bg-white px-3 py-2 text-sm text-ink placeholder:text-ink-mute focus:outline-none focus:ring-2 focus:ring-flood"
      />
      <div className="flex items-center gap-2">
        <button type="submit" disabled={busy} className="rounded-lg bg-ink px-4 py-2 font-bold text-chalk-2 disabled:opacity-50">
          {busy ? "Saving…" : "Update password"}
        </button>
        <button type="button" onClick={() => { setOpen(false); setMsg(null); setPassword(""); setConfirm(""); }} className="text-[12.5px] font-semibold text-ink-mute hover:text-ink">
          Cancel
        </button>
      </div>
      {msg && <p className="font-mono text-[11px] text-brick">{msg}</p>}
    </form>
  );
}
