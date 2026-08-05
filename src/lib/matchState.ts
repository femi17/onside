// Turns a fixture's raw status into a human, status-aware display.
const LIVE_PLAY = new Set(["1H", "2H", "ET", "BT", "P", "LIVE"]);
const DONE = new Set(["FT", "AET", "PEN"]);

export type MatchState = {
  phase: "upcoming" | "live" | "done";
  label: string;
  score: string | null;
};

function timeWAT(iso: string) {
  const d = new Date(iso);
  return (
    d.toLocaleDateString("en-GB", { timeZone: "Africa/Lagos", weekday: "short" }) +
    " " +
    d.toLocaleTimeString("en-GB", {
      timeZone: "Africa/Lagos",
      hour: "2-digit",
      minute: "2-digit",
    })
  );
}

// the regulation minute a half is capped at — stoppage beyond it shows as "+N"
function halfBoundary(status: string): number | null {
  return status === "1H" ? 45 : status === "2H" ? 90 : status === "ET" ? 120 : null;
}

// clock text for a running half: "67'" in normal play, "90+3'" in added time
function clockText(status: string, elapsed: number | null, extra: number | null): string | null {
  if (elapsed == null) return null;
  const boundary = halfBoundary(status);
  // added minutes come from the feed's `extra`; fall back to any overflow past the boundary
  const added = extra != null && extra > 0 ? extra : boundary != null && elapsed > boundary ? elapsed - boundary : 0;
  if (boundary != null && added > 0) return `${boundary}+${added}'`;
  return `${elapsed}'`;
}

export function matchState(
  status: string | null,
  elapsed: number | null,
  extra: number | null,
  homeGoals: number | null,
  awayGoals: number | null,
  kickoffIso: string
): MatchState {
  const s = status ?? "NS";
  const score =
    homeGoals != null && awayGoals != null ? `${homeGoals}–${awayGoals}` : null;

  if (DONE.has(s))
    return {
      phase: "done",
      label: s === "PEN" ? "Full-time (pens)" : s === "AET" ? "After extra time" : "Full-time",
      score,
    };
  if (s === "HT") return { phase: "live", label: "Half-time", score };
  if (LIVE_PLAY.has(s)) {
    const half =
      s === "1H" ? "1st half" : s === "2H" ? "2nd half" : s === "ET" ? "Extra time" : "Live";
    const clock = clockText(s, elapsed, extra);
    return { phase: "live", label: clock ? `${half} · ${clock}` : half, score };
  }
  return { phase: "upcoming", label: timeWAT(kickoffIso), score: null };
}
