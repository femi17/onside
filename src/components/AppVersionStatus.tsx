"use client";

// Profile row showing whether the app is up to date, with a one-tap reload when a new build is out.
import { useUpdateAvailable, reloadForUpdate } from "@/lib/useUpdateAvailable";
import { CURRENT_BUILD } from "@/lib/version";

export default function AppVersionStatus() {
  const stale = useUpdateAvailable();
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="min-w-0">
        <p className="text-sm font-bold text-ink">App version</p>
        <p className="mt-0.5 text-[12.5px] text-ink-mute">
          {stale ? "A new version is available." : "You're on the latest version."}
          <span className="ml-1 font-mono text-[10px] text-ink-mute/70">
            {CURRENT_BUILD === "dev" ? "dev" : CURRENT_BUILD.slice(0, 7)}
          </span>
        </p>
      </div>
      {stale && (
        <button
          onClick={reloadForUpdate}
          className="flex-none rounded-lg bg-grass-deep px-3 py-1.5 text-[12px] font-bold text-white transition hover:brightness-110"
        >
          Reload
        </button>
      )}
    </div>
  );
}
