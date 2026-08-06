// Onside forecasting core — the model foundation the user's rules layer ON TOP of.
//
// Dependency-free and framework-free ON PURPOSE: this ports verbatim into the `run-strategies` Deno
// edge function once validated. Nothing here does I/O — you feed it finished matches, it returns
// ratings; you feed it two teams, it returns calibrated probabilities for every core market.
//
// Pipeline:
//   buildRatings(history)  -> league-relative attack/defence per team (venue + overall) + Elo + league means
//   teamLambdas(ratings, home, away, league) -> expected goals λH, λA (Elo-prior shrinkage for thin data)
//   scoreMatrix(λH, λA)    -> Dixon–Coles bivariate score grid (rho low-score correction + temperature)
//   marketProbs(matrix)    -> 1X2 / O-U(any line) / BTTS / team-to-score / correct-score / supremacy
//
// v2 (2026-08-06) — three structural fixes over v1, each validated in perf/backtest.mts:
//   1. CROSS-LEAGUE NORMALISATION: goals are normalised by the league each match was PLAYED IN
//      (two-pass build), not by the league of the fixture being predicted. v1 divided an Estonian
//      side's domestic goals by the UEFA-competition mean, inflating minnows' attack ratings in
//      exactly the cup/qualifier fixtures the agents like — the source of implausible 30%+ "edges".
//   2. VENUE BLEND: each team's rating blends its venue-specific record with its overall record
//      (venueWeight), roughly doubling the effective sample behind every rating.
//   3. TEMPERATURE CALIBRATION: the score matrix is flattened by a fitted temperature, fixing the
//      tail overconfidence (v1: predicted 74% → actual 67%) coherently for EVERY derived market.

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
  venueWeight: number; // weight of the venue-specific record vs the overall record (1 = venue only)
  leagueShrink: number; // pseudo-matches pulling a small league's goal means toward the global mean
  temp: number; // score-matrix temperature; >1 flattens the grid (fixes tail overconfidence)
  minMatches: number; // below this (overall weighted matches) a team is "not confident"
  defHome: number; // fallback league home goal mean
  defAway: number; // fallback league away goal mean
  maxGoals: number; // score-matrix truncation
};

// Fitted on 172k finished fixtures (2025-06 → 2026-08) by coordinate search minimising held-out 1X2
// log-loss (perf/backtest.mts, 2026-08-06). vs the deployed v1 on 34.4k held-out matches: 1X2
// log-loss −0.9%, Brier −0.9%, O/U2.5 −0.6%, BTTS −0.5%; tail calibration gap halved (70-80% bin:
// pred 74.2 vs actual 70.6, was 67.1). Notable: venueWeight fitted to 0 (the overall record, with
// venue captured by the league home/away means, beats the venue-split record) and temp fitted to 1
// (the cross-league normalisation itself removed most of the tail overconfidence).
// Re-run the backtest to re-fit as the dataset grows.
export const DEFAULTS: ForecastConfig = {
  halfLifeDays: 90,
  homeAdvElo: 40,
  eloK: 10,
  shrink: 12,
  rho: 0,
  eloPerLogGoal: 300,
  venueWeight: 0,
  leagueShrink: 30,
  temp: 1,
  minMatches: 4,
  defHome: 1.45,
  defAway: 1.15,
  maxGoals: 10,
};

const ELO_BASE = 1500;

