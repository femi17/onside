import { NextResponse } from "next/server";

// Reports the build currently serving this deployment. An open client compares it against the stamp
// baked into its own bundle (NEXT_PUBLIC_BUILD_ID); a mismatch means a newer version has deployed.
// Must never be cached, or clients would keep seeing a stale build id.
export const dynamic = "force-dynamic";

export async function GET() {
  const build = process.env.VERCEL_GIT_COMMIT_SHA ?? "dev";
  return NextResponse.json({ build }, { headers: { "cache-control": "no-store, max-age=0" } });
}
