// Onside forecasting core — the model foundation the user's rules layer ON TOP of.
//
// Dependency-free and framework-free ON PURPOSE: this ports verbatim into the `run-strategies` Deno
// edge function once validated. Nothing here does I/O — you feed it finished matches, it returns
// ratings; you feed it two teams, it returns calibrated-ish probabilities for every core market.
//
// Pipeline:
//   buildRatings(history)  -> time-decayed attack/defence per team (home/away split) + Elo + league means
//   teamLambdas(ratings, home, away, league) -> expected goals λH, λA (Elo-prior shrinkage for thin data)
//   scoreMatrix(λH, λA)    -> Dixon–Coles bivariate score grid (low-score correction via rho)
//   marketProbs(matrix)    -> 1X2 / O-U(any line) / BTTS / team-to-score / correct-score / supremacy
//
// This is a FAST approximation of Dixon–Coles: closed-form time-decayed rates (not a per-run MLE, which
// is too heavy for an edge function) + the DC tau low-score correction + an Elo prior that rescues
// thin-data teams (promoted sides, cups, friendlies) where raw goal rates are unreliable.

export type Match = {
  homeId: number;
  awayId: number;
  hg: number; // home goals (full time)
  ag: number; // away goals
  kickoff: number; // epoch ms
  leagueId?: number;
};

export type ForecastConfig = {
  halfLifeDays: number; // recency: weight halves every N days
  homeAdvElo: number; // Elo points added to the home side
  eloK: number; // Elo update step
  shrink: number; // pseudo-matches pulling a team's rate toward its (Elo) prior
  rho: number; // Dixon–Coles low-score correction (small negative)
  eloPerLogGoal: number; // Elo points ≈ one e-fold of goal strength (maps Elo → attack/defence prior)
  minMatches: number; // below this a team is "not confident"
  defHome: number; // fallback league home goal mean
  defAway: number; // fallback league away goal mean
  maxGoals: number; // score-matrix truncation
};

// Fitted on 171k finished fixtures (2025-06 → 2026-08) by coordinate search minimising held-out 1X2
// log-loss (perf/backtest.mts). Beat the old independent-Poisson model by ~1.5% log-loss / 1.6% Brier
// on 34k held-out matches, well-calibrated. Re-run the backtest to re-fit as the dataset grows.
// (rho=0: the DC low-score correction didn't help 1X2 here — revisit it against BTTS/O-U specifically.)
export const DEFAULTS: ForecastConfig = {
  halfLifeDays: 90,
  homeAdvElo: 40,
  eloK: 10,
  shrink: 8,
  rho: 0,
  eloPerLogGoal: 300,
  minMatches: 4,
  defHome: 1.45,
  defAway: 1.15,
  maxGoals: 10,
};

const ELO_BASE = 1500;

type Rate = { gf: number; ga: number; n: number }; // time-decay-weighted sums
export type Ratings = {
  elo: Map<number, number>;
  home: Map<number, Rate>; // a team's record WHEN AT HOME
  away: Map<number, Rate>; // ...WHEN AWAY
  leagueHome: Map<number, { goals: number; n: number }>;
  leagueAway: Map<number, { goals: number; n: number }>;
  gHome: { goals: number; n: number }; // global fallback
  gAway: { goals: number; n: number };
  cfg: ForecastConfig;
};

// ---------- Elo (margin-adjusted, home-field) — FiveThirtyEight-style update ----------
function eloExpected(rHome: number, rAway: number, homeAdv: number): number {
  return 1 / (1 + Math.pow(10, -((rHome + homeAdv) - rAway) / 400));
}
function marginMultiplier(goalDiff: number, dr: number): number {
  const g = Math.abs(goalDiff);
  if (g <= 1) return 1;
  // dampen runaway ratings for lopsided favourites (autocorrelation adjustment)
  return Math.log(g + 1) * (2.2 / (Math.abs(dr) * 0.001 + 2.2));
}

