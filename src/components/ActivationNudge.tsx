import Link from "next/link";

// The in-app arm of the nudge ladder: shown ONLY to users with an empty tracker AND no
// agents (the "activate" state the email/push nudges target). It replaces a bare empty
// state with the two next steps, and disappears forever the moment either is taken —
// no dismissal needed, acting IS the dismissal.
//
// Starter recipes kill the blank-page problem that stalls most first agents: one tap opens
// the builder PREFILLED (name + market + a rule that the read-back verifies), under a LIVE
// receipts line from starter_recipes() — the same graded data /record shows publicly. A
// recipe only renders when it clears its evidence bar (n>=15 graded, hit>=60%), so the card
// can never advertise a cold or losing recipe.

export type RecipeStats = Record<string, { graded: number; won: number } | null>;

const RECIPES = [
  {
    key: "safe_double",
    emoji: "🛡️",
    name: "Safe Double",
    what: "The agent picks the strongest double-chance angle per game.",
    market: "dc_best",
    rule: "Only send picks with a model probability of 75% or higher.",
  },
  {
    key: "goals_banker",
    emoji: "🔥",
    name: "Goals Banker",
    what: "Over 1.5 goals, only when the model rates it highly.",
    market: "over_1_5",
    rule: "Only send picks with a model probability of 82% or higher.",
  },
  {
    key: "home_scorers",
    emoji: "⚽",
    name: "Home Scorers",
    what: "Home team to score, screened by the model.",
    market: "home_to_score",
    rule: "Only send picks with a model probability of 85% or higher.",
  },
];

function recipeHref(r: (typeof RECIPES)[number]): string {
  const q = new URLSearchParams({ name: r.name, market: r.market, rule: r.rule });
  return `/strategies/new?${q.toString()}`;
}

export default function ActivationNudge({ recipes }: { recipes?: RecipeStats | null }) {
  const provable = RECIPES.map((r) => {
    const s = recipes?.[r.key];
    if (!s || s.graded < 15) return null;
    const hit = Math.round((s.won / s.graded) * 100);
    return hit >= 60 ? { ...r, graded: s.graded, won: s.won, hit } : null;
  }).filter((r): r is NonNullable<typeof r> => r !== null);

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

      {provable.length > 0 && (
        <div className="mt-5 border-t border-white/10 pt-4">
          <p className="font-mono text-[10.5px] font-bold uppercase tracking-[0.18em] text-onpitch-mute">
            Or start from a recipe that&apos;s landing right now
          </p>
          <div className="mt-3 flex flex-col gap-2">
            {provable.map((r) => (
              <Link
                key={r.key}
                href={recipeHref(r)}
                className="group flex items-center gap-3 rounded-xl border border-white/10 bg-pitch px-3.5 py-3 transition-colors hover:border-flood/40"
              >
                <span className="text-lg">{r.emoji}</span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[14px] font-bold text-chalk">{r.name}</span>
                  <span className="block truncate text-[12px] text-onpitch-mute">{r.what}</span>
                </span>
                <span className="flex-none text-right">
                  <span className="block font-mono text-[13px] font-bold text-grass">{r.hit}%</span>
                  <span className="block font-mono text-[10px] text-onpitch-mute">{r.won}/{r.graded} · 14d</span>
                </span>
                <span className="flex-none text-onpitch-mute transition-transform group-hover:translate-x-0.5">→</span>
              </Link>
            ))}
          </div>
          <p className="mt-2.5 font-mono text-[10px] uppercase tracking-wide text-onpitch-mute">
            Live platform record, graded in the open — not a guarantee. You pick the leagues.
          </p>
        </div>
      )}
    </div>
  );
}
