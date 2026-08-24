// Admin analytics dashboard (staff-only). Pure display of the aggregate blob from admin_analytics().
// No interactivity → server component. A north-star hero strip up top, then four spacious sections:
// Users & growth, Revenue & plans, Agents & picks, Engagement & ops.

export type AdminStats = {
  users: { total: number; new_today: number; new_7d: number; new_30d: number; active_7d: number; telegram_linked: number };
  // may be absent while an older RPC is cached — render guards on it
  funnel?: { onboarded: number; with_bet: number; with_agent: number; push_enabled: number };
  revenue: { free: number; pro: number; pro_max: number; active_subs: number; mrr_naira: number; collected_naira: number };
  agents: {
    total: number; running: number; learning: number; new_7d: number;
    deliveries: number; won: number; lost: number; void: number; pending: number;
    avg_edge: number | null; top_markets: { market: string; n: number }[];
  };
  engagement: {
    tickets: number; tickets_7d: number; accumulators: number; slip_uploads: number;
    posts: number; comments: number; reactions: number; leaderboard_opt_ins: number;
    open_reports: number; channel_posts: number; channel_posted: number; channel_failed: number; api_today: number;
  };
  signups_daily: { day: string; n: number }[];
  agents_daily?: { day: string; n: number }[];
  revenue_weekly: { w: string; amount: number; cum: number }[];
  agents_weekly: { w: string; n: number; cum: number }[];
  deliveries_weekly: { w: string; n: number }[];
};

const wkLabel = (iso: string) => new Date(iso).toLocaleDateString("en-GB", { day: "2-digit", month: "short" });
const dayLabel = (iso: string) => new Date(iso).toLocaleDateString("en-GB", { day: "2-digit", month: "short" });

const n = (x: number) => x.toLocaleString();
const pct = (num: number, den: number) => (den ? `${Math.round((num / den) * 100)}%` : "—");
// compact naira for hero/axis labels (₦1.2m, ₦48k) so big figures don't wrap
const naira = (x: number) => {
  if (x >= 1_000_000) return `₦${(x / 1_000_000).toFixed(x >= 10_000_000 ? 0 : 1)}m`;
  if (x >= 10_000) return `₦${Math.round(x / 1000)}k`;
  return `₦${n(x)}`;
};

