# Thinka Platforms Ltd — corporate website

A **static, self-contained** website for Thinka Platforms Ltd, a technology holding company
developing and managing digital platforms, internet services, software products and related solutions
across multiple industries. It lives inside the Onside repo but is a **separate deployable** — no
build step, no dependencies, and it does not touch the Onside Next.js app (the root `tsconfig.json`
excludes this folder).

## Pages
- `index.html` — company home: who Thinka is, what it does, its solutions (Loota, Onside, more),
  and a Payments section explaining how we accept payments (Paystack) and what payments are for.
- `terms.html` — Terms of Service, incl. a Payments & Paystack clause (company-wide).
- `privacy.html` — Privacy Policy, incl. a Payment data & Paystack section (company-wide).
- `styles.css` — shared design system.
- `vercel.json` — `cleanUrls` so `/terms` and `/privacy` resolve without `.html`.

## Deploy as a separate Vercel project (same GitHub repo)
1. Vercel → **Add New… → Project** → import the **same** GitHub repo (`femi17/onside`).
2. **Root Directory** → set to `thinka`.
3. **Framework Preset** → **Other**. Leave Build Command and Output Directory empty (static files are
   served directly).
4. Deploy. Add a domain (e.g. `thinkaplatforms.com`) to *this* project — it's independent of the
   Onside project, which keeps building from the repo root.

Pushing to `main` redeploys both projects independently, with no interference.

## Fill in before going live
- **`[RC number]`** — the company RC number (in `index.html` and `terms.html`).
- **Emails** — currently `info@thinkaplatforms.com` / `payments@thinkaplatforms.com`; point these at
  real, monitored inboxes.
- **Domain** — assumes `thinkaplatforms.com`; update if different.
- **Example prices / items** — align the Payments section with real product pricing.

## Preview locally
From the repo root: `npx -y serve thinka -l 4321`, then open http://localhost:4321.