type Rate = { gf: number; ga: number; n: number }; // time-decay-weighted LEAGUE-RELATIVE ratio sums
export type Ratings = {
  elo: Map<number, number>;
  home: Map<number, Rate>; // a team's record WHEN AT HOME (ratios vs the match's own league means)
  away: Map<number, Rate>; // ...WHEN AWAY
  overall: Map<number, Rate>; // both venues pooled (the venue split is blended back in via venueWeight)
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

// League goal mean with shrinkage toward the global mean — a small league's mean is noisy, so it
// leans on the global scoring rate until it has leagueShrink weighted matches of its own.
function shrunkMean(e: { goals: number; n: number } | undefined, gMean: number, KL: number): number {
  const n = e?.n ?? 0;
  if (n + KL <= 0) return Math.max(0.1, gMean);
  return Math.max(0.1, ((e?.goals ?? 0) + gMean * KL) / (n + KL));
}

// ---------- build ratings from finished matches (two passes) ----------
export function buildRatings(history: Match[], config: Partial<ForecastConfig> = {}): Ratings {
  const cfg = { ...DEFAULTS, ...config };
  const matches = [...history].sort((a, b) => a.kickoff - b.kickoff); // chronological for Elo
  const now = matches.length ? matches[matches.length - 1].kickoff : Date.now();
  const decay = Math.LN2 / (cfg.halfLifeDays * 86400_000);

  // PASS 1 — time-decayed league means, so pass 2 can normalise every match by the league it was
  // PLAYED in (a goal in a 3.2-goal league counts for less than a goal in a 2.1-goal league).
  const leagueHome = new Map<number, { goals: number; n: number }>();
  const leagueAway = new Map<number, { goals: number; n: number }>();
  const gHome = { goals: 0, n: 0 };
  const gAway = { goals: 0, n: 0 };
  const weights: number[] = new Array(matches.length);
  for (let i = 0; i < matches.length; i++) {
    const mt = matches[i];
    if (!Number.isFinite(mt.hg) || !Number.isFinite(mt.ag)) { weights[i] = 0; continue; }
    const w = Math.exp(-decay * (now - mt.kickoff));
    weights[i] = w;
    const lg = mt.leagueId ?? -1;
    const lh = leagueHome.get(lg) ?? { goals: 0, n: 0 }; lh.goals += mt.hg * w; lh.n += w; leagueHome.set(lg, lh);
    const la = leagueAway.get(lg) ?? { goals: 0, n: 0 }; la.goals += mt.ag * w; la.n += w; leagueAway.set(lg, la);
    gHome.goals += mt.hg * w; gHome.n += w;
    gAway.goals += mt.ag * w; gAway.n += w;
  }
  const ghMean = gHome.n > 0 ? gHome.goals / gHome.n : cfg.defHome;
  const gaMean = gAway.n > 0 ? gAway.goals / gAway.n : cfg.defAway;

  // PASS 2 — Elo (chronological) + league-relative attack/defence ratios (venue-split AND overall)
  const elo = new Map<number, number>();
  const getElo = (id: number) => elo.get(id) ?? ELO_BASE;
  const home = new Map<number, Rate>();
  const away = new Map<number, Rate>();
  const overall = new Map<number, Rate>();
  const bump = (m: Map<number, Rate>, id: number, gf: number, ga: number, w: number) => {
    const r = m.get(id) ?? { gf: 0, ga: 0, n: 0 };
    r.gf += gf * w; r.ga += ga * w; r.n += w; m.set(id, r);
  };
  for (let i = 0; i < matches.length; i++) {
    const mt = matches[i];
    const w = weights[i];
    if (!w) continue;
    // Elo update (uses ratings BEFORE this match)
    const rH = getElo(mt.homeId), rA = getElo(mt.awayId);
    const exp = eloExpected(rH, rA, cfg.homeAdvElo);
    const s = mt.hg > mt.ag ? 1 : mt.hg === mt.ag ? 0.5 : 0;
    const dr = (rH + cfg.homeAdvElo) - rA;
    const mult = marginMultiplier(mt.hg - mt.ag, dr);
    const delta = cfg.eloK * mult * (s - exp);
    elo.set(mt.homeId, rH + delta);
    elo.set(mt.awayId, rA - delta);

    // league-relative goals for THIS match's league — the cross-league fix
    const lg = mt.leagueId ?? -1;
    const mh = shrunkMean(leagueHome.get(lg), ghMean, cfg.leagueShrink);
    const ma = shrunkMean(leagueAway.get(lg), gaMean, cfg.leagueShrink);
    const nh = mt.hg / mh, na = mt.ag / ma;
    bump(home, mt.homeId, nh, na, w);
    bump(away, mt.awayId, na, nh, w);
    bump(overall, mt.homeId, nh, na, w);
    bump(overall, mt.awayId, na, nh, w);
  }

  return { elo, home, away, overall, leagueHome, leagueAway, gHome, gAway, cfg };
}

// ---------- expected goals for a fixture ----------
export type Lambdas = { lamH: number; lamA: number; confident: boolean; eloH: number; eloA: number };
export function teamLambdas(r: Ratings, homeId: number, awayId: number, leagueId?: number): Lambdas {
  const cfg = r.cfg;
  const lg = leagueId ?? -1;
  const ghMean = r.gHome.n > 0 ? r.gHome.goals / r.gHome.n : cfg.defHome;
  const gaMean = r.gAway.n > 0 ? r.gAway.goals / r.gAway.n : cfg.defAway;
  const leagueHome = shrunkMean(r.leagueHome.get(lg), ghMean, cfg.leagueShrink);
  const leagueAway = shrunkMean(r.leagueAway.get(lg), gaMean, cfg.leagueShrink);

  const eloH = r.elo.get(homeId) ?? ELO_BASE;
  const eloA = r.elo.get(awayId) ?? ELO_BASE;
  // Elo → strength multiplier prior (relative to an average team). Used as the SHRINKAGE TARGET so a
  // team with few games leans on Elo instead of a neutral 1.0 (fixes promoted sides / cups / friendlies).
  const attPrior = (elo: number) => Math.exp((elo - ELO_BASE) / cfg.eloPerLogGoal);
  const defPrior = (elo: number) => Math.exp(-(elo - ELO_BASE) / cfg.eloPerLogGoal);

  // Blend the venue-specific record with the overall record: each is shrunk toward the Elo prior
  // with ITS OWN sample size, then mixed by venueWeight. Ratios are league-relative (see build).
  const K = cfg.shrink;
  const vw = cfg.venueWeight;
  const shrink = (raw: number, n: number, prior: number) => (raw * n + prior * K) / (n + K);
  const blend = (venue: Rate | undefined, all: Rate | undefined, pick: (x: Rate) => number, prior: number) => {
    const vn = venue?.n ?? 0, an = all?.n ?? 0;
    const v = shrink(vn > 0 ? pick(venue!) / vn : prior, vn, prior);
    const o = shrink(an > 0 ? pick(all!) / an : prior, an, prior);
    return vw * v + (1 - vw) * o;
  };
  const H = r.home.get(homeId), A = r.away.get(awayId);
  const OH = r.overall.get(homeId), OA = r.overall.get(awayId);
  const homeAtt = blend(H, OH, (x) => x.gf, attPrior(eloH));
  const homeDef = blend(H, OH, (x) => x.ga, defPrior(eloH));
  const awayAtt = blend(A, OA, (x) => x.gf, attPrior(eloA));
  const awayDef = blend(A, OA, (x) => x.ga, defPrior(eloA));

  const clamp = (x: number) => Math.max(0.15, Math.min(6, x));
  const confident = ((OH?.n ?? 0) >= cfg.minMatches) && ((OA?.n ?? 0) >= cfg.minMatches);
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
  const invT = 1 / (cfg.temp || 1);
  const p: number[][] = [];
  let total = 0;
  for (let x = 0; x <= N; x++) {
    p[x] = [];
    for (let y = 0; y <= N; y++) {
      let v = Math.max(0, pois(x, lamH) * pois(y, lamA) * tau(x, y, lamH, lamA, cfg.rho));
      // temperature calibration: flatten the grid so extreme outcomes stop being over-trusted;
      // every market derived from the matrix inherits the same correction coherently
      if (invT !== 1 && v > 0) v = Math.pow(v, invT);
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
