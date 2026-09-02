// Admin analytics dashboard (staff-only). Pure display of the aggregate blob from admin_analytics().
// No interactivity → server component. A north-star hero strip up top, then four spacious sections:
// Users & growth, Revenue & plans, Agents & picks, Engagement & ops.

import type { AnthropicCredit } from "@/lib/anthropicCost";

type DaySeries = { day: string; n: number }[];

export type AdminStats = {
  users: { total: number; new_today: number; new_7d: number; new_30d: number; active_7d: number; active_by_day?: DaySeries; telegram_by_day?: DaySeries; telegram_linked: number };
  // may be absent while an older RPC is cached — render guards on it
  funnel?: { onboarded: number; with_bet: number; with_agent: number; push_enabled: number; onboarded_by_day?: DaySeries; first_bet_by_day?: DaySeries; first_agent_by_day?: DaySeries; push_by_day?: DaySeries };
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

// admin_llm_usage() — 30-day Claude token usage per (purpose, model), from llm_usage metering
export type LlmUsageRow = {
  purpose: string; model: string; calls: number;
  input_tokens: number; output_tokens: number; cache_read_tokens: number; cache_creation_tokens: number;
};

// admin_feedback() — founder-question answers: distribution per question + recent notes
export type FeedbackData = {
  summary: { prompt_key: string; answer: string; n: number }[];
  recent: { prompt_key: string; answer: string; note: string | null; answered_at: string; who: string }[];
};

// admin_daily_activity() — the three per-day activity counts (real users only)
export type DailyActivity = {
  uploads_daily: { day: string; n: number }[];
  deliveries_daily: { day: string; n: number }[];
  tickets_daily: { day: string; n: number }[];
};

// admin_recent_picks() — the last deliveries to real users, pick by pick
export type RecentPick = {
  at: string; who: string; agent: string; home: string; away: string;
  league: string; kickoff: string; market: string; prob: number | null;
  result: string; score: string | null;
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

export default function AdminAnalytics({ s, daily, picks, anthropic, llm, feedback }: { s: AdminStats; daily?: DailyActivity | null; picks?: RecentPick[] | null; anthropic?: AnthropicCredit | null; llm?: LlmUsageRow[] | null; feedback?: FeedbackData | null }) {
  const paid = s.revenue.pro + s.revenue.pro_max;
  const settled = s.agents.won + s.agents.lost;
  const hit = settled ? `${Math.round((s.agents.won / settled) * 100)}%` : "—";
  const edge = s.agents.avg_edge != null ? `${s.agents.avg_edge >= 0 ? "+" : ""}${(s.agents.avg_edge * 100).toFixed(1)}%` : "—";
  const maxSignup = Math.max(1, ...s.signups_daily.map((d) => d.n));
  const marketMax = Math.max(1, ...s.agents.top_markets.map((m) => m.n));

  // 7-day mini-bar series for the top cards. active_by_day is RPC-zero-filled, so it is the
  // canonical 7-day axis; signups slice onto it from the 30-day set. Total users bars show the
  // cumulative count at each day's close (total now minus signups after that day).
  const axis = s.users.active_by_day ?? [];
  const sigMap = new Map(s.signups_daily.map((x) => [x.day, x.n]));
  const newByDay = axis.length ? axis.map((a) => ({ day: a.day, n: sigMap.get(a.day) ?? 0 })) : undefined;
  let after = 0;
  const totalByDay = axis.length
    ? [...axis].reverse().map((a) => { const v = s.users.total - after; after += sigMap.get(a.day) ?? 0; return { day: a.day, n: v }; }).reverse()
    : undefined;
  const activeToday = axis.length ? axis[axis.length - 1].n : 0;

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
          <Kpi k="Total users" v={n(s.users.total)} d={`+${s.users.new_today} today`} days={totalByDay} />
          <Kpi k="New · 7 days" v={n(s.users.new_7d)} d={`${n(s.users.new_30d)} in 30d`} tone="up" days={newByDay} />
          <Kpi
            k="Active · 7 days"
            v={n(s.users.active_7d)}
            d={`${n(activeToday)} active today · ${pct(s.users.active_7d, s.users.total)} of users`}
            days={s.users.active_by_day}
          />
          <Kpi k="Telegram linked" v={n(s.users.telegram_linked)} d={`${pct(s.users.telegram_linked, s.users.total)} of users`} days={s.users.telegram_by_day} />
        </div>
        {/* the activation ladder the launch phase is driving — each step as share of all users.
            Bars = users clearing that step for the FIRST time, per day */}
        {s.funnel && (
          <div className="grid grid-cols-2 gap-3.5 md:grid-cols-4">
            <Kpi k="Onboarded" v={n(s.funnel.onboarded)} d={`${pct(s.funnel.onboarded, s.users.total)} of users`} days={s.funnel.onboarded_by_day} />
            <Kpi k="Tracked a bet" v={n(s.funnel.with_bet)} d={`${pct(s.funnel.with_bet, s.users.total)} · the activation bar`} tone="amber" days={s.funnel.first_bet_by_day} />
            <Kpi k="Built an agent" v={n(s.funnel.with_agent)} d={`${pct(s.funnel.with_agent, s.users.total)} of users`} tone="amber" days={s.funnel.first_agent_by_day} />
            <Kpi k="Push enabled" v={n(s.funnel.push_enabled)} d={`${pct(s.funnel.push_enabled, s.users.total)} reachable by push`} days={s.funnel.push_by_day} />
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
        {picks && picks.length > 0 && (
          <Panel title="Latest picks" sub="What agents actually delivered to real users — one batch per user · agent · day">
            <div className="mt-4 flex flex-col divide-y divide-ink/[0.06]">
              {groupPicks(picks).map((g, gi) => (
                <details key={gi} open={gi === 0} className="group py-1">
                  <summary className="flex cursor-pointer list-none items-center gap-2.5 py-2 [&::-webkit-details-marker]:hidden">
                    <span className="flex-none font-mono text-[10px] text-ink-mute transition-transform group-open:rotate-90">▶</span>
                    <span className="min-w-0 flex-1 truncate text-[13px] text-ink">
                      <b>{g.who}</b> <span className="text-ink-mute">·</span> {g.agent}
                      <span className="ml-2 font-mono text-[11px] text-ink-mute">{dayLabel(g.day)}</span>
                    </span>
                    {g.perfect && <span className="flex-none font-mono text-[11px]" title="Perfect day — every pick landed">🎯</span>}
                    <span className="flex-none font-mono text-[11px] text-ink-mute">
                      {g.rows.length} pick{g.rows.length > 1 ? "s" : ""} ·{" "}
                      <b className="text-grass-deep">{g.won}W</b>{g.lost > 0 && <> <b className="text-brick">{g.lost}L</b></>}{g.open > 0 && <> {g.open}P</>}
                    </span>
                  </summary>
                  <div className="flex flex-col divide-y divide-ink/[0.04] pb-2 pl-5">
                    {g.rows.map((p, i) => (
                      <div key={i} className="flex items-start gap-3 py-2">
                        <div className="min-w-0 flex-1">
                          <div className="flex items-baseline gap-2">
                            <span className="truncate text-[13px] font-bold text-ink">{p.home} <span className="font-normal text-ink-mute">v</span> {p.away}</span>
                            {p.score && <span className="flex-none font-mono text-[12px] font-bold text-ink">{p.score}</span>}
                          </div>
                          <div className="mt-0.5 truncate font-mono text-[11px] text-ink-mute">
                            {p.market}{p.prob != null ? ` · ${Math.round(p.prob * 100)}%` : ""} · {p.league}
                          </div>
                        </div>
                        <ResultBadge r={p.result} />
                      </div>
                    ))}
                  </div>
                </details>
              ))}
            </div>
          </Panel>
        )}
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

      {/* Daily activity — the three counts that ARE the product being used (real users only) */}
      {daily && (
        <Section label="Daily activity · last 30 days">
          <div className="grid gap-5 lg:grid-cols-3">
            <Panel title="Slip uploads" sub="Betslip screenshots read per day">
              {daily.uploads_daily.length ? (
                <DayBars data={daily.uploads_daily.map((d) => ({ label: dayLabel(d.day), value: d.n }))} max={Math.max(1, ...daily.uploads_daily.map((d) => d.n))} color="bg-flood-deep" />
              ) : <Empty>No slip uploads yet.</Empty>}
            </Panel>
            <Panel title="Predictions delivered" sub="Agent picks delivered per day">
              {daily.deliveries_daily.length ? (
                <DayBars data={daily.deliveries_daily.map((d) => ({ label: dayLabel(d.day), value: d.n }))} max={Math.max(1, ...daily.deliveries_daily.map((d) => d.n))} color="bg-flood" />
              ) : <Empty>No predictions delivered yet.</Empty>}
            </Panel>
            <Panel title="Games on tracker" sub="Bets tracked per day">
              {daily.tickets_daily.length ? (
                <DayBars data={daily.tickets_daily.map((d) => ({ label: dayLabel(d.day), value: d.n }))} max={Math.max(1, ...daily.tickets_daily.map((d) => d.n))} color="bg-grass-deep" />
              ) : <Empty>No tracked games yet.</Empty>}
            </Panel>
          </div>
        </Section>
      )}

      {/* Engagement & ops */}
      <Section label="Engagement & ops">
        <div className="grid grid-cols-2 gap-3.5 md:grid-cols-3">
          <Kpi k="Tracked bets" v={n(s.engagement.tickets)} d={`${n(s.engagement.tickets_7d)} this week`} />
          <Kpi k="Accumulators" v={n(s.engagement.accumulators)} d={`${n(s.engagement.slip_uploads)} slip uploads`} />
          <Kpi k="Community" v={n(s.engagement.posts)} d={`${n(s.engagement.comments)} comments · ${n(s.engagement.reactions)} likes`} />
          <Kpi k="Leaderboard opt-ins" v={n(s.engagement.leaderboard_opt_ins)} d={`${s.engagement.open_reports} open reports`} tone={s.engagement.open_reports > 0 ? "down" : undefined} />
          <Kpi k="Channel posts" v={n(s.engagement.channel_posts)} d={`${s.engagement.channel_posted} posted · ${s.engagement.channel_failed} failed`} tone={s.engagement.channel_failed > 0 ? "down" : undefined} />
          <Kpi k="API today" v={n(s.engagement.api_today)} d="of 75,000" tone={s.engagement.api_today > 60000 ? "down" : undefined} />
          {anthropic && <AnthropicKpi a={anthropic} />}
        </div>
        {llm && llm.length > 0 && <LlmBreakdown rows={llm} />}
      </Section>

      {/* Founder questions — what real users say when asked one question at the right moment */}
      {feedback && (feedback.summary.length > 0 || feedback.recent.length > 0) && (
        <Section label="What users are telling us">
          <FeedbackPanel f={feedback} />
        </Section>
      )}
    </>
  );
}

// Human labels for the founder-question keys and answer values (kept in sync with
// FounderQuestion.tsx — the card owns the copy, this owns the reading view).
const FB_Q: Record<string, string> = {
  agent_staked: "Did you stake your agent's picks this week?",
  losing_pain: "A pick lost — how did that land?",
  tracking_value: "Has tracking your bets helped?",
  pmf: "If Onside disappeared tomorrow…",
  agent_quality: "Is your agent picking games you'd bet?",
  improve: "Change ONE thing about Onside",
};
const FB_A: Record<string, string> = {
  most: "Staked most", some: "One or two", watching: "Just watching",
  fine: "Part of betting", annoying: "Annoying but fine", trust_hit: "Trust it less",
  yes: "Yes", a_bit: "A bit", no: "Not really",
  very: "Very disappointed", somewhat: "Somewhat", not: "Not bothered",
  sometimes: "Sometimes", free_text: "(wrote in)", "(dismissed)": "Dismissed",
};
function FeedbackPanel({ f }: { f: FeedbackData }) {
  const byQ = new Map<string, { answer: string; n: number }[]>();
  for (const row of f.summary) {
    if (row.answer === "(dismissed)") continue; // dismissals aren't opinions
    const list = byQ.get(row.prompt_key) ?? [];
    list.push({ answer: row.answer, n: row.n });
    byQ.set(row.prompt_key, list);
  }
  const notes = f.recent.filter((r) => r.note);
  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <Panel title="Answers" sub="Distribution per question (dismissals excluded)">
        {byQ.size ? (
          <div className="mt-4 flex flex-col gap-4">
            {[...byQ.entries()].map(([k, answers]) => {
              const total = Math.max(1, answers.reduce((a, b) => a + b.n, 0));
              return (
                <div key={k}>
                  <div className="text-[13px] font-bold text-ink">{FB_Q[k] ?? k}</div>
                  <div className="mt-1.5 flex flex-col gap-1">
                    {answers.map((a) => (
                      <div key={a.answer} className="flex items-center gap-3 text-[12.5px]">
                        <span className="w-32 flex-none truncate font-mono text-ink-mute">{FB_A[a.answer] ?? a.answer}</span>
                        <div className="h-2 flex-1 rounded-full bg-ink/[0.08]">
                          <div className="h-full rounded-full bg-flood-deep" style={{ width: `${(a.n / total) * 100}%` }} />
                        </div>
                        <span className="w-6 flex-none text-right font-mono font-bold text-ink">{a.n}</span>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        ) : <Empty>No answers yet — questions started going out today.</Empty>}
      </Panel>
      <Panel title="In their words" sub="The follow-up notes — read every one">
        {notes.length ? (
          <div className="mt-4 flex flex-col divide-y divide-ink/[0.06]">
            {notes.map((r, i) => (
              <div key={i} className="py-2.5">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="truncate text-[12.5px] font-bold text-ink">{r.who}</span>
                  <span className="flex-none font-mono text-[10.5px] text-ink-mute">{FB_Q[r.prompt_key] ?? r.prompt_key} · {FB_A[r.answer] ?? r.answer}</span>
                </div>
                <p className="mt-1 text-[13px] leading-relaxed text-ink">&ldquo;{r.note}&rdquo;</p>
              </div>
            ))}
          </div>
        ) : <Empty>No written feedback yet.</Empty>}
      </Panel>
    </div>
  );
}

// Anthropic API credit — remaining = credit loaded (env) − spend from the Cost Admin API.
// There is no balance endpoint, so this is an estimate; reconcile against the Console when topping up.
const usd = (x: number) => `$${x >= 1000 ? `${(x / 1000).toFixed(1)}k` : x.toFixed(2)}`;
function AnthropicKpi({ a }: { a: AnthropicCredit }) {
  if (a.remainingUsd != null && a.creditUsd != null) {
    const low = a.remainingUsd < Math.max(5, a.creditUsd * 0.2);
    return (
      <Kpi
        k="Anthropic credit"
        v={usd(a.remainingUsd)}
        d={`of ${usd(a.creditUsd)} since ${a.since} · ${usd(a.spent30dUsd)} in 30d`}
        tone={low ? "down" : "up"}
      />
    );
  }
  // spend-only mode: admin key set but credit total/baseline not configured
  return <Kpi k="Anthropic spend · 30d" v={usd(a.spent30dUsd)} d="set ANTHROPIC_CREDIT_USD + _SINCE to track credit left" />;
}

// Where the Anthropic credit goes — llm_usage rows priced per model (USD per MTok; cache
// read bills at 0.1x input, cache write at 1.25x). Attribution, not billing-grade accounting.
const LLM_PRICE: { prefix: string; in: number; out: number }[] = [
  { prefix: "claude-haiku-4-5", in: 1, out: 5 },
  { prefix: "claude-sonnet-5", in: 3, out: 15 },
  { prefix: "claude-opus", in: 5, out: 25 },
];
const LLM_LABEL: Record<string, string> = {
  slip_upload: "Slip uploads (screenshot reading)",
  social_post: "Social media posts",
  agent_rules: "Agent rule parsing",
};
function llmCostUsd(r: LlmUsageRow): number {
  const p = LLM_PRICE.find((x) => r.model.startsWith(x.prefix)) ?? { in: 3, out: 15 };
  return (r.input_tokens * p.in + r.cache_read_tokens * p.in * 0.1 + r.cache_creation_tokens * p.in * 1.25 + r.output_tokens * p.out) / 1_000_000;
}
function LlmBreakdown({ rows }: { rows: LlmUsageRow[] }) {
  const byPurpose = new Map<string, { usd: number; calls: number }>();
  for (const r of rows) {
    const e = byPurpose.get(r.purpose) ?? { usd: 0, calls: 0 };
    e.usd += llmCostUsd(r); e.calls += r.calls;
    byPurpose.set(r.purpose, e);
  }
  const items = [...byPurpose.entries()].sort((a, b) => b[1].usd - a[1].usd);
  const total = Math.max(1e-9, items.reduce((a, [, v]) => a + v.usd, 0));
  const fmt = (x: number) => (x >= 0.01 ? `$${x.toFixed(2)}` : `<$0.01`);
  return (
    <Panel title="Where the Anthropic credit goes" sub="Claude usage by feature · last 30 days (metered since 1 Sep)">
      <div className="mt-5 flex flex-col gap-3">
        {items.map(([purpose, v]) => (
          <div key={purpose} className="flex items-center gap-3 text-[13px]">
            <span className="w-56 flex-none truncate text-ink">{LLM_LABEL[purpose] ?? purpose}</span>
            <div className="h-2.5 flex-1 rounded-full bg-ink/[0.08]">
              <div className="h-full rounded-full bg-flood-deep" style={{ width: `${(v.usd / total) * 100}%` }} />
            </div>
            <span className="w-24 flex-none text-right font-mono text-[12px] text-ink-mute">{n(v.calls)} calls</span>
            <span className="w-16 flex-none text-right font-mono font-bold text-ink">{fmt(v.usd)}</span>
          </div>
        ))}
      </div>
    </Panel>
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

// KPI card, optionally with a 7-day mini bar row (oldest → today, today highlighted) so every
// card in a grid row shares the same height and shows its own daily rhythm.
function Kpi({ k, v, d, tone, days }: { k: string; v: string; d: string; tone?: "up" | "down" | "amber"; days?: DaySeries }) {
  const vc = tone === "up" ? "text-grass-deep" : tone === "down" ? "text-brick" : tone === "amber" ? "text-flood-deep" : "text-ink";
  const max = days?.length ? Math.max(1, ...days.map((x) => x.n)) : 1;
  return (
    <div className="rounded-2xl bg-chalk p-4 text-ink shadow-xl md:p-5">
      <div className="font-mono text-[10.5px] uppercase tracking-wide text-ink-mute">{k}</div>
      <div className={`mt-1.5 font-disp text-[24px] font-extrabold leading-none tracking-tight md:text-[28px] ${vc}`}>{v}</div>
      {days && days.length > 0 && (
        <div className="mt-2 flex h-6 items-end gap-1">
          {days.map((x, i) => (
            <div
              key={x.day}
              title={`${dayLabel(x.day)}: ${n(x.n)}`}
              className={`flex-1 rounded-t ${i === days.length - 1 ? "bg-flood-deep" : "bg-ink/25"}`}
              style={{ height: `${Math.max(12, (x.n / max) * 100)}%` }}
            />
          ))}
        </div>
      )}
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

// batch the flat pick list into (user, agent, day) delivery groups, newest day first;
// 🎯 marks a perfect day — the same 3+/all-won bar the congratulation email uses
type PickGroup = { who: string; agent: string; day: string; rows: RecentPick[]; won: number; lost: number; open: number; perfect: boolean };
function groupPicks(picks: RecentPick[]): PickGroup[] {
  const byKey = new Map<string, PickGroup>();
  for (const p of picks) {
    const day = p.at.slice(0, 10);
    const key = `${p.who}|${p.agent}|${day}`;
    let g = byKey.get(key);
    if (!g) { g = { who: p.who, agent: p.agent, day, rows: [], won: 0, lost: 0, open: 0, perfect: false }; byKey.set(key, g); }
    g.rows.push(p);
    if (p.result === "won") g.won++;
    else if (p.result === "lost") g.lost++;
    else if (p.result !== "void") g.open++;
  }
  const groups = [...byKey.values()];
  for (const g of groups) g.perfect = g.rows.length >= 3 && g.won === g.rows.length;
  return groups; // picks arrive newest-first, so insertion order already is too
}

// settlement outcome chip for the pick-detail rows (result colours, not confidence dots)
function ResultBadge({ r }: { r: string }) {
  const tone =
    r === "won" ? "bg-grass/15 text-grass-deep" :
    r === "lost" ? "bg-brick/15 text-brick" :
    r === "void" ? "bg-ink/[0.08] text-ink-mute" :
    "bg-flood/15 text-flood-deep";
  return <span className={`mt-0.5 flex-none rounded-full px-2.5 py-1 font-mono text-[10.5px] font-bold uppercase tracking-wide ${tone}`}>{r}</span>;
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
