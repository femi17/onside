// App version / update detection. CURRENT_BUILD is baked at build time (see next.config.mjs); the
// /api/version endpoint reports the live deployment's build. A difference => a new version is out.
export const CURRENT_BUILD = process.env.NEXT_PUBLIC_BUILD_ID ?? "dev";

// Human-friendly release label shown in the UI. Derived from the deploy date (baked at build time)
// so it advances on every Vercel deploy on its own — the old hand-bumped constant kept getting stuck.
// The build id above is what actually drives update detection; this is just what users read.
function calver(iso: string | undefined): string {
  const d = iso ? new Date(iso) : new Date();
  if (Number.isNaN(d.getTime())) return "dev";
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `v${d.getUTCFullYear()}.${mm}.${dd}`;
}
export const APP_VERSION = calver(process.env.NEXT_PUBLIC_BUILD_TIME);

export async function fetchLatestBuild(): Promise<string | null> {
  try {
    const res = await fetch("/api/version", { cache: "no-store" });
    if (!res.ok) return null;
    const j = await res.json();
    return typeof j?.build === "string" ? j.build : null;
  } catch {
    return null;
  }
}
