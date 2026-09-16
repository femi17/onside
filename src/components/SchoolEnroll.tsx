"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";

const naira = (n: number) => "₦" + n.toLocaleString("en-US");

// Manual bank-transfer join: show the account, take a receipt screenshot, file a 'pending' enrollment.
// An admin admits from the panel at the top of /school. Not Paystack — this is a human-reviewed lane.
export default function SchoolEnroll({
  userId,
  price,
  bank,
  initialStatus,
}: {
  userId: string;
  price: number;
  bank: { bank: string; account: string; name: string };
  initialStatus: "none" | "pending" | "rejected";
}) {
  const [status, setStatus] = useState(initialStatus);
  const [open, setOpen] = useState(false); // upload form stays collapsed until the user clicks in
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  async function copyAcct() {
    try {
      await navigator.clipboard.writeText(bank.account.replace(/\s/g, ""));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked — the number is on screen anyway */
    }
  }

  async function submit() {
    if (!file) {
      setErr("Attach your transfer receipt first.");
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const supabase = createClient();
      const ext = file.name.split(".").pop()?.toLowerCase() || "png";
      const path = `${userId}/${crypto.randomUUID()}.${ext}`;
      const up = await supabase.storage.from("school-receipts").upload(path, file);
      if (up.error) throw new Error(up.error.message);
      // user_id defaults to auth.uid(); status defaults to 'pending' — RLS enforces both.
      const ins = await supabase.from("school_enrollments").insert({ receipt_path: path, amount: price });
      if (ins.error) throw new Error(ins.error.message);
      setStatus("pending");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Something went wrong — please try again.");
    } finally {
      setBusy(false);
    }
  }

  if (status === "pending") {
    return (
      <section id="join" className="rounded-2xl border border-flood/30 bg-pitch-2 p-6 text-center">
        <span className="text-2xl">⏳</span>
        <h3 className="mt-2 font-disp text-xl font-bold text-chalk">Payment under review</h3>
        <p className="mx-auto mt-2 max-w-sm text-sm text-onpitch-mute">
          We&apos;ve got your receipt. As soon as it&apos;s confirmed you&apos;ll be admitted and today&apos;s pick
          unlocks — usually within a few hours.
        </p>
      </section>
    );
  }

  return (
    <section id="join" className="rounded-2xl border border-flood/30 bg-pitch-2 p-5">
      <p className="font-mono text-[10.5px] uppercase tracking-[0.25em] text-flood">Join · {naira(price)}/month</p>
      <h3 className="mt-1 font-disp text-xl font-bold tracking-tight text-chalk">Get today&apos;s pick</h3>

      {status === "rejected" && (
        <p className="mt-3 rounded-xl border border-brick/40 bg-brick/10 px-3 py-2 text-[13px] text-brick">
          Your last receipt couldn&apos;t be confirmed. Please transfer and upload a clear receipt again.
        </p>
      )}

      {/* 1 — transfer */}
      <div className="mt-4">
        <p className="font-mono text-[10.5px] uppercase tracking-wide text-onpitch-mute">1 · Transfer {naira(price)} to</p>
        <div className="mt-2 rounded-xl border border-white/10 bg-pitch p-4">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="font-disp text-2xl font-extrabold tabular-nums tracking-tight text-chalk">
                {bank.account}
              </div>
              <div className="mt-0.5 truncate text-sm text-onpitch">
                {bank.bank} · {bank.name}
              </div>
            </div>
            <button
              type="button"
              onClick={copyAcct}
              className="h-9 flex-none rounded-lg border border-white/15 bg-pitch-2 px-3 font-mono text-[12px] font-bold text-flood transition hover:border-flood/40"
            >
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
        </div>
      </div>

      {/* 2 — upload (collapsed until clicked, to keep the card compact) */}
      {!open ? (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="mt-4 flex h-11 w-full items-center justify-between rounded-xl border border-white/15 bg-pitch px-4 font-mono text-[12px] font-bold text-flood transition hover:border-flood/40"
        >
          <span>2 · I&apos;ve paid — upload receipt</span>
          <span aria-hidden>▾</span>
        </button>
      ) : (
        <div className="mt-4">
          <p className="font-mono text-[10.5px] uppercase tracking-wide text-onpitch-mute">2 · Upload your receipt</p>
          <label className="mt-2 flex cursor-pointer items-center justify-between gap-3 rounded-xl border border-dashed border-white/20 bg-pitch px-4 py-3 transition hover:border-flood/40">
            <span className="truncate text-sm text-onpitch">
              {file ? file.name : "Tap to attach a screenshot or photo"}
            </span>
            <span className="flex-none font-mono text-[12px] font-bold text-flood">{file ? "Change" : "Attach"}</span>
            <input
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => {
                setFile(e.target.files?.[0] ?? null);
                setErr(null);
              }}
            />
          </label>

          {err && <p className="mt-3 text-[13px] text-brick">{err}</p>}

          <button
            type="button"
            onClick={submit}
            disabled={busy || !file}
            className="mt-3 h-12 w-full rounded-xl bg-flood font-disp text-base font-bold text-pitch transition hover:bg-flood/90 disabled:opacity-40"
          >
            {busy ? "Sending…" : "Submit for admission"}
          </button>
          <p className="mt-3 text-center font-mono text-[10.5px] text-onpitch-mute">
            Reviewed by hand · access lasts 30 days · 18+
          </p>
        </div>
      )}
    </section>
  );
}
