"use client";

import { useState } from "react";
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
    // signup with no session = email confirmation is on; nothing to route yet
    if (mode === "signup" && !data.session) {
      setBusy(false);
      setMsg("Check your email to confirm your account, then sign in.");
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
      </div>
      <Footer />
    </>
  );
}
