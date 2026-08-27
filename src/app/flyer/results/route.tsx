import { ImageResponse } from "next/og";
import type { NextRequest } from "next/server";

// The daily results flyer — a share-ready image rendered fresh from the settlement data on
// every request. The daily-flyer cron DMs its URL to the owner each morning (Telegram fetches
// it directly); it doubles as an on-demand asset for reels/WhatsApp status any time.
// Sizes: ?size=story (1080×1920 — WhatsApp status, IG story/reel) | feed (1080×1350).
// Data: public_record() only (anon-granted, aggregates + perfect sweeps — nothing private).
export const runtime = "edge";

type RecordData = {
  all_time: { graded: number; won: number };
  days: { day: string; graded: number; won: number; perfect?: number; perfect_n?: number | null }[];
  perfect_details?: { day: string; sweeps: { n: number; legs: { home: string; away: string; market: string; score: string | null }[] }[] }[];
};

const PITCH = "#0e1a1b", CHALK = "#f6f2e9", INK = "#13201d", INK_MUTE = "#5e6e68",
  FLOOD = "#ffb43c", GRASS = "#57a773", GRASS_DEEP = "#3c8859", BRICK = "#c2604a", ONPITCH = "#9fb0a6";

export async function GET(req: NextRequest) {
  const story = (req.nextUrl.searchParams.get("size") ?? "story") !== "feed";
  const W = 1080, H = story ? 1920 : 1350;

  let r: RecordData | null = null;
  try {
    const res = await fetch(`${process.env.NEXT_PUBLIC_SUPABASE_URL}/rest/v1/rpc/public_record`, {
      method: "POST",
      headers: {
        apikey: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
        Authorization: `Bearer ${process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!}`,
        "Content-Type": "application/json",
      },
      body: "{}",
    });
    if (res.ok) r = (await res.json()) as RecordData;
  } catch { /* brand fallback below */ }

  // the flyer covers the most recent COMPLETED day (Lagos): prefer yesterday's entry, else newest
  const lagosNow = new Date(Date.now() + 3600_000); // UTC+1, no DST
  const yest = new Date(lagosNow); yest.setUTCDate(yest.getUTCDate() - 1);
  const yestKey = yest.toISOString().slice(0, 10);
  const day = r?.days?.find((d) => d.day === yestKey) ?? r?.days?.[0] ?? null;
  const lost = day ? day.graded - day.won : 0;
  const pct = day && day.graded > 0 ? Math.round((day.won / day.graded) * 100) : 0;
  const dayLabel = day
    ? new Date(day.day + "T12:00:00Z").toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "short" })
    : "";
  const sweep = r?.perfect_details?.find((p) => p.day === day?.day)?.sweeps?.[0] ?? null;
  const legs = (sweep?.legs ?? []).slice(0, story ? 5 : 4);
  const allPct = r && r.all_time.graded > 0 ? Math.round((r.all_time.won / r.all_time.graded) * 100) : 0;

  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", background: PITCH, padding: story ? "88px 72px" : "64px 72px", fontFamily: "sans-serif" }}>
        {/* brand + date */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ display: "flex", fontSize: 52, fontWeight: 800, color: CHALK }}>
            ON<span style={{ color: FLOOD }}>SIDE</span>
          </div>
          <div style={{ display: "flex", fontSize: 26, fontWeight: 700, color: ONPITCH, letterSpacing: 4 }}>{dayLabel.toUpperCase()}</div>
        </div>

        {/* the day's score — the hero */}
        <div style={{ display: "flex", flexDirection: "column", marginTop: story ? 90 : 56 }}>
          <div style={{ display: "flex", fontSize: 34, fontWeight: 700, color: ONPITCH, letterSpacing: 6 }}>YESTERDAY, GRADED IN PUBLIC</div>
          <div style={{ display: "flex", alignItems: "baseline", gap: 26, marginTop: 18 }}>
            <span style={{ fontSize: story ? 170 : 140, fontWeight: 800, color: GRASS }}>{day ? `${day.won}W` : "—"}</span>
            <span style={{ fontSize: story ? 170 : 140, fontWeight: 800, color: lost > 0 ? BRICK : ONPITCH }}>{day ? `${lost}L` : ""}</span>
          </div>
          <div style={{ display: "flex", fontSize: 40, fontWeight: 700, color: CHALK, marginTop: 6 }}>
            {day ? `${pct}% of ${day.graded} picks landed — misses included` : "The record is live at onside.com.ng/record"}
          </div>
        </div>

        {/* perfect sweep slip, when an agent swept its whole card */}
        {sweep ? (
          <div style={{ display: "flex", flexDirection: "column", background: CHALK, borderRadius: 34, padding: "42px 48px", marginTop: story ? 90 : 48 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <div style={{ display: "flex", fontSize: 40, fontWeight: 800, color: INK }}>🎯 A perfect agent day</div>
              <div style={{ display: "flex", fontSize: 44, fontWeight: 800, color: GRASS_DEEP }}>{sweep.n}/{sweep.n}</div>
            </div>
            <div style={{ display: "flex", borderTop: `4px dashed ${INK_MUTE}55`, marginTop: 26, marginBottom: 8 }} />
            {legs.map((l, i) => (
              <div key={i} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", paddingTop: 20, paddingBottom: 6 }}>
                <div style={{ display: "flex", flexDirection: "column", maxWidth: 700 }}>
                  <span style={{ fontSize: 33, fontWeight: 700, color: INK }}>{l.home} v {l.away}</span>
                  <span style={{ fontSize: 24, color: INK_MUTE, marginTop: 2 }}>{l.market}</span>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 18 }}>
                  {l.score ? <span style={{ fontSize: 33, fontWeight: 800, color: INK }}>{l.score}</span> : null}
                  <span style={{ display: "flex", fontSize: 22, fontWeight: 800, color: GRASS_DEEP, background: "#57a77326", borderRadius: 999, padding: "8px 18px" }}>WON</span>
                </div>
              </div>
            ))}
            {sweep.legs.length > legs.length ? (
              <div style={{ display: "flex", fontSize: 24, color: INK_MUTE, marginTop: 14 }}>…and {sweep.legs.length - legs.length} more, all landed</div>
            ) : null}
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", background: CHALK, borderRadius: 34, padding: "44px 48px", marginTop: story ? 90 : 48 }}>
            <div style={{ display: "flex", fontSize: 32, fontWeight: 700, color: INK_MUTE, letterSpacing: 4 }}>ALL-TIME RECORD</div>
            <div style={{ display: "flex", alignItems: "baseline", gap: 22, marginTop: 10 }}>
              <span style={{ fontSize: 84, fontWeight: 800, color: INK }}>{r ? `${r.all_time.won}/${r.all_time.graded}` : "—"}</span>
              <span style={{ fontSize: 52, fontWeight: 800, color: GRASS_DEEP }}>{r ? `${allPct}%` : ""}</span>
            </div>
            <div style={{ display: "flex", fontSize: 28, color: INK_MUTE, marginTop: 8 }}>Every AI agent pick, graded in the open. Bad days stay on the board.</div>
          </div>
        )}

        {/* the door + compliance */}
        <div style={{ display: "flex", flexDirection: "column", marginTop: "auto" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", background: FLOOD, borderRadius: 26, padding: "30px 40px" }}>
            <span style={{ fontSize: 36, fontWeight: 800, color: INK }}>Build your own AI agent — free</span>
            <span style={{ fontSize: 34, fontWeight: 800, color: INK }}>onside.com.ng</span>
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", marginTop: 26 }}>
            <span style={{ display: "flex", fontSize: 24, color: ONPITCH }}>Onside — Track better, bet better</span>
            <span style={{ display: "flex", fontSize: 24, color: ONPITCH }}>18+ · Bet responsibly</span>
          </div>
        </div>
      </div>
    ),
    { width: W, height: H },
  );
}
