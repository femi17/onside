import type { Metadata, Viewport } from "next";
import "./globals.css";
import ServiceWorkerRegister from "@/components/ServiceWorkerRegister";

export const metadata: Metadata = {
  title: "Onside — track only the bet you made",
  description:
    "Track only the market you bet, and let an AI agent run your strategy across your leagues.",
  applicationName: "Onside",
  manifest: "/manifest.webmanifest",
  appleWebApp: { capable: true, statusBarStyle: "black-translucent", title: "Onside" },
  // defining metadata.icons overrides Next's auto file-based icon link, so the favicon must be listed
  // here too (otherwise the browser falls back to a missing /favicon.ico and shows blank)
  icons: { icon: "/icon.svg", shortcut: "/icon.svg", apple: "/icons/apple-icon.png" },
};

export const viewport: Viewport = {
  themeColor: "#0e1a1b",
  // let the app draw under the iOS status bar / notch when installed
  viewportFit: "cover",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Footer is rendered per-context: fixed at the bottom of the app shell for
  // signed-in pages, at the end of the document for marketing/auth pages.
  return (
    <html lang="en">
      <body>
        <ServiceWorkerRegister />
        {children}
      </body>
    </html>
  );
}
