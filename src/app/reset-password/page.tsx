"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import Footer from "@/components/Footer";

export default function ResetPasswordPage() {
  const supabase = createClient();
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<"checking" | "ready" | "invalid">("checking");
  const [msg, setMsg] = useState<string | null>(null);

  // /auth/callback exchanged the recovery code for a session before forwarding here, so a valid
  // link means we have a signed-in user to update. No session = the link was bad or expired.
  useEffect(() => {
    (async () => {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      setStatus(user ? "ready" : "invalid");
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (password !== confirm) {
      setMsg("Those passwords don't match.");
      return;
    }
    setBusy(true);
    setMsg(null);
    const { error } = await supabase.auth.updateUser({ password });
    setBusy(false);
    if (error) {
      setMsg(error.message);
      return;
    }
    // updating the password signs them in — send them into the app
    router.push("/tracker");
    router.refresh();
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

        <h1 className="font-disp text-3xl font-bold text-chalk">Set a new password.</h1>

        {status === "invalid" ? (
          <>
            <p className="mt-2 text-sm text-onpitch-mute">
              This reset link is invalid or has expired. Request a fresh one and open it on this device.
            </p>
            <Link href="/forgot-password" className="mt-6 text-sm text-flood hover:underline">
              Send a new link
            </Link>
          </>
        ) : (
          <>
            <p className="mt-2 text-sm text-onpitch-mute">Pick something you&apos;ll remember — at least 6 characters.</p>
            <form onSubmit={submit} className="mt-6 flex flex-col gap-3">
              <input
                type="password"
                required
                minLength={6}
                placeholder="New password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="rounded-xl border border-white/15 bg-pitch-2 px-4 py-3 text-chalk placeholder:text-onpitch-mute focus:outline-none focus:ring-2 focus:ring-flood"
              />
              <input
                type="password"
                required
                minLength={6}
                placeholder="Confirm new password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                className="rounded-xl border border-white/15 bg-pitch-2 px-4 py-3 text-chalk placeholder:text-onpitch-mute focus:outline-none focus:ring-2 focus:ring-flood"
              />
              <button
                type="submit"
                disabled={busy || status !== "ready"}
                className="rounded-xl bg-flood px-4 py-3 font-bold text-ink disabled:opacity-60"
              >
                {busy ? "…" : "Update password"}
              </button>
            </form>
            {msg && <p className="mt-4 font-mono text-xs text-brick">{msg}</p>}
          </>
        )}
      </div>
      <Footer />
    </>
  );
}
