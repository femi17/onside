# Thinka Platforms Ltd — corporate + Loota compliance site

A **static, self-contained** marketing/compliance site for Thinka Platforms Ltd. It lives inside the
Onside repo but is a **separate deployable** — it has no build step, no dependencies, and does not
touch the Onside Next.js app (the root `tsconfig.json` excludes this folder).

## Pages
- `index.html` — company landing (what Thinka does + its products: Loota, Onside).
- `loota.html` — Loota explainer **and the Paystack answers** (what users pay for, how it works, the
  payment-flow mockup, account-scope statement). This is the page to send Paystack.
- `terms.html` — Terms of Service, incl. a Payments & Paystack clause.
- `privacy.html` — Privacy Policy, incl. a Payment data & Paystack section.
- `styles.css` — shared design system.
- `vercel.json` — `cleanUrls` so `/loota`, `/terms`, `/privacy` resolve without `.html`.

## Deploy as a separate Vercel project (same GitHub repo)
1. Vercel → **Add New… → Project** → import the **same** GitHub repo (`femi17/onside`).
2. **Root Directory** → set to `thinka`.
3. **Framework Preset** → **Other**. Leave Build Command empty; **Output Directory** empty (Vercel
   serves the folder's static files directly).
4. Deploy. Add a domain (e.g. `thinkaplatforms.com`) to *this* project — it's independent of the
   Onside project, which keeps building from the repo root.

Because it's static and isolated, pushing to `main` redeploys **both** projects independently with no
interference.

## Before sending to Paystack — replace these placeholders
- **`[RC number]`** — the company RC number (in `index.html` and `terms.html`).
- **Emails** — `hello@thinkaplatforms.com` / `payments@thinkaplatforms.com` (use real inboxes).
- **Domain** — currently assumes `thinkaplatforms.com`; update if different.
- **Account-scope line** in `loota.html` (Q4) — confirm the account is Loota-specific, or reword for
  multi-product use.
- **Example prices** in `loota.html` (₦50–₦2,000) — align with real Loota pricing.
