/** @type {import('next').NextConfig} */
const nextConfig = {
  // Build stamp baked into the client bundle. /api/version reports the CURRENTLY deployed stamp at
  // runtime; when they differ, an already-open app is behind a new deploy -> we prompt a reload.
  env: {
    NEXT_PUBLIC_BUILD_ID: process.env.VERCEL_GIT_COMMIT_SHA ?? "dev",
    // Deploy timestamp, baked at build time -> drives the friendly calendar version shown in Profile
    // so it moves on every deploy without anyone hand-bumping a constant.
    NEXT_PUBLIC_BUILD_TIME: new Date().toISOString(),
  },
  images: {
    // API-Football league/flag media (facts/flags only — avoid official club/league
    // trademarked badges in the commercial product; prefer flags + text names)
    remotePatterns: [{ protocol: "https", hostname: "media.api-sports.io" }],
  },
};

export default nextConfig;
