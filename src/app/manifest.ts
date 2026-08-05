import type { MetadataRoute } from "next";

// PWA manifest — served at /manifest.webmanifest. Installable to the home screen; launches standalone
// into the tracker. Icons are SVG (crisp at any size) + a maskable variant for Android adaptive icons.
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
      { src: "/icons/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
      { src: "/icons/maskable.svg", sizes: "any", type: "image/svg+xml", purpose: "maskable" },
    ],
  };
}
