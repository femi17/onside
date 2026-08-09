"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import StickyHeader from "@/components/StickyHeader";
import MobileLogo from "@/components/MobileLogo";
import { useConfirm } from "@/components/ConfirmDialog";

export type StrategyCard = {
  id: string;
  name: string;
  market_label: string | null;
  league_count: number;
  status: string; // running | paused | draft
  has_rule: boolean;
  deliver_at: string | null; // "HH:MM"
  target_day: string; // same_day | tomorrow | saturday | sunday | weekend | future
  delivered: number;
  last14: { won: number; total: number };
  vs_market: number | null; // avg edge %, signed
  spark: ("won" | "lost" | "pending")[];
  last_run_at: string | null;
  ran_empty: boolean; // the LATEST run delivered nothing (rule/bar cleared no games)
};

// "today 11:29" / "Sat 11:29" in the viewer's local time — recent runs only get the banner
function runLabel(iso: string): string {
  const d = new Date(iso);
  const sameDay = d.toDateString() === new Date().toDateString();
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return sameDay ? `today ${time}` : `${d.toLocaleDateString([], { weekday: "short" })} ${time}`;
}

// compact window tag shown after the delivery time ("07:30 · Sat")
const TARGET_TAG: Record<string, string> = {
  same_day: " · same day", tomorrow: " · next day", saturday: " · Sat", sunday: " · Sun",
  weekend: " · weekend", future: " · 3 days",
};

