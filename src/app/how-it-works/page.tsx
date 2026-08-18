import type { Metadata } from "next";
import Link from "next/link";
import Image from "next/image";
import Footer from "@/components/Footer";
import BackButton from "@/components/BackButton";

// The golden-path walkthrough, built from REAL screenshots of the app (a seeded demo account,
// captured by scripts/capture-guide.mjs at a mobile viewport). Re-run the script after UI
// changes and the page stays honest. Public: doubles as onboarding and the marketing explainer.
export const metadata: Metadata = {
  title: "How Onside works — upload your slip, track everything live",
  description:
    "Upload a screenshot of your bet slip and Onside reads every leg, tracks the games live, and settles them like the bookie. Then let AI agents run your strategies.",
};

const STEPS: { img: string; kicker: string; title: string; body: string }[] = [
  {
    img: "/guide/step-1-upload.png",
    kicker: "Step 1 · The magic trick",
    title: "Upload your slip — a screenshot is enough.",
    body: "Snap your bookie slip (SportyBet, Bet9ja, 1xBet, any of them) and upload it. Onside reads every leg — teams, markets, lines, even 20+ fold accas — and matches each game to the real fixture. No typing, no manual entry.",
  },
  {
    img: "/guide/step-2-tracker.png",
    kicker: "Step 2 · Watch it live",
    title: "Every leg tracks itself, like the bookie does.",
    body: "Each bet follows its own game: live scores, corners counted for corner bets, first-half bets settled at half-time, whole-number lines pushed correctly. A traffic light on every bet shows how it's doing right now.",
  },
  {
    img: "/guide/step-3-agents.png",
    kicker: "Step 3 · Put an agent on it",
    title: "Your strategy, running every day without you.",
    body: "Tell an agent what you'd bet — \"Over 2.5 when both teams blend 3+ goals a game\" — in plain English. It scans your leagues daily, prices every game against the bookies, and only delivers picks that pass the model, the history checks, and your own rule.",
  },
  {
    img: "/guide/step-4-accas.png",
    kicker: "Step 4 · Slips that live",
    title: "Accas with a pulse — and a rebet button.",
    body: "Your accumulators show every leg's live state, the stake and the potential. A slip cuts? One tap rebets the games still standing as a fresh slip. A slip lands? Share the anonymous card to the group chat.",
  },
  {
    img: "/guide/step-5-performance.png",
    kicker: "Step 5 · Receipts",
    title: "Everything is graded — and studied.",
    body: "Every pick is timestamped before kickoff and settled honestly, win or lose. The performance page shows what's actually landing, and the engine mines the results weekly to suggest new rules it can prove — with the evidence attached.",
  },
];

export default function HowItWorksPage() {
  return (
    <>
    <main className="min-h-screen bg-pitch px-5 pb-20 pt-10">
      <div className="mx-auto max-w-2xl">
        <div className="mb-8 flex items-center justify-between gap-3">
          <Link href="/" className="flex items-center gap-2">
            <span className="glyph" />
            <span className="font-disp text-xl font-extrabold tracking-tight text-chalk">
              ON<span className="text-flood">SIDE</span>
            </span>
          </Link>
          <BackButton />
        </div>

        <p className="font-mono text-[11px] uppercase tracking-[0.25em] text-flood">How it works</p>
        <h1 className="mt-2 font-disp text-3xl font-bold tracking-tight text-chalk sm:text-4xl">
          From slip screenshot to settled — automatically.
        </h1>
        <p className="mt-3 max-w-[52ch] text-[15px] leading-relaxed text-onpitch-mute">
          Five steps, no manual entry. This is the real app — these screenshots regenerate straight from it.
        </p>

        <div className="mt-10 flex flex-col gap-12">
          {STEPS.map((s) => (
            <section key={s.img} className="grid gap-5 sm:grid-cols-[240px_1fr] sm:items-center">
              <div className="mx-auto w-full max-w-[240px] overflow-hidden rounded-2xl border border-white/10 shadow-2xl">
                {/* iPhone-13 viewport shots: 390x844 logical, captured @2x */}
                <Image src={s.img} alt={s.title} width={780} height={1688} className="h-auto w-full" />
              </div>
              <div>
                <p className="font-mono text-[11px] font-bold uppercase tracking-[0.2em] text-flood">{s.kicker}</p>
                <h2 className="mt-1.5 font-disp text-xl font-extrabold text-chalk">{s.title}</h2>
                <p className="mt-2 text-[14px] leading-relaxed text-onpitch-mute">{s.body}</p>
              </div>
            </section>
          ))}
        </div>

        <div className="mt-14 rounded-2xl border border-white/10 bg-pitch-2 p-6 text-center">
          <p className="font-disp text-xl font-extrabold text-chalk">Your next slip deserves this.</p>
          <p className="mx-auto mt-1.5 max-w-[42ch] text-[13.5px] leading-relaxed text-onpitch-mute">
            Free to start — upload a slip and watch it come alive. Naira pricing when you want more.
          </p>
          <Link href="/login" className="mt-4 inline-block rounded-xl bg-flood px-6 py-3 font-bold text-ink transition-transform hover:-translate-y-0.5">
            Start free
          </Link>
        </div>
      </div>
    </main>
    <Footer />
    </>
  );
}
