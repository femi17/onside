"use client";

// Opt in / out of the cross-member leaderboard (default OFF). Publishing shares your agents' edge
// vs market — aggregate only, under your handle — with everyone. The RPC also recomputes your rows
// immediately so you appear without waiting for the nightly rebuild.
import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

export default function LeaderboardOptIn({ on, canOptIn }: { on: boolean; canOptIn: boolean }) {
  const supabase = createClient();
  const router = useRouter();
  const [val, setVal] = useState(on);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function toggle() {
    if (!canOptIn) { setMsg("Pick a handle first (join the feed)."); return; }
    const next = !val;
    setBusy(true); setMsg(null);
    const { error } = await supabase.rpc("set_leaderboard_opt_in", { p_on: next });
    setBusy(false);
    if (error) { setMsg(error.message); return; }
    setVal(next);
    router.refresh();
  }

  return (
    <div className="mt-3 border-t border-white/10 pt-3">
      <button onClick={toggle} disabled={busy} role="switch" aria-checked={val} className="flex w-full items-center gap-3 text-left disabled:opacity-60">
        <span className={`relative h-[26px] w-[46px] flex-none rounded-full transition ${val ? "bg-grass-deep" : "bg-white/20"}`}>
          <span className={`absolute top-[3px] h-5 w-5 rounded-full bg-white shadow transition-all ${val ? "left-[23px]" : "left-[3px]"}`} />
        </span>
        <span className="min-w-0">
          <span className="block text-[13px] font-semibold text-chalk">Publish my agents here</span>
          <span className="mt-0.5 block font-mono text-[10.5px] leading-snug text-onpitch-mute">
            Your agents&apos; daily picks (top 5) post to the feed under your handle, and your edge vs market
            joins this board (board needs 20+ settled picks). Off by default.
          </span>
        </span>
      </button>
      {msg && <p className="mt-2 font-mono text-[11px] text-brick">{msg}</p>}
    </div>
  );
}
