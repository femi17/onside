// App version / update detection. CURRENT_BUILD is baked at build time (see next.config.mjs); the
// /api/version endpoint reports the live deployment's build. A difference => a new version is out.
export const CURRENT_BUILD = process.env.NEXT_PUBLIC_BUILD_ID ?? "dev";

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
