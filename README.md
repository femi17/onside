# Onside

Track only the bet you made. A **Thinka Platforms LTD** product (RC 9336976).

Next.js (App Router) PWA + Supabase (auth, Postgres, storage, realtime, edge functions).

## Run locally

```bash
npm install
npm run dev          # http://localhost:3000
```

## Auth

- **Email/password** works out of the box.
- **Google** sign-in: create an OAuth client in Google Cloud Console, then paste the client
  id/secret into Supabase → Authentication → Providers → Google


## Notes
- Design system tokens live in `src/app/globals.css` (petrol / chalk / floodlight-amber).
- Prefer country flags + text over official league/club badges (trademark).