export default function AdminAnalytics({ s }: { s: AdminStats }) {
  const paid = s.revenue.pro + s.revenue.pro_max;
  const settled = s.agents.won + s.agents.lost;
  const hit = settled ? `${Math.round((s.agents.won / settled) * 100)}%` : "—";
  const edge = s.agents.avg_edge != null ? `${s.agents.avg_edge >= 0 ? "+" : ""}${(s.agents.avg_edge * 100).toFixed(1)}%` : "—";
  const maxSignup = Math.max(1, ...s.signups_daily.map((d) => d.n));
  const marketMax = Math.max(1, ...s.agents.top_markets.map((m) => m.n));

  const mix = [
    { label: "Won", v: s.agents.won, c: "bg-grass" },
    { label: "Lost", v: s.agents.lost, c: "bg-brick" },
    { label: "Void", v: s.agents.void, c: "bg-ink/30" },
    { label: "Pending", v: s.agents.pending, c: "bg-flood" },
  ];
  const mixTotal = Math.max(1, mix.reduce((a, b) => a + b.v, 0));

  return (
    <>
      {/* Hero — the north-star numbers, larger and set apart */}
      <div className="mt-4 grid grid-cols-2 gap-3.5 md:grid-cols-3 lg:grid-cols-5">
        <Hero k="Total users" v={n(s.users.total)} d={`+${s.users.new_today} today · +${n(s.users.new_7d)} this week`} />
        <Hero k="Paid users" v={n(paid)} d={`${s.revenue.pro} Pro · ${s.revenue.pro_max} Max`} tone="up" />
        <Hero k="Collected to date" v={naira(s.revenue.collected_naira)} d={`₦${n(s.revenue.mrr_naira)} est. MRR`} tone="up" />
        <Hero k="Agents deployed" v={n(s.agents.total)} d={`${s.agents.running} running · ${s.agents.learning} learning`} />
        <Hero k="Hit rate" v={hit} d={`${n(settled)} settled · edge ${edge}`} tone="amber" />
      </div>

      {/* Users & growth */}
      <Section label="Users & growth">
        <div className="grid grid-cols-2 gap-3.5 md:grid-cols-4">
          <Kpi k="Total users" v={n(s.users.total)} d={`+${s.users.new_today} today`} />
          <Kpi k="New · 7 days" v={n(s.users.new_7d)} d={`${n(s.users.new_30d)} in 30d`} tone="up" />
          <Kpi k="Active · 7 days" v={n(s.users.active_7d)} d={`${pct(s.users.active_7d, s.users.total)} of users`} />
          <Kpi k="Telegram linked" v={n(s.users.telegram_linked)} d={`${pct(s.users.telegram_linked, s.users.total)} of users`} />
        </div>
        {/* the activation ladder the launch phase is driving — each step as share of all users */}
        {s.funnel && (
          <div className="grid grid-cols-2 gap-3.5 md:grid-cols-4">
            <Kpi k="Onboarded" v={n(s.funnel.onboarded)} d={`${pct(s.funnel.onboarded, s.users.total)} of users`} />
            <Kpi k="Placed a bet" v={n(s.funnel.with_bet)} d={`${pct(s.funnel.with_bet, s.users.total)} · the activation bar`} tone="amber" />
            <Kpi k="Built an agent" v={n(s.funnel.with_agent)} d={`${pct(s.funnel.with_agent, s.users.total)} of users`} tone="amber" />
            <Kpi k="Push enabled" v={n(s.funnel.push_enabled)} d={`${pct(s.funnel.push_enabled, s.users.total)} reachable by push`} />
          </div>
        )}
        <Panel title="Signups · last 30 days" sub="New accounts per day">
          {s.signups_daily.length ? (
            <DayBars data={s.signups_daily.map((d) => ({ label: dayLabel(d.day), value: d.n }))} max={maxSignup} color="bg-flood-deep" />
          ) : <Empty>No signups in the last 30 days.</Empty>}
        </Panel>
      </Section>

      {/* Revenue & plans */}
      <Section label="Revenue & plans">
        <div className="grid grid-cols-2 gap-3.5 md:grid-cols-4">
          <Kpi k="Paid users" v={n(paid)} d={`${s.revenue.pro}/${s.revenue.pro_max} · ${n(s.revenue.free)} free`} tone="up" />
          <Kpi k="Collected to date" v={`₦${n(s.revenue.collected_naira)}`} d="all recorded payments" tone="up" />
          <Kpi k="Est. MRR" v={`₦${n(s.revenue.mrr_naira)}`} d={`${pct(paid, s.users.total)} conversion`} tone="up" />
          <Kpi k="Active subs" v={n(s.revenue.active_subs)} d={`${paid - s.revenue.active_subs} non-recurring`} />
        </div>
        <Panel title="Revenue collected" sub="Cumulative, from actual recorded payments (₦)">
          {s.revenue_weekly.length ? (
            <TrendBars data={s.revenue_weekly.map((r) => ({ label: wkLabel(r.w), value: r.cum }))} color="bg-grass-deep" fmt={naira} fmtFull={(v) => `₦${n(v)}`} />
          ) : <Empty>No payments recorded yet.</Empty>}
        </Panel>
      </Section>

      {/* Agents & picks */}
      <Section label="Agents & picks">
        <div className="grid grid-cols-2 gap-3.5 md:grid-cols-4">
          <Kpi k="Agents deployed" v={n(s.agents.total)} d={`${s.agents.running} running · ${s.agents.learning} learning`} />
          <Kpi k="New agents · 7d" v={n(s.agents.new_7d)} d="deployed this week" tone="up" />
          <Kpi k="Picks delivered" v={n(s.agents.deliveries)} d={`${n(settled)} settled`} />
          <Kpi k="Hit rate" v={hit} d={`avg edge ${edge}`} tone="amber" />
        </div>
        <div className="grid gap-5 lg:grid-cols-2">
          <Panel title="Settlement mix" sub="Where delivered picks ended up">
            <div className="mt-5 flex h-3.5 overflow-hidden rounded-full bg-ink/[0.06]">
              {mix.map((m) => (
                <div key={m.label} className={m.c} style={{ width: `${(m.v / mixTotal) * 100}%` }} title={`${m.label}: ${m.v}`} />
              ))}
            </div>
            <div className="mt-4 grid grid-cols-2 gap-x-4 gap-y-2.5 font-mono text-[12px] text-ink-mute">
              {mix.map((m) => (
                <span key={m.label} className="flex items-center gap-2">
                  <i className={`h-2.5 w-2.5 flex-none rounded-[3px] ${m.c}`} />
                  <span className="text-ink">{m.label}</span>
                  <span className="ml-auto font-bold text-ink">{n(m.v)}</span>
                  <span className="w-9 text-right">{pct(m.v, mixTotal)}</span>
                </span>
              ))}
            </div>
          </Panel>
          <Panel title="Top markets" sub="Most-delivered pick types">
            {s.agents.top_markets.length ? (
              <div className="mt-5 flex flex-col gap-3">
                {s.agents.top_markets.map((m) => (
                  <div key={m.market} className="flex items-center gap-3 text-[13px]">
                    <span className="w-36 flex-none truncate font-mono text-ink">{m.market}</span>
                    <div className="h-2.5 flex-1 rounded-full bg-ink/[0.08]">
                      <div className="h-full rounded-full bg-flood-deep" style={{ width: `${(m.n / marketMax) * 100}%` }} />
                    </div>
                    <span className="w-9 flex-none text-right font-mono font-bold text-ink">{n(m.n)}</span>
                  </div>
                ))}
              </div>
            ) : <Empty>No picks delivered yet.</Empty>}
          </Panel>
        </div>
        {s.agents_daily && (
          <Panel title="Agents created · last 30 days" sub="New agents per day — the builder's daily pulse">
            {s.agents_daily.length ? (
              <DayBars
                data={s.agents_daily.map((d) => ({ label: dayLabel(d.day), value: d.n }))}
                max={Math.max(1, ...s.agents_daily.map((d) => d.n))}
                color="bg-grass-deep"
              />
            ) : <Empty>No agents created in the last 30 days.</Empty>}
          </Panel>
        )}
        <div className="grid gap-5 lg:grid-cols-2">
          <Panel title="Agents deployed" sub="Cumulative, by week">
            {s.agents_weekly.length ? (
              <TrendBars data={s.agents_weekly.map((a) => ({ label: wkLabel(a.w), value: a.cum }))} />
            ) : <Empty>No agents yet.</Empty>}
          </Panel>
          <Panel title="Picks delivered" sub="Per week">
            {s.deliveries_weekly.length ? (
              <TrendBars data={s.deliveries_weekly.map((d) => ({ label: wkLabel(d.w), value: d.n }))} color="bg-flood" />
            ) : <Empty>No picks yet.</Empty>}
          </Panel>
        </div>
      </Section>

      {/* Engagement & ops */}
      <Section label="Engagement & ops">
        <div className="grid grid-cols-2 gap-3.5 md:grid-cols-3">
          <Kpi k="Tracked bets" v={n(s.engagement.tickets)} d={`${n(s.engagement.tickets_7d)} this week`} />
          <Kpi k="Accumulators" v={n(s.engagement.accumulators)} d={`${n(s.engagement.slip_uploads)} slip uploads`} />
          <Kpi k="Community" v={n(s.engagement.posts)} d={`${n(s.engagement.comments)} comments · ${n(s.engagement.reactions)} likes`} />
          <Kpi k="Leaderboard opt-ins" v={n(s.engagement.leaderboard_opt_ins)} d={`${s.engagement.open_reports} open reports`} tone={s.engagement.open_reports > 0 ? "down" : undefined} />
          <Kpi k="Channel posts" v={n(s.engagement.channel_posts)} d={`${s.engagement.channel_posted} posted · ${s.engagement.channel_failed} failed`} tone={s.engagement.channel_failed > 0 ? "down" : undefined} />
          <Kpi k="API today" v={n(s.engagement.api_today)} d="of 75,000" tone={s.engagement.api_today > 60000 ? "down" : undefined} />
        </div>
      </Section>
    </>
  );
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mt-12 first:mt-10">
      <div className="mb-5 flex items-center gap-3">
        <span className="h-4 w-1 flex-none rounded-full bg-flood" />
        <span className="font-mono text-[11px] font-bold uppercase tracking-[0.18em] text-onpitch-mute">{label}</span>
        <div className="h-px flex-1 bg-white/10" />
      </div>
      <div className="flex flex-col gap-5">{children}</div>
    </div>
  );
}