export default function StrategiesBoard({ cards, maxAgents }: { cards: StrategyCard[]; maxAgents: number }) {
  const supabase = createClient();
  const router = useRouter();
  const confirm = useConfirm();
  const [busy, setBusy] = useState<string | null>(null);

  async function setStatus(id: string, status: "running" | "paused") {
    setBusy(id);
    await supabase.from("strategies").update({ status }).eq("id", id);
    setBusy(null);
    router.refresh();
  }

  async function remove(id: string, name: string) {
    if (!(await confirm({ title: "Delete this agent?", body: `Delete “${name}”? This frees a slot. Its feed history is removed — any picks you added to your tracker stay.`, confirmLabel: "Delete", tone: "danger" }))) return;
    setBusy(id);
    await supabase.from("strategies").delete().eq("id", id);
    setBusy(null);
    router.refresh();
  }

  return (
    <div>
      {/* fixed header on every width; transparent at rest, fills in only when scrolled */}
      <StickyHeader>
        <div className="mx-auto max-w-4xl px-5 pb-3 pt-6 md:px-8">
          <MobileLogo />
          <div className="flex items-end justify-between gap-3">
            <div>
              <p className="font-mono text-[11px] uppercase tracking-[0.25em] text-flood">{cards.length} agent{cards.length === 1 ? "" : "s"}</p>
              <h1 className="mt-2 font-disp text-3xl font-bold tracking-tight text-chalk sm:text-4xl">Your agents.</h1>
            </div>
            {/* new agent: compact icon on mobile, full-text button on desktop */}
            <Link
              href="/strategies/new"
              aria-label="New agent"
              title="New agent"
              className="flex h-11 w-11 flex-none items-center justify-center rounded-xl bg-flood font-bold text-ink shadow-lg transition-transform hover:-translate-y-0.5 md:h-auto md:w-auto md:px-4 md:py-3"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" className="h-5 w-5 md:hidden" aria-hidden="true">
                <line x1="12" y1="5" x2="12" y2="19" />
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
              <span className="hidden md:inline">+ New agent</span>
            </Link>
          </div>
        </div>
      </StickyHeader>
      <div className="mx-auto max-w-4xl px-5 pb-24 pt-2 md:px-8">

      {cards.length === 0 ? (
        <div className="mt-10 rounded-2xl border border-dashed border-ink/15 bg-chalk p-12 text-center shadow-xl">
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-flood/15 font-mono text-xl text-flood-deep">◆</div>
          <h2 className="font-disp text-xl font-bold text-ink">No agents yet.</h2>
          <p className="mx-auto mt-2 max-w-sm text-sm text-ink-mute">
            An agent hunts a market across your leagues, applies your rule, and delivers the games that clear your bar — on your schedule.
          </p>
          <Link href="/strategies/new" className="mt-5 inline-block rounded-xl bg-flood px-5 py-3 font-bold text-ink">Build your first agent</Link>
        </div>
      ) : (
        <div className="mt-6 grid gap-4 sm:grid-cols-2">
          {cards.map((c) => (
            <div key={c.id} className="min-w-0 rounded-2xl bg-chalk p-5 text-ink shadow-xl">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="truncate font-disp text-xl font-extrabold tracking-tight text-ink">{c.name}</div>
                  <div className="mt-0.5 truncate font-mono text-[11px] font-bold uppercase tracking-wide text-flood-deep">
                    {c.market_label ?? "Market"} · {c.league_count === 0 ? "all leagues" : `${c.league_count} league${c.league_count === 1 ? "" : "s"}`}{c.has_rule ? " · rule" : ""}
                  </div>
                </div>
                <StatusPill status={c.status} />
              </div>

              {/* heads-up when the newest run sent nothing: the agent isn't broken, it's being
                  selective — but a rule that's TOO strict looks identical, so point at it */}
              {c.status === "running" && c.ran_empty && c.last_run_at && Date.now() - Date.parse(c.last_run_at) < 36 * 3600 * 1000 && (
                <div className="mt-3 rounded-xl bg-flood/10 px-3 py-2.5 text-[12.5px] leading-snug">
                  <span className="font-bold text-ink">Ran {runLabel(c.last_run_at)} — no games cleared your {c.has_rule ? "rule" : "bar"}.</span>{" "}
                  <span className="text-ink-mute">
                    It sends nothing rather than a weak pick.{" "}
                    {c.has_rule ? (
                      <Link href={`/strategies/${c.id}/edit`} className="font-bold text-ink underline decoration-ink/30 underline-offset-2 hover:decoration-ink">
                        Check the rule →
                      </Link>
                    ) : (
                      <Link href={`/strategies/${c.id}/edit`} className="font-bold text-ink underline decoration-ink/30 underline-offset-2 hover:decoration-ink">
                        Review settings →
                      </Link>
                    )}
                  </span>
                </div>
              )}

              <div className="mt-4 flex gap-1 border-t border-dashed border-ink/15 pt-4">
                {c.spark.length ? c.spark.map((s, i) => (
                  <span key={i} className={`h-8 flex-1 rounded-sm ${s === "won" ? "bg-flood-deep" : s === "lost" ? "bg-ink/15" : "bg-ink/[0.06]"}`} style={{ height: s === "pending" ? 14 : undefined }} />
                )) : <span className="font-mono text-[11px] text-ink-mute">No results yet.</span>}
              </div>

              <div className="mt-4 flex flex-wrap gap-x-6 gap-y-2">
                <Stat k="Delivers" v={c.deliver_at ? `${c.deliver_at}${TARGET_TAG[c.target_day] ?? ""}` : "—"} />
                <Stat k="Last 14d" v={c.last14.total ? `${c.last14.won}/${c.last14.total}` : "—"} />
                <Stat k="vs market" v={c.vs_market == null ? "—" : `${c.vs_market > 0 ? "+" : ""}${c.vs_market.toFixed(1)}%`} tone={c.vs_market == null ? undefined : c.vs_market >= 0 ? "up" : "down"} />
                <Stat k="Delivered" v={String(c.delivered)} />
              </div>

              <div className="mt-4 flex flex-wrap items-center gap-2.5">
                <Link href={`/strategies/${c.id}/edit`} className="rounded-lg border border-ink/20 px-3.5 py-2 text-[13px] font-bold text-ink hover:border-ink/40">Edit</Link>
                {c.status === "running" ? (
                  <button disabled={busy === c.id} onClick={() => setStatus(c.id, "paused")} className="rounded-lg border border-ink/20 px-3.5 py-2 text-[13px] font-bold text-ink hover:border-ink/40 disabled:opacity-50">Pause</button>
                ) : (
                  <button disabled={busy === c.id} onClick={() => setStatus(c.id, "running")} className="rounded-lg bg-flood px-3.5 py-2 text-[13px] font-bold text-ink disabled:opacity-50">Resume</button>
                )}
                <Link href="/agent" className="rounded-lg border border-ink/20 px-3.5 py-2 text-[13px] font-bold text-ink hover:border-ink/40">Feed</Link>
                <button disabled={busy === c.id} onClick={() => remove(c.id, c.name)} className="ml-auto rounded-lg px-2.5 py-2 text-[13px] font-bold text-brick hover:bg-brick/10 disabled:opacity-50">Delete</button>
              </div>
            </div>
          ))}

          {cards.length < maxAgents && (
            <Link href="/strategies/new" className="flex min-h-[200px] flex-col items-center justify-center gap-2.5 rounded-2xl border-[1.5px] border-dashed border-white/15 p-8 text-onpitch-mute transition hover:border-flood hover:text-chalk">
              <span className="grid h-11 w-11 place-items-center rounded-xl bg-flood font-mono text-xl font-bold text-ink">+</span>
              <span className="font-bold">Build a new agent</span>
              <span className="font-mono text-[11px]">{maxAgents >= 999 ? "unlimited slots" : `${maxAgents - cards.length} slot${maxAgents - cards.length === 1 ? "" : "s"} left`}</span>
            </Link>
          )}
        </div>
      )}
      </div>
    </div>
  );
}

function StatusPill({ status }: { status: string }) {
  const map: Record<string, string> = {
    running: "bg-grass/15 text-grass-deep",
    paused: "bg-ink/[0.08] text-ink-mute",
    draft: "bg-flood/15 text-flood-deep",
  };
  return <span className={`flex-none rounded-full px-2.5 py-1 font-mono text-[10.5px] font-bold uppercase tracking-wide ${map[status] ?? map.paused}`}>{status}</span>;
}
function Stat({ k, v, tone }: { k: string; v: string; tone?: "up" | "down" }) {
  return (
    <div>
      <div className="font-mono text-[10px] uppercase tracking-wide text-ink-mute">{k}</div>
      <div className={`mt-1 font-disp text-xl font-extrabold ${tone === "up" ? "text-grass-deep" : tone === "down" ? "text-brick" : "text-ink"}`}>{v}</div>
    </div>
  );
}
