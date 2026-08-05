# Onside

Track only the bet you made. A **Thinka Platforms LTD** product (RC 9336976).

Next.js (App Router) PWA + Supabase (auth, Postgres, storage, realtime, edge functions).

## Run locally

```bash
npm install
npm run dev          # http://localhost:3000
```

`.env.local` is already populated for local dev (git-ignored). Before running, add your
Supabase **service role** key (Dashboard → Project Settings → API) to `SUPABASE_SERVICE_ROLE_KEY`.

## Auth

- **Email/password** works out of the box.
- **Google** sign-in: create an OAuth client in Google Cloud Console, then paste the client
  id/secret into Supabase → Authentication → Providers → Google, and add
  `http://localhost:3000/auth/callback` (and the production URL) as a redirect. The button is
  already wired — no code change needed.

## Structure

```
src/
  app/
    page.tsx            landing
    login/page.tsx      email + Google auth
    (app)/
      layout.tsx        signed-in shell (sidebar) + auth guard
      tracker/page.tsx  live tracker (reads your tickets)
  lib/supabase/         browser + server + middleware clients
middleware.ts           refreshes the auth session on every request
```

## Notes
- Design system tokens live in `src/app/globals.css` (petrol / chalk / floodlight-amber).
- Never commit `.env.local`. Rotate the Paystack test keys before going live.
- Prefer country flags + text over official league/club badges (trademark).
