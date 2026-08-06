// Paid-plan pricing, shared by the checkout UI and the server-side payment verification.
// Paystack works in the smallest currency unit (kobo), so amounts are stored there too.
export type PaidPlan = "pro" | "pro_max";

export const PLAN_PRICING: Record<PaidPlan, { label: string; naira: number; kobo: number; perks: string[] }> = {
  pro: {
    label: "Pro",
    naira: 500,
    kobo: 50000,
    perks: [
      "50 leagues for your AI agent",
      "3 accumulators / day",
      "Up to 3 agents · unlimited runs",
      "Up to 24 games per pick",
      "10 slips of history",
    ],
  },
  pro_max: {
    label: "Pro Max",
    naira: 1000,
    kobo: 100000,
    perks: [
      "All 300+ leagues for your AI agent",
      "10 accumulators / day",
      "Up to 7 agents · unlimited runs",
      "Up to 50 games per pick",
      "Learning agents",
      "Unlimited history",
    ],
  },
};

export function isPaidPlan(p: string | null | undefined): p is PaidPlan {
  return p === "pro" || p === "pro_max";
}
