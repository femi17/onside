import { redirect } from "next/navigation";

// The builder now lives under /strategies (a strategy *is* an agent). Keep this path
// working for old links by redirecting.
export default function LegacyNewAgentPage() {
  redirect("/strategies/new");
}
