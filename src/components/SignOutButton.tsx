"use client";

import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

export default function SignOutButton() {
  const router = useRouter();
  async function signOut() {
    await createClient().auth.signOut();
    router.push("/login");
    router.refresh();
  }
  return (
    <button
      onClick={signOut}
      className="w-full rounded-lg border border-white/10 px-3 py-2 text-left text-sm font-semibold text-onpitch-mute hover:bg-pitch-2 hover:text-chalk"
    >
      Sign out
    </button>
  );
}
