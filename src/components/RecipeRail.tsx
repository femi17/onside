import Link from "next/link";

// Starter-recipe rail — the one-tap "first agent" links with LIVE receipts, shared by the
// tracker's activation card (dark) and the /strategies empty state (light chalk). Pure JSX,
// no client hooks, so it renders in both server and client trees. Each recipe deep-links the
// builder's existing prefill rail (name + market + a model-probability rule the read-back
// verifies); a recipe only renders when it clears its evidence bar (>=15 graded, >=60% hit
// over the last 14 days, from starter_recipes()), so a cold recipe never advertises itself.

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

export default function RecipeRail({ recipes, tone = "dark" }: { recipes?: RecipeStats | null; tone?: "dark" | "light" }) {
  const provable = RECIPES.map((r) => {
    const s = recipes?.[r.key];
    if (!s || s.graded < 15) return null;
    const hit = Math.round((s.won / s.graded) * 100);
    return hit >= 60 ? { ...r, graded: s.graded, won: s.won, hit } : null;
  }).filter((r): r is NonNullable<typeof r> => r !== null);
  if (provable.length === 0) return null;

  const dark = tone === "dark";
  const c = {
    heading: dark ? "text-onpitch-mute" : "text-ink-mute",
    row: dark
      ? "border-white/10 bg-pitch hover:border-flood/40"
      : "border-ink/10 bg-white hover:border-flood-deep/50",
    name: dark ? "text-chalk" : "text-ink",
    what: dark ? "text-onpitch-mute" : "text-ink-mute",
    hit: dark ? "text-grass" : "text-grass-deep",
    sub: dark ? "text-onpitch-mute" : "text-ink-mute",
    arrow: dark ? "text-onpitch-mute" : "text-ink-mute",
    foot: dark ? "text-onpitch-mute" : "text-ink-mute",
  };

  return (
    <div className="text-left">
      <p className={`font-mono text-[10.5px] font-bold uppercase tracking-[0.18em] ${c.heading}`}>
        Or start from a recipe that&apos;s landing right now
      </p>
      <div className="mt-3 flex flex-col gap-2">
        {provable.map((r) => (
          <Link
            key={r.key}
            href={recipeHref(r)}
            className={`group flex items-center gap-3 rounded-xl border px-3.5 py-3 transition-colors ${c.row}`}
          >
            <span className="text-lg">{r.emoji}</span>
            <span className="min-w-0 flex-1">
              <span className={`block text-[14px] font-bold ${c.name}`}>{r.name}</span>
              <span className={`block truncate text-[12px] ${c.what}`}>{r.what}</span>
            </span>
            <span className="flex-none text-right">
              <span className={`block font-mono text-[13px] font-bold ${c.hit}`}>{r.hit}%</span>
              <span className={`block font-mono text-[10px] ${c.sub}`}>{r.won}/{r.graded} · 14d</span>
            </span>
            <span className={`flex-none transition-transform group-hover:translate-x-0.5 ${c.arrow}`}>→</span>
          </Link>
        ))}
      </div>
      <p className={`mt-2.5 font-mono text-[10px] uppercase tracking-wide ${c.foot}`}>
        Live platform record, graded in the open — not a guarantee. You pick the leagues.
      </p>
    </div>
  );
}