// Hero KPI — larger north-star figure, brand-tinted surface so it reads above the section cards.
function Hero({ k, v, d, tone }: { k: string; v: string; d: string; tone?: "up" | "amber" }) {
  const vc = tone === "up" ? "text-grass-deep" : tone === "amber" ? "text-flood-deep" : "text-ink";
  return (
    <div className="rounded-2xl bg-chalk-2 p-5 text-ink shadow-xl ring-1 ring-inset ring-ink/[0.04]">
      <div className="font-mono text-[10.5px] uppercase tracking-[0.12em] text-ink-mute">{k}</div>
      <div className={`mt-2 font-disp text-[30px] font-extrabold leading-none tracking-tight md:text-[34px] ${vc}`}>{v}</div>
      <div className="mt-2.5 font-mono text-[11px] leading-relaxed text-ink-mute">{d}</div>
    </div>
  );
}

function Kpi({ k, v, d, tone }: { k: string; v: string; d: string; tone?: "up" | "down" | "amber" }) {
  const vc = tone === "up" ? "text-grass-deep" : tone === "down" ? "text-brick" : tone === "amber" ? "text-flood-deep" : "text-ink";
  return (
    <div className="rounded-2xl bg-chalk p-4 text-ink shadow-xl md:p-5">
      <div className="font-mono text-[10.5px] uppercase tracking-wide text-ink-mute">{k}</div>
      <div className={`mt-1.5 font-disp text-[24px] font-extrabold leading-none tracking-tight md:text-[28px] ${vc}`}>{v}</div>
      <div className="mt-1.5 font-mono text-[11px] text-ink-mute">{d}</div>
    </div>
  );
}

