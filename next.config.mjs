/** @type {import('next').NextConfig} */
const nextConfig = {
  images: {
    // API-Football league/flag media (facts/flags only — avoid official club/league
    // trademarked badges in the commercial product; prefer flags + text names)
    remotePatterns: [{ protocol: "https", hostname: "media.api-sports.io" }],
  },
};

export default nextConfig;
