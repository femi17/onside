# Roomy — product website (roomy.com.ng)

Static landing site for **Roomy**, the calm Windows cleaner (Nigeria-first, priced in naira).
Same pattern as `thinka/`: it lives inside the Onside repo but is a **separate Vercel
deployable** — no build step, no dependencies, excluded from the Onside Next.js app.

The app itself (Electron + its own Supabase) lives in the separate
`pc-cleaner-brainstorm` repo; this folder is only the website. The download buttons point at
GitHub releases (`femi17/roomy-releases`), so the installer is never checked in here.

## Pages
- `index.html` — landing: what Roomy does, safety promise, pricing (free first clean,
  ₦1,000/month, ₦1,500 one-off), download CTA.
- `privacy.html` / `terms.html` — policies.
- `vercel.json` — `cleanUrls` so `/terms` and `/privacy` resolve without `.html`.

## Deploy (separate Vercel project, same GitHub repo)
1. Vercel → Add New → Project → import `femi17/onside`.
2. Root Directory → `roomy`. Framework Preset → Other, no build command.
3. Add the domain `roomy.com.ng` (and `www.roomy.com.ng`) to this project.

Pushing to `main` redeploys it independently of Onside and Thinka.
