"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import Footer from "@/components/Footer";

export default function LoginPage() {
  const router = useRouter();
  const supabase = createClient();
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // post-signup confirmation state: replaces the form entirely so a slow inbox can't tempt
  // repeat "Create account" clicks (each signUp call re-sends the confirmation email)
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [resendAt, setResendAt] = useState(0); // epoch ms when Resend unlocks

  // 1s tick while the inbox screen shows, so the Resend countdown label stays live
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!sentTo) return;
    const t = setInterval(() => setTick((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, [sentTo]);

  async function handleResend() {
    if (Date.now() < resendAt || !sentTo) return;
    setResendAt(Date.now() + 60_000);
    setMsg(null);
    const { error } = await supabase.auth.resend({ type: "signup", email: sentTo });
    setMsg(error ? error.message : "Sent again — give it a minute.");
  }

  async function handleEmail(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    const fn =
      mode === "signin"
        ? supabase.auth.signInWithPassword({ email, password })
        : supabase.auth.signUp({ email, password });
    const { data, error } = await fn;
    if (error) {
      setBusy(false);
      setMsg(error.message);
      return;
    }
    // signup with no session = email confirmation is on; swap to the check-your-inbox
    // screen (the form disappears — no button left to hammer for more emails)
    if (mode === "signup" && !data.session) {
      setBusy(false);
      setSentTo(email);
      setResendAt(Date.now() + 60_000);
      return;
    }
    // a brand-new account goes straight to onboarding; a returning one lands where it belongs —
    // routing here (instead of always /tracker) avoids the /tracker → /onboarding flash
    if (mode === "signup") {
      setBusy(false);
      router.push("/onboarding");
      router.refresh();
      return;
    }
    let dest = "/tracker";
    const uid = data.user?.id;
    if (uid) {
      const { data: prof } = await supabase.from("profiles").select("onboarded").eq("id", uid).maybeSingle();
      if (prof?.onboarded === false) dest = "/onboarding";
    }
    setBusy(false);
    router.push(dest);
    router.refresh();
  }

  async function handleGoogle() {
    setMsg(null);
    const { error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: `${location.origin}/auth/callback` },
    });
    if (error) setMsg(error.message);
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

      {sentTo ? (
        <>
          <h1 className="font-disp text-3xl font-bold text-chalk">Check your inbox.</h1>
          <p className="mt-2 text-sm text-onpitch-mute">
            We&apos;ve sent a confirmation link to <span className="font-semibold text-chalk">{sentTo}</span>.
            It can take a minute or two — check Spam and Promotions as well.
          </p>
          <button
            onClick={handleResend}
            disabled={Date.now() < resendAt}
            className="mt-6 rounded-xl border border-white/15 bg-white/5 px-4 py-3 font-semibold text-chalk hover:bg-white/10 disabled:opacity-50"
          >
            {Date.now() < resendAt
              ? `Resend available in ${Math.ceil((resendAt - Date.now()) / 1000)}s`
              : "Resend email"}
          </button>
          {msg && <p className="mt-4 font-mono text-xs text-flood">{msg}</p>}
          <button
            onClick={() => { setSentTo(null); setMsg(null); setMode("signin"); }}
            className="mt-6 text-center text-sm text-onpitch-mute hover:text-chalk"
          >
            Wrong email? Start over
          </button>
        </>
      ) : (
        <>
      <h1 className="font-disp text-3xl font-bold text-chalk">
        {mode === "signin" ? "Welcome back." : "Create your account."}
      </h1>
      <p className="mt-2 text-sm text-onpitch-mute">
        {mode === "signin"
          ? "Sign in to your agents and tracked bets."
          : "Free forever for tracking. One agent, hunting daily."}
      </p>

      <button
        onClick={handleGoogle}
        className="mt-6 flex items-center justify-center gap-3 rounded-xl border border-white/15 bg-white/5 px-4 py-3 font-semibold text-chalk hover:bg-white/10"
      >
        <span className="font-bold text-flood">G</span> Continue with Google
      </button>

      <div className="my-5 flex items-center gap-3 text-onpitch-mute">
        <span className="h-px flex-1 bg-white/10" />
        <span className="font-mono text-[11px] uppercase">or</span>
        <span className="h-px flex-1 bg-white/10" />
      </div>

      <form onSubmit={handleEmail} className="flex flex-col gap-3">
        <input
          type="email"
          required
          placeholder="you@email.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="rounded-xl border border-white/15 bg-pitch-2 px-4 py-3 text-chalk placeholder:text-onpitch-mute focus:outline-none focus:ring-2 focus:ring-flood"
        />
        <input
          type="password"
          required
          minLength={6}
          placeholder="Password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="rounded-xl border border-white/15 bg-pitch-2 px-4 py-3 text-chalk placeholder:text-onpitch-mute focus:outline-none focus:ring-2 focus:ring-flood"
        />
        <button
          type="submit"
          disabled={busy}
          className="rounded-xl bg-flood px-4 py-3 font-bold text-ink disabled:opacity-60"
        >
          {busy ? "…" : mode === "signin" ? "Sign in" : "Create account"}
        </button>
      </form>

      {mode === "signin" && (
        <Link href="/forgot-password" className="mt-3 text-center text-[13px] text-onpitch-mute hover:text-chalk">
          Forgot your password?
        </Link>
      )}

      {msg && (
        <p className="mt-4 font-mono text-xs text-flood">{msg}</p>
      )}

      <button
        onClick={() => {
          setMode(mode === "signin" ? "signup" : "signin");
          setMsg(null);
        }}
        className="mt-6 text-center text-sm text-onpitch-mute hover:text-chalk"
      >
        {mode === "signin"
          ? "New here? Create an account"
          : "Already have an account? Sign in"}
      </button>
        </>
      )}
      </div>
      <Footer />
    </>
  );
}