// ---------- build ratings from finished matches ----------
export function buildRatings(history: Match[], config: Partial<ForecastConfig> = {}): Ratings {
  const cfg = { ...DEFAULTS, ...config };
  const matches = [...history].sort((a, b) => a.kickoff - b.kickoff); // chronological for Elo
  const now = matches.length ? matches[matches.length - 1].kickoff : Date.now();
  const decay = Math.LN2 / (cfg.halfLifeDays * 86400_000);

  const elo = new Map<number, number>();
  const getElo = (id: number) => elo.get(id) ?? ELO_BASE;

  const home = new Map<number, Rate>();
  const away = new Map<number, Rate>();
  const leagueHome = new Map<number, { goals: number; n: number }>();
  const leagueAway = new Map<number, { goals: number; n: number }>();
  const gHome = { goals: 0, n: 0 };
  const gAway = { goals: 0, n: 0 };
  const bump = (m: Map<number, Rate>, id: number, gf: number, ga: number, w: number) => {
    const r = m.get(id) ?? { gf: 0, ga: 0, n: 0 };
    r.gf += gf * w; r.ga += ga * w; r.n += w; m.set(id, r);
  };

  for (const mt of matches) {
    if (!Number.isFinite(mt.hg) || !Number.isFinite(mt.ag)) continue;
    // Elo update (uses ratings BEFORE this match)
    const rH = getElo(mt.homeId), rA = getElo(mt.awayId);
    const exp = eloExpected(rH, rA, cfg.homeAdvElo);
    const s = mt.hg > mt.ag ? 1 : mt.hg === mt.ag ? 0.5 : 0;
    const dr = (rH + cfg.homeAdvElo) - rA;
    const mult = marginMultiplier(mt.hg - mt.ag, dr);
    const delta = cfg.eloK * mult * (s - exp);
    elo.set(mt.homeId, rH + delta);
    elo.set(mt.awayId, rA - delta);

    // time-decayed goal rates (recent matches weigh more)
    const w = Math.exp(-decay * (now - mt.kickoff));
    bump(home, mt.homeId, mt.hg, mt.ag, w);
    bump(away, mt.awayId, mt.ag, mt.hg, w);
    const lg = mt.leagueId ?? -1;
    const lh = leagueHome.get(lg) ?? { goals: 0, n: 0 }; lh.goals += mt.hg * w; lh.n += w; leagueHome.set(lg, lh);
    const la = leagueAway.get(lg) ?? { goals: 0, n: 0 }; la.goals += mt.ag * w; la.n += w; leagueAway.set(lg, la);
    gHome.goals += mt.hg * w; gHome.n += w;
    gAway.goals += mt.ag * w; gAway.n += w;
  }

  return { elo, home, away, leagueHome, leagueAway, gHome, gAway, cfg };
}

// ---------- expected goals for a fixture ----------
export type Lambdas = { lamH: number; lamA: number; confident: boolean; eloH: number; eloA: number };
export function teamLambdas(r: Ratings, homeId: number, awayId: number, leagueId?: number): Lambdas {
  const cfg = r.cfg;
  const lg = leagueId ?? -1;
  const lh = r.leagueHome.get(lg);
  const la = r.leagueAway.get(lg);
  // floor the league means so a tiny/zero-goal league can never cause a 0-division → NaN λ
  const leagueHome = Math.max(0.1, lh && lh.n > 0 ? lh.goals / lh.n : (r.gHome.n > 0 ? r.gHome.goals / r.gHome.n : cfg.defHome));
  const leagueAway = Math.max(0.1, la && la.n > 0 ? la.goals / la.n : (r.gAway.n > 0 ? r.gAway.goals / r.gAway.n : cfg.defAway));

  const eloH = r.elo.get(homeId) ?? ELO_BASE;
  const eloA = r.elo.get(awayId) ?? ELO_BASE;
  // Elo → strength multiplier prior (relative to an average team). Used as the SHRINKAGE TARGET so a
  // team with few games leans on Elo instead of a neutral 1.0 (fixes promoted sides / cups / friendlies).
  const eloAttPrior = (id: number) => Math.exp((( r.elo.get(id) ?? ELO_BASE) - ELO_BASE) / cfg.eloPerLogGoal);
  const eloDefPrior = (id: number) => Math.exp((-((r.elo.get(id) ?? ELO_BASE) - ELO_BASE)) / cfg.eloPerLogGoal);

  const H = r.home.get(homeId), A = r.away.get(awayId);
  const Hn = H?.n ?? 0, An = A?.n ?? 0;
  const rawHomeAtt = Hn > 0 ? (H!.gf / Hn) / leagueHome : 1;
  const rawHomeDef = Hn > 0 ? (H!.ga / Hn) / leagueAway : 1;
  const rawAwayAtt = An > 0 ? (A!.gf / An) / leagueAway : 1;
  const rawAwayDef = An > 0 ? (A!.ga / An) / leagueHome : 1;

  const K = cfg.shrink;
  const shrink = (raw: number, n: number, prior: number) => (raw * n + prior * K) / (n + K);
  const homeAtt = shrink(rawHomeAtt, Hn, eloAttPrior(homeId));
  const homeDef = shrink(rawHomeDef, Hn, eloDefPrior(homeId));
  const awayAtt = shrink(rawAwayAtt, An, eloAttPrior(awayId));
  const awayDef = shrink(rawAwayDef, An, eloDefPrior(awayId));

  const clamp = (x: number) => Math.max(0.15, Math.min(6, x));
  const totalMatches = (r.home.get(homeId)?.n ?? 0) + (r.away.get(homeId)?.n ?? 0);
  const totalMatchesA = (r.home.get(awayId)?.n ?? 0) + (r.away.get(awayId)?.n ?? 0);
  const confident = (lh?.n ?? r.gHome.n) > 0 && totalMatches >= cfg.minMatches && totalMatchesA >= cfg.minMatches;
  return {
    lamH: clamp(leagueHome * homeAtt * awayDef),
    lamA: clamp(leagueAway * awayAtt * homeDef),
    confident, eloH, eloA,
  };
}

