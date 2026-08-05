"use client";

import { useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import Footer from "@/components/Footer";

export default function ForgotPasswordPage() {
  const supabase = createClient();
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    // the recovery link lands on /auth/callback, which exchanges the code for a session and then
    // forwards to /reset-password where the new password is set
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${location.origin}/auth/callback?next=/reset-password`,
    });
    setBusy(false);
    // don't reveal whether the address has an account — always show the same confirmation
    if (error && !/rate/i.test(error.message)) {
      setMsg(error.message);
      return;
    }
    setSent(true);
  }

  return (
    <>
      <div className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center px-6 py-12">
        <Link href="/" className="mb-8 flex items-center gap-3">
          <span className="glyph" />
          <span className="font-disp text-xl font-extrabold tracking-tight text-chalk">
            ON<span className="text-flood">SIDE</span>
          </span>
        </Link>

        <h1 className="font-disp text-3xl font-bold text-chalk">Reset your password.</h1>

        {sent ? (
          <>
            <p className="mt-2 text-sm text-onpitch-mute">
              If an account exists for <span className="font-semibold text-chalk">{email}</span>, a reset link is on its way.
              Open it on this device to set a new password.
            </p>
            <Link href="/login" className="mt-6 text-sm text-flood hover:underline">
              ← Back to sign in
            </Link>
          </>
        ) : (
          <>
            <p className="mt-2 text-sm text-onpitch-mute">
              Enter your email and we&apos;ll send you a link to set a new one.
            </p>
            <form onSubmit={submit} className="mt-6 flex flex-col gap-3">
              <input
                type="email"
                required
                placeholder="you@email.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="rounded-xl border border-white/15 bg-pitch-2 px-4 py-3 text-chalk placeholder:text-onpitch-mute focus:outline-none focus:ring-2 focus:ring-flood"
              />
              <button
                type="submit"
                disabled={busy}
                className="rounded-xl bg-flood px-4 py-3 font-bold text-ink disabled:opacity-60"
              >
                {busy ? "…" : "Send reset link"}
              </button>
            </form>
            {msg && <p className="mt-4 font-mono text-xs text-brick">{msg}</p>}
            <Link href="/login" className="mt-6 text-center text-sm text-onpitch-mute hover:text-chalk">
              ← Back to sign in
            </Link>
          </>
        )}
      </div>
      <Footer />
    </>
  );
}
