"use client";

// Branded last-resort screen for any uncaught client-side crash — replaces Next's raw
// "Application error: a client-side exception has occurred" text with a way back in.
export default function GlobalError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="en">
      <body style={{ margin: 0, background: "#0e1a1b", color: "#f4f1e8", fontFamily: "system-ui, sans-serif" }}>
        <main style={{ minHeight: "100vh", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 14, padding: 24, textAlign: "center" }}>
          <div style={{ fontSize: 40 }}>⚽</div>
          <h1 style={{ fontSize: 22, fontWeight: 800, margin: 0 }}>Something went wrong on this screen.</h1>
          <p style={{ margin: 0, color: "#9fb0a6", fontSize: 14, maxWidth: 340, lineHeight: 1.6 }}>
            Your bets and slips are safe — this is just the page tripping. One tap usually fixes it.
          </p>
          <button
            onClick={() => { try { reset(); } catch { /* fall through to reload */ } window.location.reload(); }}
            style={{ marginTop: 8, background: "#ffb43c", color: "#14261e", border: 0, borderRadius: 12, padding: "12px 26px", fontSize: 15, fontWeight: 700, cursor: "pointer" }}
          >
            Reload Onside
          </button>
        </main>
      </body>
    </html>
  );
}
