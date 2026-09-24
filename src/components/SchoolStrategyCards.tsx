// Owner-only forward-test lab on the School page: the two candidate School lines (Over 2.5 double +
// DC 1X treble) as SEPARATE profit cards, tracking Sep 7 → year-end to see which earns more. Data
// from the school_strategy_records() RPC (admin-gated; returns {strategies:[]} for everyone else).
// Odds are model fair-odds estimates until real book prices bank in.

type Day = { day: string; result: "won" | "lost"; odds: number };
type Strat = { key: string; name: string; legs: number; won: number; lost: number; profit: number; days: Day[] };
type Data = { since?: string; strategies?: Strat[] } | null;

const naira = (n: number) => (n < 0 ? "−₦" : "₦") + Math.round(Math.abs(n)).toLocaleString("en-US");

export default function SchoolStrategyCards({ data, stake = 10000 }: { data: Data; stake?: number }) {
  const strategies = data?.strategies ?? [];
  if (!strategies.length) return null;
  const leader = strategies.reduce((a, b) => (b.profit > a.profit ? b : a), strategies[0]);

  return (
    <div className="mx-auto mt-6 max-w-[960px] px-5 md:px-8">
      <p className="font-mono text-[10.5px] uppercase tracking-[0.14em] text-onpitch-mute">
        Owner lab · forward test since {data?.since ?? "Sep 7"} · which line pays more
      </p>
      <div className="mt-2 grid gap-4 sm:grid-cols-2">
        {strategies.map((s) => {
          const settled = s.won + s.lost;
          const roi = settled ? Math.round((s.profit / settled) * 100) : 0;
          const money = s.profit * stake;
          const isLeader = s.key === leader.key && strategies.length > 1;
          return (
            <div
              key={s.key}
              className={`rounded-2xl border p-5 ${isLeader ? "border-grass/40 bg-grass/[0.06]" : "border-white/10 bg-pitch-2"}`}
            >
              <div className="flex items-center justify-between gap-2">
                <p className="font-disp text-base font-bold text-chalk">{s.name}</p>
                <span className="flex-none font-mono text-[10.5px] text-onpitch-mute">{s.legs}-leg</span>
              </div>
              <p className={`mt-2 font-disp text-3xl font-extrabold tabular-nums ${money >= 0 ? "text-grass" : "text-brick"}`}>
                {naira(money)}
              </p>
              <p className="mt-0.5 text-[11px] text-onpitch-mute">
                at {naira(stake)}/day · <b className="text-chalk">{s.won}–{s.lost}</b> · {roi >= 0 ? "+" : "−"}{Math.abs(roi)}% ROI
              </p>
              <div className="mt-3 flex flex-wrap gap-1" aria-label="daily results">
                {s.days.map((d, i) => (
                  <span
                    key={i}
                    title={`${d.day} · @${d.odds} · ${d.result}`}
                    className={`h-2.5 w-2.5 rounded-full ${d.result === "won" ? "bg-grass" : "bg-brick"}`}
                  />
                ))}
              </div>
            </div>
          );
        })}
      </div>
      <p className="mt-2 font-mono text-[10px] text-onpitch-mute">
        ~ odds are model estimates until real prices bank in · flat stakes · tracking to year-end
      </p>
    </div>
  );
}
