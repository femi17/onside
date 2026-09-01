// Client-side throttle for auth emails (confirmation resend, password reset). Supabase's own
// per-address limit only blocks sends inside ~60s; a user refreshing the page and re-submitting
// over a few minutes collects 4-5 real emails. This persists a per-email stamp in localStorage
// so repeat requests inside the cooldown never reach the API — the UI shows "already sent"
// instead. Defence in depth with the dashboard Auth rate limits, not a replacement.

const key = (kind: string, email: string) => `auth-email:${kind}:${email.trim().toLowerCase()}`;

// seconds left before another email may be requested for this address; 0 = allowed
export function authEmailWait(kind: "reset" | "confirm", email: string, cooldownSec: number): number {
  try {
    const at = Number(localStorage.getItem(key(kind, email)) ?? 0);
    return Math.max(0, Math.ceil((at + cooldownSec * 1000 - Date.now()) / 1000));
  } catch {
    return 0; // private mode etc. — fall back to Supabase's own limit
  }
}

export function stampAuthEmail(kind: "reset" | "confirm", email: string): void {
  try {
    localStorage.setItem(key(kind, email), String(Date.now()));
  } catch { /* best-effort */ }
}

export const fmtWait = (s: number) => (s >= 60 ? `${Math.ceil(s / 60)} min` : `${s}s`);
