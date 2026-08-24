import Link from "next/link";
import Footer from "@/components/Footer";

export default function Landing() {
  return (
    <>
      <div className="mx-auto flex w-full max-w-6xl flex-1 flex-col px-6">
      {/* top bar */}
      <header className="flex items-center justify-between py-5">
        <div className="flex items-center gap-3">
          <span className="glyph" />
          <span className="font-disp text-xl font-extrabold tracking-tight text-chalk">
            ON<span className="text-flood">SIDE</span>
          </span>
        </div>
        <nav className="flex items-center gap-6 text-sm font-semibold text-onpitch-mute">
          <Link href="/login" className="hover:text-chalk">
            Sign in
          </Link>
          <Link
            href="/login"
            className="rounded-xl bg-flood px-4 py-2.5 font-bold text-ink"
          >
            Open app
          </Link>
        </nav>
      </header>

      {/* hero */}
      <section className="grid flex-1 items-center gap-10 py-8 md:grid-cols-2">
        <div>
          <p className="font-mono text-[11px] uppercase tracking-[0.25em] text-flood">
            Your bets. Nothing else on the screen.
          </p>
          <h1 className="mt-4 font-disp text-5xl font-extrabold leading-[0.98] tracking-tight text-chalk md:text-6xl">
            Track only the <span className="text-flood">bet you made.</span>
          </h1>
          <p className="mt-5 max-w-md text-lg leading-relaxed text-onpitch-mute">
            Forecasting is a headache. Score apps drown you in noise. Onside cuts
            both — it tracks only the markets you bet, and gives you an AI agent
            that runs your strategy across your leagues and delivers just the
            games that fit.
          </p>
          <div className="mt-7 flex flex-wrap gap-3">
            <Link
              href="/login"
              className="rounded-xl bg-flood px-5 py-3.5 font-bold text-ink"
            >
              Start free
            </Link>
            <Link
              href="/how-it-works"
              className="rounded-xl border border-white/15 px-5 py-3.5 font-bold text-chalk"
            >
              See the app
            </Link>
          </div>
          <p className="mt-4 font-mono text-xs text-onpitch-mute">
            Free forever for tracking · your AI agent hunts every day
          </p>
        </div>

        {/* floating betslip — perforated ticket edge + angled brand tag, matching the design system */}
        <div className="relative">
          <div className="betslip betslip-chalk relative rounded-2xl bg-chalk p-5 text-ink shadow-2xl">
            {/* angled brand tag (the design-reference badge) */}
            <span className="absolute -right-3 -top-4 z-10 rotate-[4deg] rounded-[10px] bg-flood px-3 py-2 font-mono text-[10.5px] font-bold text-ink shadow-xl">
              Onside · track better
            </span>
            <div className="flex justify-between font-mono text-[10px] uppercase tracking-wide text-ink-mute">
              <span>Premier League</span>
              <span className="font-bold text-flood-deep">● 63&apos;</span>
            </div>
            <div className="mt-3 font-disp text-2xl font-bold">
              Arsenal <span className="text-base text-ink-mute">v</span> Chelsea
            </div>
            <div className="font-mono text-[11px] font-bold uppercase tracking-wide text-flood-deep">
              Over 8.5 corners
            </div>
            <div className="mt-2 font-mono text-5xl font-bold tracking-tight">
              8<span className="text-xl text-ink-mute"> / 8.5</span>
            </div>
            <div className="mt-3 border-t border-dashed border-ink/15 pt-3 font-mono text-[11px] text-ink-mute">
              Momentum · Chelsea pressing
              <div className="mt-2 h-6 overflow-hidden rounded-lg bg-ink/5">
                <div className="h-full w-[64%] border-r-2 border-flood-deep bg-flood/20" />
              </div>
            </div>
          </div>
        </div>
      </section>
      </div>
      <Footer />
    </>
  );
}
