// Copyright-safe league visuals: a tier-based icon (never official badges) plus
// the country flag (flags aren't copyrighted).
//   uefa  -> 🏆 cup       (Champions / Europa / Conference League)
//   top   -> 👟 boot      (top-flight big leagues)
//   mid   -> ⚽ football  (mid leagues)
//   lower -> 🍽️ plate     (lower / emerging leagues)
export function tierIcon(tier?: string | null): string {
  switch (tier) {
    case "uefa":
      return "🏆";
    case "top":
      return "👟";
    case "mid":
      return "⚽";
    default:
      return "🍽️";
  }
}
