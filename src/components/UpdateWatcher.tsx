"use client";

// Global "new version available" bar. Shows only when the running app is behind the live deploy.
// Sits above the mobile tab bar so it doesn't fight the sticky header.
import { useUpdateAvailable, reloadForUpdate } from "@/lib/useUpdateAvailable";

export default function UpdateWatcher() {
  const stale = useUpdateAvailable();
  if (!stale) return null;
  return (
    <div className="fixed inset-x-0 bottom-[84px] z-[65] flex justify-center px-3 md:bottom-6">
      <div className="flex items-center gap-3 rounded-full border border-ink/10 bg-ink px-4 py-2.5 text-white shadow-2xl">
        <span className="text-[13px] font-semibold">A new version of Onside is available</span>
        <button
          onClick={reloadForUpdate}
          className="rounded-full bg-white/15 px-3 py-1 text-[12px] font-bold text-white transition hover:bg-white/25"
        >
          Reload
        </button>
      </div>
    </div>
  );
}
