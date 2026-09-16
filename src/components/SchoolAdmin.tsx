"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";

type Row = {
  id: string;
  user_id: string;
  email: string | null;
  display_name: string | null;
  receipt_path: string | null;
  amount: number | null;
  note: string | null;
  created_at: string;
};

const naira = (n: number) => "₦" + n.toLocaleString("en-US");
const when = (iso: string) => new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

// Admin-only review queue: pending receipts with the payer's identity + a signed preview of the image.
// Admit (30 days) or reject via the security-definer RPCs. Hidden entirely when nothing is pending.
export default function SchoolAdmin() {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [urls, setUrls] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function load() {
    const supabase = createClient();
    const { data, error } = await supabase.rpc("school_pending");
    if (error) {
      // before the migration is applied the function doesn't exist — hide the panel silently rather
      // than showing a scary schema-cache error; surface only genuine failures.
      const notMigrated = error.code === "PGRST202" || /Could not find the function|schema cache/i.test(error.message);
      if (!notMigrated) setErr(error.message);
      setRows([]);
      return;
    }
    const list = (data ?? []) as Row[];
    setRows(list);
    const map: Record<string, string> = {};
    await Promise.all(
      list.map(async (r) => {
        if (!r.receipt_path) return;
        const s = await supabase.storage.from("school-receipts").createSignedUrl(r.receipt_path, 600);
        if (s.data?.signedUrl) map[r.id] = s.data.signedUrl;
      })
    );
    setUrls(map);
  }

  useEffect(() => {
    load();
  }, []);

  async function act(id: string, kind: "admit" | "reject") {
    setBusy(id);
    setErr(null);
    const supabase = createClient();
    const { error } =
      kind === "admit"
        ? await supabase.rpc("school_admit", { p_id: id, p_days: 30 })
        : await supabase.rpc("school_reject", { p_id: id });
    setBusy(null);
    if (error) {
      setErr(error.message);
      return;
    }
    setRows((rs) => (rs ?? []).filter((r) => r.id !== id));
  }

  // hide the whole panel when the queue is empty (or still loading with nothing to show)
  if (rows && rows.length === 0 && !err) return null;

  return (
    <section className="rounded-2xl border border-flood/30 bg-pitch-2 p-5">
      <div className="flex items-center justify-between">
        <p className="font-mono text-[10.5px] uppercase tracking-[0.2em] text-flood">
          Pending admissions{rows ? ` · ${rows.length}` : ""}
        </p>
        <button onClick={load} className="font-mono text-[10.5px] text-onpitch-mute hover:text-chalk">
          Refresh
        </button>
      </div>

      {err && <p className="mt-3 text-[13px] text-brick">{err}</p>}
      {!rows && <p className="mt-3 text-sm text-onpitch-mute">Loading…</p>}

      <div className="mt-3 flex flex-col gap-3">
        {(rows ?? []).map((r) => (
          <div key={r.id} className="rounded-xl border border-white/10 bg-pitch p-3">
            <div className="flex items-start gap-3">
              {urls[r.id] ? (
                <a href={urls[r.id]} target="_blank" rel="noreferrer" className="flex-none">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={urls[r.id]} alt="receipt" className="h-16 w-16 rounded-lg object-cover ring-1 ring-white/10" />
                </a>
              ) : (
                <div className="flex h-16 w-16 flex-none items-center justify-center rounded-lg bg-pitch-2 text-onpitch-mute">
                  <span className="text-lg">🧾</span>
                </div>
              )}
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-bold text-chalk">{r.display_name || r.email || r.user_id.slice(0, 8)}</div>
                {r.email && <div className="truncate font-mono text-[11px] text-onpitch-mute">{r.email}</div>}
                <div className="mt-0.5 font-mono text-[11px] text-onpitch-mute">
                  {r.amount ? naira(r.amount) : "—"} · {when(r.created_at)}
                </div>
                {r.note && <div className="mt-1 text-[12px] text-onpitch">{r.note}</div>}
              </div>
            </div>
            <div className="mt-3 flex gap-2">
              <button
                onClick={() => act(r.id, "admit")}
                disabled={busy === r.id}
                className="h-9 flex-1 rounded-lg bg-grass font-mono text-[12px] font-bold text-pitch transition hover:bg-grass/90 disabled:opacity-40"
              >
                {busy === r.id ? "…" : "Admit 30 days"}
              </button>
              <button
                onClick={() => act(r.id, "reject")}
                disabled={busy === r.id}
                className="h-9 flex-none rounded-lg border border-white/15 bg-pitch-2 px-4 font-mono text-[12px] font-bold text-brick transition hover:border-brick/40 disabled:opacity-40"
              >
                Reject
              </button>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
