"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import ConnectTelegram from "@/components/ConnectTelegram";
import StickyHeader from "@/components/StickyHeader";
import { PLAN_PRICING, isPaidPlan } from "@/lib/plans";
import { pixelTrack } from "@/lib/metaPixel";

// 3-step first-run setup: choose a plan -> connect Telegram (optional) -> build first agent.
// New sign-ups land here (profiles.onboarded=false); leaving via any exit marks them onboarded.
const PLANS = [
  {
    key: "free", name: "Free", price: "₦0",
    feats: ["5 leagues for your AI agent", "Track all your bets", "1 accumulator / day", "1 agent · hunts every day (locked once built)", "Agent picks up to 8 games", "3 slips of history"],
  },
  {
    key: "pro", name: "Pro", price: "₦500/mo",
    feats: ["15 leagues for your AI agent", "Track all your bets", "3 accumulators / day", "Up to 3 agents · tune & retire anytime", "Up to 15 games per pick", "10 slips of history"],
  },
  {
    key: "pro_max", name: "Pro Max", price: "₦1,000/mo",
    feats: ["All 300+ leagues for your AI agent", "Track all your bets", "10 accumulators / day", "Up to 7 agents · unlimited runs", "Up to 24 games per pick", "Learning agents", "Unlimited history"],
  },
];

export default function OnboardingPage() {
  const router = useRouter();
  const supabase = createClient();
  const [uid, setUid] = useState<string | null>(null);
  const [plan, setPlan] = useState("free");
  const [linked, setLinked] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) { router.replace("/login"); return; }
      setUid(user.id);
      const { data: p } = await supabase.from("profiles").select("plan, telegram_linked_at, onboarded").eq("id", user.id).maybeSingle();
      if (p?.plan) setPlan(p.plan);
      setLinked(!!p?.telegram_linked_at);
      setLoading(false);
      // Meta ads conversion: every new account (email or Google) lands here exactly once
      // with onboarded=false — that makes this the registration signal for BOTH auth
      // flows. The localStorage flag stops a re-render/revisit double-firing it.
      if (p?.onboarded === false && !localStorage.getItem("onside_px_reg")) {
        localStorage.setItem("onside_px_reg", "1");
        pixelTrack("CompleteRegistration");
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function choosePlan(k: string) {
    // selection is local only — a new account is already on free, and paid plans are granted
    // exclusively by the server after checkout (a DB trigger blocks any client plan change)
    setPlan(k);
  }
  async function leave(path: string) {
    if (uid) await supabase.from("profiles").update({ onboarded: true }).eq("id", uid);
    router.push(path);
    router.refresh();
  }

  const steps = [true, linked, false]; // plan always "done", telegram when linked, agent pending

  return (
    <div className="mx-auto w-full max-w-2xl flex-1 px-5 pb-24 pt-2 md:px-8">
      {/* transparent at rest, fills in only when scrolled — like the rest of the app */}
      <StickyHeader className="-mx-5 mb-6 flex items-center justify-between px-5 py-4 md:-mx-8 md:px-8">
        <Link href="/" className="flex items-center gap-3">
          <span className="glyph" />
          <span className="font-disp text-xl font-extrabold tracking-tight text-chalk">
            ON<span className="text-flood">SIDE</span>
          </span>
        </Link>
        <button onClick={() => leave("/tracker")} className="text-[13px] text-onpitch-mute hover:text-chalk">
          Skip for now &rarr;
        </button>
      </StickyHeader>

      <div className="mb-6 flex gap-2">
        {steps.map((on, i) => (
          <span key={i} className={`h-[5px] flex-1 rounded-full ${on ? "bg-flood" : "bg-white/12"}`} />
        ))}
      </div>

      {/* Step 1 - plan */}
      <section className="mb-4 rounded-2xl bg-chalk p-6 text-ink shadow-xl">
        <p className="font-mono text-[11px] font-bold uppercase tracking-[0.18em] text-flood-deep">Step 1 &middot; Choose a plan</p>
        <h2 className="mt-2 font-disp text-[23px] font-bold tracking-tight">Start where it makes sense.</h2>
        <p className="mt-1.5 text-[14px] text-ink-mute">You can change this anytime. Free covers tracking and one daily-hunting agent — locked as built.</p>
        <div className="mt-4 grid grid-cols-1 gap-2.5 sm:grid-cols-3">
          {PLANS.map((pl) => (
            <button
              key={pl.key}
              onClick={() => choosePlan(pl.key)}
              disabled={loading}
              className={`rounded-xl border p-4 text-left transition ${plan === pl.key ? "border-flood-deep bg-flood/10 shadow-[inset_0_0_0_1px_var(--flood-deep)]" : "border-ink/15 bg-white hover:border-ink/30"}`}
            >
              <div className="font-disp text-[17px] font-extrabold">{pl.name}</div>
              <div className="mt-1 font-mono text-[12px] text-flood-deep">{pl.price}</div>
              <ul className="mt-2 flex flex-col gap-1.5">
                {pl.feats.map((f) => (
                  <li key={f} className="flex gap-1.5 text-[12px] text-ink-mute"><span className="font-bold text-flood-deep">&middot;</span>{f}</li>
                ))}
              </ul>
            </button>
          ))}
        </div>
      </section>

      {/* Step 2 - telegram */}
      <section className="mb-4 rounded-2xl bg-chalk p-6 text-ink shadow-xl">
        <p className="font-mono text-[11px] font-bold uppercase tracking-[0.18em] text-flood-deep">Step 2 &middot; Get your games anywhere</p>
        <h2 className="mt-2 font-disp text-[23px] font-bold tracking-tight">Connect Telegram.</h2>
        <p className="mt-1.5 text-[14px] text-ink-mute">Your picks arrive in-app and &mdash; if you want &mdash; as a private DM from @OnsideAIbot. One tap links your account; you can leave it off.</p>
        {/* ConnectTelegram flips itself to a "connected" state once you tap Start in the bot */}
        <ConnectTelegram linked={linked} onLinked={() => setLinked(true)} />
      </section>

      {/* Step 3 - upload accumulator (the natural first action for a new user) */}
      <section className="mb-6 rounded-2xl bg-chalk p-6 text-ink shadow-xl">
        <p className="font-mono text-[11px] font-bold uppercase tracking-[0.18em] text-flood-deep">Step 3 &middot; Upload your accumulator</p>
        <h2 className="mt-2 font-disp text-[23px] font-bold tracking-tight">Bring your slip in.</h2>
        <p className="mt-1.5 text-[14px] text-ink-mute">Snap or upload your betslip and Onside reads every leg, then tracks them live through to settlement. You can build an agent anytime after.</p>
      </section>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <button onClick={() => leave("/tracker")} className="text-[13px] text-onpitch-mute hover:text-chalk">&larr; Do this later</button>
        {isPaidPlan(plan) ? (
          // paid plans go to Paystack checkout — the final step before the account is activated
          <button
            onClick={() => router.push(`/checkout?plan=${plan}`)}
            className="flex-1 rounded-xl bg-flood px-5 py-3 font-bold text-ink transition-transform hover:-translate-y-0.5 sm:flex-none"
          >
            Continue to checkout &middot; &#8358;{PLAN_PRICING[plan].naira.toLocaleString()}/mo &rarr;
          </button>
        ) : (
          <button
            onClick={() => leave("/add")}
            className="flex-1 rounded-xl bg-flood px-5 py-3 font-bold text-ink transition-transform hover:-translate-y-0.5 sm:flex-none"
          >
            Upload your accumulator &rarr;
          </button>
        )}
      </div>
    </div>
  );
}
