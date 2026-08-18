import { ImageResponse } from "next/og";

// The share card WhatsApp/X unfurl — the first thing a group sees when a slip link lands.
// Anonymised data via the same public RPC as the page; a static brand card if anything fails.
export const runtime = "edge";
export const alt = "A betting slip tracked live on Onside";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

type PublicAcca = {
  stake: number | null; potential: number | null; currency: string | null;
  leg_count: number | null; status: string; legs: { status: string }[];
};

const CUR: Record<string, string> = { NGN: "₦", USD: "$", EUR: "€", GBP: "£", GHS: "GH₵", KES: "KSh", ZAR: "R" };
const money = (cur: string | null, n: number | null) =>
  n == null ? null : `${CUR[cur ?? "NGN"] ?? "₦"}${Number(n).toLocaleString()}`;

export default async function Image({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  let a: PublicAcca | null = null;
  try {
    const res = await fetch(`${process.env.NEXT_PUBLIC_SUPABASE_URL}/rest/v1/rpc/public_acca`, {
      method: "POST",
      headers: {
        apikey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
        Authorization: `Bearer ${process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ p_token: token }),
    });
    if (res.ok) a = (await res.json()) as PublicAcca | null;
  } catch { /* fall through to the brand card */ }

  const fold = a ? (a.leg_count ?? a.legs.length) : null;
  const stake = a ? money(a.currency, a.stake) : null;
  const pot = a ? money(a.currency, a.potential) : null;
  const won = a?.status === "won";
  const dead = a?.status === "lost";
  const stateTxt = won ? "LANDED ✓" : dead ? "CUT" : "TRACKING LIVE";
  const stateColor = won ? "#57a773" : dead ? "#c0563f" : "#ffb43c";
  const landed = a ? a.legs.filter((l) => l.status === "won").length : 0;
  const open = a ? a.legs.filter((l) => l.status === "pending" || l.status === "live").length : 0;

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
            {fold != null ? `${fold}-fold accumulator` : "A slip tracked live"}
          </div>
          {stake && pot ? (
            <div style={{ display: "flex", alignItems: "baseline", gap: 20 }}>
              <span style={{ fontSize: 46, color: "#9fb0a6" }}>{stake}</span>
              <span style={{ fontSize: 46, color: "#9fb0a6" }}>→</span>
              <span style={{ fontSize: 92, fontWeight: 800, color: dead ? "#c0563f" : "#f4f1e8", textDecoration: dead ? "line-through" : "none" }}>{pot}</span>
            </div>
          ) : (
            <div style={{ display: "flex", fontSize: 72, fontWeight: 800, color: "#f4f1e8" }}>Every leg, live.</div>
          )}
          {a ? (
            <div style={{ display: "flex", gap: 28, fontSize: 30, fontWeight: 700 }}>
              {landed > 0 ? <span style={{ color: "#57a773" }}>✓ {landed} landed</span> : null}
              {open > 0 ? <span style={{ color: "#ffb43c" }}>● {open} still in play</span> : null}
            </div>
          ) : null}
        </div>

        {/* footer */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", borderTop: "2px dashed #2a3b36", paddingTop: 28 }}>
          <div style={{ display: "flex", fontSize: 28, color: "#9fb0a6" }}>Upload your slip — tracked live, settled like the bookie</div>
          <div style={{ display: "flex", fontSize: 28, fontWeight: 800, color: "#ffb43c" }}>onside.com.ng</div>
        </div>
      </div>
    ),
    { ...size }
  );
}