// ---------- Dixon–Coles score matrix ----------
const FACT = [1, 1, 2, 6, 24, 120, 720, 5040, 40320, 362880, 3628800, 39916800];
const pois = (k: number, l: number) => (Math.exp(-l) * Math.pow(l, k)) / (FACT[k] ?? Infinity);
// tau applies the DC dependence correction to the four low-score cells
function tau(x: number, y: number, l: number, m: number, rho: number): number {
  if (x === 0 && y === 0) return 1 - l * m * rho;
  if (x === 0 && y === 1) return 1 + l * rho;
  if (x === 1 && y === 0) return 1 + m * rho;
  if (x === 1 && y === 1) return 1 - rho;
  return 1;
}
export type Matrix = { p: number[][]; n: number };
export function scoreMatrix(lamH: number, lamA: number, cfg: ForecastConfig = DEFAULTS): Matrix {
  const N = cfg.maxGoals;
  const p: number[][] = [];
  let total = 0;
  for (let x = 0; x <= N; x++) {
    p[x] = [];
    for (let y = 0; y <= N; y++) {
      const v = Math.max(0, pois(x, lamH) * pois(y, lamA) * tau(x, y, lamH, lamA, cfg.rho));
      p[x][y] = v; total += v;
    }
  }
  for (let x = 0; x <= N; x++) for (let y = 0; y <= N; y++) p[x][y] /= total; // renormalise
  return { p, n: N };
}

// ---------- markets ----------
export type MarketProbs = {
  homeWin: number; draw: number; awayWin: number;
  over: (line: number) => number; under: (line: number) => number;
  btts: number; homeToScore: number; awayToScore: number;
  supremacy: number; // expected home − away goals
  correctScore: (h: number, a: number) => number;
};
export function marketProbs(mx: Matrix): MarketProbs {
  const { p, n } = mx;
  let homeWin = 0, draw = 0, awayWin = 0, btts = 0, hScore = 0, aScore = 0, sup = 0;
  const totalDist: number[] = new Array(2 * n + 1).fill(0);
  for (let x = 0; x <= n; x++) for (let y = 0; y <= n; y++) {
    const v = p[x][y];
    if (x > y) homeWin += v; else if (x === y) draw += v; else awayWin += v;
    if (x > 0 && y > 0) btts += v;
    if (x > 0) hScore += v;
    if (y > 0) aScore += v;
    totalDist[x + y] += v;
    sup += v * (x - y);
  }
  const over = (line: number) => { let s = 0; for (let t = 0; t < totalDist.length; t++) if (t > line) s += totalDist[t]; return s; };
  return {
    homeWin, draw, awayWin,
    over, under: (line: number) => 1 - over(line),
    btts, homeToScore: hScore, awayToScore: aScore, supremacy: sup,
    correctScore: (h, a) => (h <= n && a <= n ? p[h][a] : 0),
  };
}

// one-shot convenience
export function forecast(r: Ratings, homeId: number, awayId: number, leagueId?: number) {
  const lam = teamLambdas(r, homeId, awayId, leagueId);
  const mx = scoreMatrix(lam.lamH, lam.lamA, r.cfg);
  return { ...lam, markets: marketProbs(mx) };
}
