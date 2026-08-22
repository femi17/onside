import { ImageResponse } from "next/og";

// The share card WhatsApp/X unfurl for a shared agent — sibling of /s/[token]'s card.
// Anonymised data via the same public RPC as the page; a static brand card if anything fails.
export const runtime = "edge";
export const alt = "An AI betting agent's live feed on Onside";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

type PublicAgent = {
  name: string; market: string | null;
  record: { won: number; lost: number };
  picks: { result: string; fx_status: string | null }[];
};

const LIVE = new Set(["1H", "HT", "2H", "ET", "BT", "P", "LIVE", "SUSP", "INT"]);

export default async function Image({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  let a: PublicAgent | null = null;
  try {
    const res = await fetch(`${process.env.NEXT_PUBLIC_SUPABASE_URL}/rest/v1/rpc/public_agent`, {
      method: "POST",
      headers: {
        apikey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
        Authorization: `Bearer ${process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ p_token: token }),
    });
    if (res.ok) a = (await res.json()) as PublicAgent | null;
  } catch { /* fall through to the brand card */ }

  const settled = a ? a.record.won + a.record.lost : 0;
  const winPct = settled ? Math.round(((a as PublicAgent).record.won / settled) * 100) : null;
  const liveNow = a ? a.picks.filter((p) => p.result === "pending" && LIVE.has(p.fx_status ?? "")).length : 0;
  const stateTxt = liveNow ? `● ${liveNow} IN PLAY` : "AI AGENT";
  const stateColor = liveNow ? "#ffb43c" : "#9fb0a6";

  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", justifyContent: "space-between", background: "#0e1a1b", padding: 64, fontFamily: "sans-serif" }}>
        {/* brand row */}
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          <div style={{ width: 44, height: 44, borderRadius: 12, background: "#ffb43c", display: "flex" }} />
          <div style={{ display: "flex", fontSize: 40, fontWeight: 800, color: "#f4f1e8" }}>
            ON<span style={{ color: "#ffb43c" }}>SIDE</span>
          </div>
          <div style={{ display: "flex", marginLeft: "auto", color: stateColor, fontSize: 30, fontWeight: 800, letterSpacing: 2 }}>{stateTxt}</div>
        </div>

        {/* headline */}
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <div style={{ display: "flex", fontSize: 44, color: "#9fb0a6", fontWeight: 700 }}>
            {a ? "An AI agent picking by its owner's rules" : "AI agents that hunt fixtures for you"}
          </div>
          <div style={{ display: "flex", fontSize: 84, fontWeight: 800, color: "#f4f1e8" }}>
            {a ? a.name : "Your rules. Daily picks."}
          </div>
          {a && settled > 0 ? (
            <div style={{ display: "flex", gap: 28, fontSize: 30, fontWeight: 700 }}>
              <span style={{ color: "#57a773" }}>✓ {a.record.won} landed</span>
              <span style={{ color: "#c0563f" }}>✕ {a.record.lost} cut</span>
              {winPct != null ? <span style={{ color: "#9fb0a6" }}>{winPct}% landed</span> : null}
            </div>
          ) : null}
        </div>

        {/* footer */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", borderTop: "2px dashed #2a3b36", paddingTop: 28 }}>
          <div style={{ display: "flex", fontSize: 28, color: "#9fb0a6" }}>Build your own agent — picks tracked live, settled like the bookie</div>
          <div style={{ display: "flex", fontSize: 28, fontWeight: 800, color: "#ffb43c" }}>onside.com.ng</div>
        </div>
      </div>
    ),
    { ...size }
  );
}
