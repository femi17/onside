"use client";

// One founder question at a time, tied to what the user actually did. The server RPC
// (next_feedback_prompt) owns ALL targeting: one ask per user per 7 days, never the same
// question twice, admins/demo excluded — asking for a prompt records the ask, so a dismissed
// card is not re-nagged. This component only renders the copy and posts the answer back.
// Copy lives here (keys in the DB) so wording can evolve without a migration.
import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";

type Q = {
  title: string;
  options?: { label: string; value: string; askNote?: string }[]; // askNote → follow-up textarea
  freeText?: string; // placeholder → textarea-only question
};

const QUESTIONS: Record<string, Q> = {
  agent_staked: {
    title: "Did you stake any of your agent's picks this week?",
    options: [
      { label: "Most of them", value: "most" },
      { label: "One or two", value: "some" },
      { label: "No — just watching", value: "watching", askNote: "What's holding you back from staking them?" },
    ],
  },
  losing_pain: {
    title: "One of your picks lost this week. How did that land with you?",
    options: [
      { label: "Part of betting", value: "fine" },
      { label: "Annoying, but I get it", value: "annoying" },
      { label: "It makes me trust Onside less", value: "trust_hit", askNote: "That's fair — tell me more?" },
    ],
  },
  tracking_value: {
    title: "Has tracking your bets on Onside actually helped you?",
    options: [
      { label: "Yes, a lot", value: "yes" },
      { label: "A bit", value: "a_bit" },
      { label: "Not really", value: "no", askNote: "What were you hoping it would do for you?" },
    ],
  },
  pmf: {
    title: "If Onside disappeared tomorrow, how would you feel?",
    options: [
      { label: "Very disappointed", value: "very", askNote: "What would you miss most?" },
      { label: "Somewhat disappointed", value: "somewhat", askNote: "What would you miss most?" },
      { label: "Not really bothered", value: "not", askNote: "What's missing for you?" },
    ],
  },
  agent_quality: {
    title: "Is your agent picking games YOU would actually bet?",
    options: [
      { label: "Mostly yes", value: "yes" },
      { label: "Sometimes", value: "sometimes", askNote: "What would make the picks feel more like yours?" },
      { label: "Not really", value: "no", askNote: "What would make the picks feel more like yours?" },
    ],
  },
  improve: {
    title: "If you could change ONE thing about Onside, what would it be?",
    freeText: "Anything — a missing market, something confusing, an idea…",
  },
};

const DAY_KEY = "onside-founder-q-checked"; // ask the server at most once per day per browser

export default function FounderQuestion() {
  const [key, setKey] = useState<string | null>(null);
  const [picked, setPicked] = useState<{ value: string; askNote?: string } | null>(null);
  const [note, setNote] = useState("");
  const [phase, setPhase] = useState<"ask" | "note" | "thanks">("ask");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const today = new Date().toISOString().slice(0, 10);
    try {
      if (localStorage.getItem(DAY_KEY) === today) return;
      localStorage.setItem(DAY_KEY, today);
    } catch { /* private mode — still fine, server gate holds */ }
    const t = setTimeout(async () => {
      const sb = createClient();
      const { data } = await sb.rpc("next_feedback_prompt");
      if (typeof data === "string" && QUESTIONS[data]) setKey(data);
    }, 2500); // let the page land first — this is a guest, not a doorman
    return () => clearTimeout(t);
  }, []);

  if (!key) return null;
  const q = QUESTIONS[key];

  async function send(answer: string | null, noteText: string | null) {
    setBusy(true);
    try {
      const sb = createClient();
      await sb.rpc("answer_feedback_prompt", { p_key: key, p_answer: answer, p_note: noteText });
    } catch { /* losing one answer beats blocking the user */ }
    setBusy(false);
  }

  async function choose(opt: { value: string; askNote?: string }) {
    setPicked(opt);
    if (opt.askNote) { setPhase("note"); return; }
    await send(opt.value, null);
    setPhase("thanks");
    setTimeout(() => setKey(null), 1600);
  }

  async function submitNote(skip: boolean) {
    await send(picked?.value ?? (q.freeText ? "free_text" : null), skip ? null : note);
    setPhase("thanks");
    setTimeout(() => setKey(null), 1600);
  }

  async function dismiss() {
    void send(null, null);
    setKey(null);
  }

  return (
    <div className="fixed inset-x-0 bottom-0 z-[60] px-3 pb-3 pt-2 md:inset-x-auto md:bottom-6 md:right-6 md:w-[380px] md:px-0 md:pb-0">
      <div className="mx-auto max-w-md rounded-2xl border border-ink/10 bg-chalk p-4 shadow-2xl md:max-w-none">
        {phase === "thanks" ? (
          <p className="py-2 text-center text-sm font-bold text-ink">Thank you — this genuinely shapes what we build 🙌</p>
        ) : (
          <>
            <div className="flex items-start gap-3">
              <span className="grid h-10 w-10 flex-none place-items-center rounded-xl bg-flood/15 text-xl">💬</span>
              <div className="min-w-0 flex-1">
                <p className="font-mono text-[10px] uppercase tracking-wide text-ink-mute">A quick one from the founder</p>
                <p className="mt-0.5 text-sm font-bold leading-snug text-ink">{q.title}</p>
              </div>
              <button onClick={dismiss} disabled={busy} aria-label="Dismiss" className="-mr-1 -mt-1 rounded-lg px-2 py-1 text-ink-mute transition hover:bg-ink/5">
                ✕
              </button>
            </div>

            {phase === "ask" && q.options && (
              <div className="mt-3 flex flex-col gap-2">
                {q.options.map((o) => (
                  <button
                    key={o.value}
                    onClick={() => choose(o)}
                    disabled={busy}
                    className="rounded-xl border border-ink/10 bg-ink/[0.03] px-4 py-2.5 text-left text-sm font-semibold text-ink transition hover:border-flood hover:bg-flood/10 disabled:opacity-60"
                  >
                    {o.label}
                  </button>
                ))}
              </div>
            )}

            {(phase === "note" || (phase === "ask" && q.freeText)) && (
              <div className="mt-3">
                <textarea
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  rows={3}
                  maxLength={600}
                  placeholder={phase === "note" ? picked?.askNote : q.freeText}
                  className="w-full resize-none rounded-xl border border-ink/15 bg-white px-3.5 py-2.5 text-sm text-ink placeholder:text-ink-mute/70 focus:border-flood focus:outline-none"
                />
                <div className="mt-2 flex items-center gap-2">
                  <button
                    onClick={() => submitNote(false)}
                    disabled={busy || (q.freeText != null && !note.trim())}
                    className="flex-1 rounded-xl bg-flood px-4 py-2.5 text-sm font-bold text-ink transition hover:brightness-110 disabled:opacity-60"
                  >
                    {busy ? "Sending…" : "Send"}
                  </button>
                  {phase === "note" && (
                    <button onClick={() => submitNote(true)} disabled={busy} className="rounded-xl px-4 py-2.5 text-sm font-semibold text-ink-mute transition hover:bg-ink/5 disabled:opacity-60">
                      Skip
                    </button>
                  )}
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
