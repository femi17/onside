import { createBrowserClient } from "@supabase/ssr";

// Browser-side Supabase client (uses the publishable key, sb_publishable_…; RLS enforces access).
export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!
  );
}
