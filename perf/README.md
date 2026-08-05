# Onside page-speed harness

Runs **Lighthouse** (mobile + desktop) and a **Playwright Web-Vitals interaction pass** across every
route, checks each result against budgets, prints a table, and writes raw JSON to `perf/results/`.
Exits non-zero if any route is over budget, so it doubles as a CI regression gate.

It logs in once (Playwright over CDP) and shares that session with Lighthouse, so the authenticated
`(app)` routes are measured signed-in. Authed routes run cold-cache-but-logged-in (HTTP cache cleared
via CDP, cookies kept); public routes run fully cold.

## Setup

```bash
cd perf
npm install
npx playwright install chromium   # first time only
```

## Run

```bash
# required
export PERF_URL="https://<your-vercel-domain>"      # no trailing slash
export PERF_EMAIL="test@onside.test"                # a THROWAWAY test account, never a real user
export PERF_PASSWORD="••••••"
# optional
export PERF_RUNS=3                                  # runs per route/form-factor, median reported (default 3)
export PERF_HEADLESS=false                          # watch it drive (default headless)
export PERF_ONLY="/tracker,/add"                    # limit to specific routes

npm run perf
```

On Windows PowerShell use `$env:PERF_URL="..."` etc.

## What it measures

Per route × {mobile, desktop}, median of N runs:

- **Lighthouse:** Performance score, TTFB, FCP, LCP, Speed Index, TBT, CLS, total transfer, JS transfer.
- **Playwright Web Vitals (mobile):** field-style LCP/CLS + **INP** after a safe scripted interaction
  (scroll + one non-destructive tap per route — never places bets, deploys agents, or posts).

## Budgets (edit in `perf.mjs`)

Mobile: LCP < 2500ms · INP < 200ms · CLS < 0.1 · TTFB < 800ms · TBT < 200ms · SI < 3400ms ·
JS < 300KB · total < 1200KB · score ≥ 85.  Desktop tightens LCP < 1500ms, TBT < 150ms, SI < 1500ms.

## CI (GitHub Action)

`.github/workflows/perf.yml` runs this harness against production and **fails the check if any route
is over budget** — a regression gate. It triggers on every successful **Production** deploy (Vercel
sends a `deployment_status` event), nightly at 06:00 UTC, and on manual dispatch. Results are uploaded
as a `pagespeed-results` artifact.

Set these repo secrets (**Settings → Secrets and variables → Actions**):

| Secret | Required | Value |
| --- | --- | --- |
| `PERF_URL` | yes | production URL, e.g. `https://onside-mauve.vercel.app` |
| `PERF_EMAIL` | for authed routes | a **dedicated CI test account** email |
| `PERF_PASSWORD` | for authed routes | that account's password |

Without `PERF_EMAIL`/`PERF_PASSWORD` it still runs, but only measures the public routes (the harness
skips authed routes when no creds are present). Create the CI account the same way any user signs up
(or ask the maintainer to provision a throwaway one) — never use a real user.

To tune the gate, edit the `BUDGET` / `BUDGET_DESKTOP` objects in `perf.mjs`.

## Notes / gotchas

- Uses a **throwaway test account** — the interactions are read-only, but never point it at a real user.
- The service worker caches nothing, so "warm" ≈ "cold" here by design; results reflect real network + RSC.
- Numbers vary run-to-run — raise `PERF_RUNS` (e.g. 5) for tighter medians before drawing conclusions.
- Measure the **production** URL for realistic figures; `next dev` is much slower and not representative.
  For a local prod build: `npm run build && npm start` then point `PERF_URL` at `http://localhost:3000`.
- If login fails, check the selectors in `login()` against your actual `/login` form.
