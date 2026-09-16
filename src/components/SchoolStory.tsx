// The pitch for Onside School (non-members). Leads with the hook; the record's headline numbers —
// Won / Lost / ROI — sit on the right of the same card as the proof that carries the sell.
export default function SchoolStory({
  wins,
  losses,
  roi,
  days,
}: {
  wins: number;
  losses: number;
  roi: number;
  days: number;
}) {
  const stats = [
    { label: "Won", value: String(wins), tone: "text-grass" },
    { label: "Lost", value: String(losses), tone: "text-brick" },
    { label: "ROI", value: `${roi >= 0 ? "+" : "−"}${Math.abs(roi)}%`, tone: roi >= 0 ? "text-grass" : "text-brick" },
  ];

  return (
    <section className="rounded-2xl border border-white/10 bg-pitch-2 p-6 md:p-8">
      <div className="md:flex md:items-stretch md:gap-8">
        <div className="md:flex-1">
          <p className="font-mono text-[10.5px] uppercase tracking-[0.25em] text-flood">Onside School</p>
          <h2 className="mt-2 font-disp text-3xl font-extrabold leading-[1.05] tracking-tight text-chalk sm:text-4xl">
            Tired of losing?
            <br /> Join Onside School.
          </h2>

          <div className="mt-4 space-y-3 text-[15px] leading-relaxed text-onpitch">
            <p>
              Every day the founder shares one insight — the single bet he trusts most. One slip, flat stakes,
              posted here whether it lands or not. No twenty-leg lottery tickets. No quietly deleting the losers.
            </p>
            <p>
              Just <span className="font-semibold text-chalk">the founder&apos;s insight</span>, and a record you can
              scroll all the way back.
            </p>
          </div>

          <p className="mt-4 font-mono text-[10.5px] text-onpitch-mute">
            Members get today&apos;s pick before kickoff. Everyone sees the receipts. 18+ · bet responsibly.
          </p>
        </div>

        {days > 0 && (
          <div className="mt-6 grid grid-cols-3 gap-3 border-t border-white/10 pt-5 md:mt-0 md:w-[184px] md:flex-none md:grid-cols-1 md:content-center md:gap-4 md:border-l md:border-t-0 md:pl-8 md:pt-0">
            {stats.map((s) => (
              <div key={s.label} className="text-center md:text-left">
                <div className={`font-disp text-3xl font-extrabold tabular-nums sm:text-4xl ${s.tone}`}>{s.value}</div>
                <div className="mt-0.5 font-mono text-[10.5px] uppercase tracking-wide text-onpitch-mute">{s.label}</div>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
