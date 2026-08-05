import type { MetadataRoute } from "next";

// PWA manifest — served at /manifest.webmanifest. Installable to the home screen; launches standalone
// into the tracker. Icons are PNG (the Onside brand glyph) — installed app icons + the Android splash
// are unreliable with SVG, so we ship real rasters at 192/512 + a maskable 512 for adaptive icons.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Onside — track better, bet better",
    short_name: "Onside",
    description: "Track only the bet you made, and let an AI agent run your strategy across your leagues.",
    id: "/",
    start_url: "/tracker",
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: "#0e1a1b",
    theme_color: "#0e1a1b",
    categories: ["sports", "finance", "productivity"],
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
      { src: "/icons/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
    ],
  };
}
