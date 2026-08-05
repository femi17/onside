"use client";

import { useRouter } from "next/navigation";

// Simple "go back to where you came from" button for standalone pages (terms/privacy). Falls back to
// the tracker if there's no history to go back to (e.g. opened directly / new tab).
export default function BackButton({ className = "", fallback = "/tracker" }: { className?: string; fallback?: string }) {
  const router = useRouter();
  function back() {
    if (typeof window !== "undefined" && window.history.length > 1) router.back();
    else router.push(fallback);
  }
  return (
    <button
      onClick={back}
      className={className || "font-mono text-xs text-onpitch-mute transition-colors hover:text-chalk"}
    >
      &larr; Back
    </button>
  );
}
