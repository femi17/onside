"use client";

// Admin moderation queue (Phase E). Staff-only. Lists reported posts + comments (report_count > 0)
// with the reporter/reason rollup, and resolves each via the admin_moderate RPC (self-gated to admins).
// Every action clears the item's reports so it leaves the queue.
import { useState } from "react";
import { createClient } from "@/lib/supabase/client";

export type QueueItem = {
  target_type: "post" | "comment";
  target_id: string;
  author_handle: string;
  author_color: string | null;
  body: string | null;
  kind: string;
  attachment: { match?: string; league?: string | null; market?: string; result?: string } | null;
  hidden: boolean;
  report_count: number;
  created_at: string;
  reporters: number;
  reasons: (string | null)[];
  last_reported_at: string | null;
};

function ago(iso: string | null): string {
  if (!iso) return "";
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

function Avatar({ handle, color }: { handle: string; color: string | null }) {
  return (
    <span
      className="grid h-8 w-8 flex-none place-items-center rounded-full font-disp text-[13px] font-extrabold text-white"
      style={{ backgroundColor: color ?? "#2f6bff" }}
    >
      {(handle[0] ?? "?").toUpperCase()}
    </span>
  );
}

export default function ModerationQueue({ initialItems }: { initialItems: QueueItem[] }) {
  const supabase = createClient();
  const [items, setItems] = useState<QueueItem[]>(initialItems);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function moderate(it: QueueItem, action: "hide" | "restore" | "delete") {
    if (action === "delete" && typeof window !== "undefined" && !window.confirm("Permanently delete this content?")) return;
    const key = `${it.target_type}:${it.target_id}`;
    setBusy(key); setErr(null);
    const { error } = await supabase.rpc("admin_moderate", {
      p_target_type: it.target_type,
      p_target_id: it.target_id,
      p_action: action,
    });
    setBusy(null);
    if (error) { setErr(error.message); return; }
    setItems((xs) => xs.filter((x) => !(x.target_type === it.target_type && x.target_id === it.target_id)));
  }

  if (items.length === 0) {
    return (
      <p className="rounded-2xl border border-dashed border-white/15 bg-pitch-2 p-8 text-center text-[13.5px] text-onpitch-mute">
        Queue is clear — nothing reported is waiting on a decision. ✅
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {err && <p className="rounded-lg bg-brick/15 px-3 py-2 font-mono text-[12px] text-brick">{err}</p>}
      {items.map((it) => {
        const key = `${it.target_type}:${it.target_id}`;
        const reasons = it.reasons.filter(Boolean) as string[];
        return (
          <div key={key} className="rounded-2xl border border-white/10 bg-pitch-2 p-4">
            <div className="flex flex-wrap items-center gap-2">
              <Avatar handle={it.author_handle} color={it.author_color} />
              <span className="font-bold text-chalk">{it.author_handle}</span>
              <span className="rounded-full border border-white/15 px-2 py-0.5 font-mono text-[10px] uppercase tracking-wide text-onpitch-mute">
                {it.target_type}
              </span>
              {it.hidden && (
                <span className="rounded-full bg-brick/20 px-2 py-0.5 font-mono text-[10px] font-bold uppercase tracking-wide text-brick">
                  auto-hidden
                </span>
              )}
              <span className="ml-auto font-mono text-[11px] text-onpitch-mute">reported {ago(it.last_reported_at)}</span>
            </div>

            {it.body && <div className="mt-2.5 whitespace-pre-wrap rounded-lg bg-pitch px-3 py-2 text-[13.5px] leading-relaxed text-chalk">{it.body}</div>}
            {it.attachment && (it.kind === "result" || it.kind === "slip") && (
              <div className="mt-2 inline-flex flex-wrap items-center gap-2 rounded-lg border border-white/10 bg-pitch px-3 py-2 font-mono text-[12px] text-chalk">
                {it.attachment.market && <span className="font-bold">{it.attachment.market}</span>}
                {it.attachment.match && <><span className="text-onpitch-mute">·</span><span>{it.attachment.match}</span></>}
                {it.attachment.result && <span className="text-onpitch-mute">{it.attachment.result}</span>}
              </div>
            )}

            <div className="mt-3 flex flex-wrap items-center gap-2 font-mono text-[11px] text-onpitch-mute">
              <span className="font-bold text-flood">{it.reporters} report{it.reporters === 1 ? "" : "s"}</span>
              {reasons.length > 0 && <span>· {reasons.join(", ")}</span>}
            </div>

            <div className="mt-3 flex flex-wrap gap-2">
              {it.hidden ? (
                <button
                  onClick={() => moderate(it, "restore")}
                  disabled={busy === key}
                  className="rounded-lg border border-grass/40 px-3 py-2 font-mono text-[12px] font-bold text-grass transition-colors hover:bg-grass/10 disabled:opacity-50"
                >
                  Restore (approve)
                </button>
              ) : (
                <button
                  onClick={() => moderate(it, "hide")}
                  disabled={busy === key}
                  className="rounded-lg border border-white/20 px-3 py-2 font-mono text-[12px] font-bold text-chalk transition-colors hover:border-white/40 disabled:opacity-50"
                >
                  Hide
                </button>
              )}
              {!it.hidden && (
                <button
                  onClick={() => moderate(it, "restore")}
                  disabled={busy === key}
                  className="rounded-lg border border-white/20 px-3 py-2 font-mono text-[12px] font-bold text-onpitch-mute transition-colors hover:text-chalk disabled:opacity-50"
                >
                  Dismiss (keep)
                </button>
              )}
              <button
                onClick={() => moderate(it, "delete")}
                disabled={busy === key}
                className="ml-auto rounded-lg border border-brick/40 px-3 py-2 font-mono text-[12px] font-bold text-brick transition-colors hover:bg-brick/10 disabled:opacity-50"
              >
                Delete
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
