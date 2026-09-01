// Anthropic API spend for the admin analytics page.
//
// The Anthropic API has NO "remaining credit balance" endpoint — the Console shows it, the
// Admin API doesn't. So "credit left" here is computed: the owner records how much prepaid
// credit was loaded and since when, and we subtract the spend the Cost Admin API reports.
//
// Env (Vercel, server-only):
//   ANTHROPIC_ADMIN_KEY    — Admin API key (sk-ant-admin01-...), NOT the normal inference key
//   ANTHROPIC_CREDIT_USD   — total prepaid credit loaded since the baseline, e.g. "25"
//   ANTHROPIC_CREDIT_SINCE — baseline date the credit counting starts, e.g. "2026-08-01"
//
// Without ANTHROPIC_ADMIN_KEY the card is hidden entirely; without the credit vars we still
// show spend but can't show "remaining". Fetches are cached for an hour (Next data cache),
// well inside the API's 1-request/min polling allowance.

export type AnthropicCredit = {
  spentSinceUsd: number; // spend since the baseline date
  spent30dUsd: number; // spend over the last 30 days
  creditUsd: number | null;
  remainingUsd: number | null;
  since: string | null; // baseline date (YYYY-MM-DD) the credit math starts from
};

const COST_API = "https://api.anthropic.com/v1/organizations/cost_report";
const DAY_MS = 86_400_000;

// Sum the cost report (returned as decimal strings of USD cents) over one ≤31-day window.
async function fetchWindowCents(key: string, startISO: string, endISO: string): Promise<number> {
  let cents = 0;
  let page: string | undefined;
  do {
    const url = new URL(COST_API);
    url.searchParams.set("starting_at", startISO);
    url.searchParams.set("ending_at", endISO);
    url.searchParams.set("limit", "31");
    if (page) url.searchParams.set("page", page);
    const res = await fetch(url.toString(), {
      headers: { "anthropic-version": "2023-06-01", "x-api-key": key },
      next: { revalidate: 3600 },
    });
    if (!res.ok) throw new Error(`cost_report ${res.status} [${startISO} → ${endISO}]: ${(await res.text()).slice(0, 300)}`);
    const body = (await res.json()) as {
      data?: { results?: { amount?: string }[] }[];
      has_more?: boolean;
      next_page?: string;
    };
    for (const bucket of body.data ?? []) {
      for (const r of bucket.results ?? []) cents += parseFloat(r.amount ?? "0") || 0;
    }
    page = body.has_more && body.next_page ? body.next_page : undefined;
  } while (page);
  return cents;
}

// The cost endpoint caps a request at 31 daily buckets — walk longer ranges in 31-day steps.
async function fetchRangeUsd(key: string, from: Date, to: Date): Promise<number> {
  let cents = 0;
  for (let cursor = from.getTime(); cursor < to.getTime(); cursor += 31 * DAY_MS) {
    const end = Math.min(cursor + 31 * DAY_MS, to.getTime());
    cents += await fetchWindowCents(key, new Date(cursor).toISOString(), new Date(end).toISOString());
  }
  return cents / 100;
}

export async function getAnthropicCredit(): Promise<AnthropicCredit | null> {
  const key = process.env.ANTHROPIC_ADMIN_KEY;
  if (!key) {
    console.error("[anthropic-credit] ANTHROPIC_ADMIN_KEY not set in this runtime");
    return null;
  }
  try {
    // End every query at the START of the current UTC day, never "now": the API floors both
    // range ends to UTC days (intra-day spend is unqueryable regardless) and 400s any window
    // that floors to zero length. Ending at "now" made the 31-day walk emit exactly such a
    // window whenever the range crossed a step boundary into the current day — every 31st day
    // the whole card silently fell back to the env default (2026-09-01, Aug-1 baseline).
    const todayStart = Math.floor(Date.now() / DAY_MS) * DAY_MS;
    const end = new Date(todayStart);
    const since = process.env.ANTHROPIC_CREDIT_SINCE?.trim() || null;
    const credit = process.env.ANTHROPIC_CREDIT_USD ? parseFloat(process.env.ANTHROPIC_CREDIT_USD) : null;

    const start30d = new Date(todayStart - 30 * DAY_MS);
    let baseline = since ? new Date(`${since}T00:00:00Z`) : start30d;
    if (isNaN(baseline.getTime())) {
      console.error(`[anthropic-credit] unusable ANTHROPIC_CREDIT_SINCE ${JSON.stringify(since)} — counting spend from today`);
      baseline = new Date(todayStart);
    }

    // The cost API floors both range ends to UTC days — a range confined to today
    // collapses to zero days and 400s. Spend inside the current day isn't queryable;
    // count it as 0 until the day closes.
    const [spentSinceUsd, spent30dUsd] = await Promise.all([
      baseline.getTime() >= todayStart ? Promise.resolve(0) : fetchRangeUsd(key, baseline, end),
      fetchRangeUsd(key, start30d, end),
    ]);

    return {
      spentSinceUsd,
      spent30dUsd,
      creditUsd: credit,
      remainingUsd: credit != null && since ? Math.max(0, credit - spentSinceUsd) : null,
      since,
    };
  } catch (e) {
    // bad key / org without Admin API access / transient error — card just hides
    console.error("[anthropic-credit]", e instanceof Error ? e.message : e);
    return null;
  }
}