function Panel({ title, sub, children }: { title: string; sub: string; children: React.ReactNode }) {
  return (
    <div className="rounded-2xl bg-chalk p-5 text-ink shadow-xl md:p-6">
      <div className="font-disp text-base font-bold text-ink">{title}</div>
      <div className="mt-0.5 font-mono text-[11px] text-ink-mute">{sub}</div>
      {children}
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="mt-6 font-mono text-[12px] text-ink-mute">{children}</p>;
}

// Shared chart frame: a taller plot with light gridlines and a max-value marker on the y-axis.
function ChartFrame({ max, fmtMax, children }: { max: number; fmtMax: string; children: React.ReactNode }) {
  return (
    <div className="mt-5">
      <div className="relative h-[180px]">
        {/* horizontal gridlines at 0 / 50 / 100% of max */}
        <div className="pointer-events-none absolute inset-0">
          <div className="absolute inset-x-0 top-0 border-t border-dashed border-ink/[0.08]" />
          <div className="absolute inset-x-0 top-1/2 border-t border-dashed border-ink/[0.08]" />
          <div className="absolute inset-x-0 bottom-0 border-t border-ink/15" />
        </div>
        {/* y-axis max label, top-left */}
        <span className="absolute -top-1 left-0 z-10 font-mono text-[9.5px] text-ink-mute">{fmtMax}</span>
        {children}
      </div>
    </div>
  );
}

// Daily bars (30-day signups) — sparse labels so a phone isn't crowded; every bar keeps a hover title.
function DayBars({ data, max, color = "bg-flood-deep" }: { data: { label: string; value: number }[]; max: number; color?: string }) {
  const step = Math.max(1, Math.ceil(data.length / 6)); // ~6 x-axis labels
  return (
    <>
      <ChartFrame max={max} fmtMax={n(max)}>
        <div className="flex h-full items-end gap-[3px] px-px">
          {data.map((d, i) => (
            <div key={i} className="group relative flex h-full flex-1 items-end" title={`${d.label}: ${n(d.value)}`}>
              <div className={`w-full rounded-t ${color}`} style={{ height: `${Math.max(3, (d.value / max) * 100)}%` }} />
            </div>
          ))}
        </div>
      </ChartFrame>
      <div className="mt-2 flex px-px">
        {data.map((d, i) => (
          <span key={i} className="flex-1 text-center font-mono text-[9px] text-ink-mute">
            {i % step === 0 ? d.label : ""}
          </span>
        ))}
      </div>
    </>
  );
}

// Weekly trend bars — taller plot, gridlines, y-axis max, and readable per-bar week labels.
function TrendBars({
  data, color = "bg-flood-deep", fmt, fmtFull,
}: { data: { label: string; value: number }[]; color?: string; fmt?: (v: number) => string; fmtFull?: (v: number) => string }) {
  const max = Math.max(1, ...data.map((d) => d.value));
  const fmtMax = fmt ? fmt(max) : n(max);
  const title = (v: number) => (fmtFull ?? fmt ?? n)(v);
  return (
    <>
      <ChartFrame max={max} fmtMax={fmtMax}>
        <div className="flex h-full items-end gap-1.5 px-px">
          {data.map((d, i) => (
            <div key={i} className="flex h-full flex-1 items-end" title={`${d.label}: ${title(d.value)}`}>
              <div className={`w-full rounded-t ${color}`} style={{ height: `${Math.max(3, (d.value / max) * 100)}%` }} />
            </div>
          ))}
        </div>
      </ChartFrame>
      <div className="mt-2 flex gap-1.5 px-px">
        {data.map((d, i) => (
          <span key={i} className="flex-1 truncate text-center font-mono text-[9.5px] text-ink-mute">{d.label}</span>
        ))}
      </div>
    </>
  );
}
