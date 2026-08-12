import { redirect, notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import StickyHeader from "@/components/StickyHeader";
import MobileLogo from "@/components/MobileLogo";
import ModerationQueue, { type QueueItem } from "@/components/ModerationQueue";

// Moderation queue — staff-only. Gated on profiles.is_admin here and again inside the
// admin_moderation_queue / admin_moderate RPCs (defence in depth). Non-admins get a 404, not a redirect.
export default async function ModerationPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: prof } = await supabase.from("profiles").select("is_admin").eq("id", user.id).maybeSingle();
  if (!prof?.is_admin) notFound();

  const { data } = await supabase.rpc("admin_moderation_queue");
  const items = (data ?? []) as QueueItem[];

  return (
    <div className="pb-24">
      <StickyHeader>
        <div className="mx-auto max-w-3xl px-5 pb-3 pt-6 md:px-8">
          <MobileLogo />
          <p className="font-mono text-[11px] uppercase tracking-[0.25em] text-flood">Staff · moderation</p>
          <h1 className="mt-2 font-disp text-3xl font-bold tracking-tight text-chalk sm:text-4xl">Reported content.</h1>
        </div>
      </StickyHeader>

      <div className="mx-auto max-w-3xl px-5 pt-2 md:px-8">
        <p className="mb-4 font-mono text-[12px] leading-relaxed text-onpitch-mute">
          Posts and comments with open reports. Content auto-hides at 3 reports; review each and{" "}
          <span className="text-chalk">restore</span> (approve), <span className="text-chalk">hide</span>,{" "}
          <span className="text-chalk">dismiss</span> (keep, clear reports) or <span className="text-brick">delete</span>.
        </p>
        <ModerationQueue initialItems={items} />
      </div>
    </div>
  );
}
