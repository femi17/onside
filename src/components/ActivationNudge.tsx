import Link from "next/link";
import RecipeRail, { type RecipeStats } from "@/components/RecipeRail";

// The in-app arm of the nudge ladder: shown ONLY to users with an empty tracker AND no
// agents (the "activate" state the email/push nudges target). It replaces a bare empty
// state with the two next steps, and disappears forever the moment either is taken —
// no dismissal needed, acting IS the dismissal. The starter-recipe rail (shared with the
// /strategies empty state) kills the blank-page problem that stalls most first agents.

export type { RecipeStats };

export default function ActivationNudge({ recipes }: { recipes?: RecipeStats | null }) {
  return (
    <div className="mx-auto mt-4 max-w-2xl rounded-2xl border border-flood/30 bg-pitch-2 p-6">
      <p className="font-mono text-[10.5px] font-bold uppercase tracking-[0.2em] text-flood">Get started</p>
      <h2 className="mt-2 font-disp text-xl font-extrabold leading-snug text-chalk">
        Your tracker is waiting for its first slip.
      </h2>
      <p className="mt-2 text-[13.5px] leading-relaxed text-onpitch-mute">
        Snap your next betslip — one screenshot and every leg tracks itself live, settled
        exactly like the bookie settles it. Or put an AI agent on your leagues.
      </p>
      <div className="mt-4 flex flex-wrap gap-2.5">
        <Link
          href="/add"
          className="rounded-xl bg-flood px-5 py-2.5 text-[14px] font-bold text-ink transition-transform hover:-translate-y-0.5"
        >
          Upload a betslip
        </Link>
        <Link
          href="/strategies/new"
          className="rounded-xl border border-white/15 px-5 py-2.5 text-[14px] font-bold text-chalk transition-colors hover:border-white/30"
        >
          Build an AI agent
        </Link>
      </div>

      <div className="mt-5 border-t border-white/10 pt-4 empty:hidden">
        <RecipeRail recipes={recipes} tone="dark" />
      </div>
    </div>
  );
}
