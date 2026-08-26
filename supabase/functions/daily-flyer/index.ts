// daily-flyer: the morning ritual — DM the owner a share-ready flyer pack rendered fresh from
// yesterday's settlement data. The images are Vercel next/og routes (/flyer/results); Telegram
// fetches the URL itself via sendPhoto, so no bytes pass through here. The owner forwards to
// WhatsApp status / posts as an IG reel — 30 seconds of ritual, zero stale numbers possible.
import { createClient } from "npm:@supabase/supabase-js@2";

const SB_KEY = Deno.env.get("SUPABASE_SECRET_KEY") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const sb = createClient(Deno.env.get("SUPABASE_URL")!, SB_KEY);
const SITE = "https://onside.com.ng";
const OWNER_EMAIL = "tyewoduola@gmail.com";

Deno.serve(async (_req) => {
  const { data: token } = await sb.rpc("get_secret", { secret_name: "telegram_bot_token" });
  if (!token) return Response.json({ error: "no telegram token" }, { status: 500 });

  // the owner's DM chat — profiles.telegram_chat_id via the admin listUsers-free path
  const { data: owner } = await sb
    .from("profiles").select("telegram_chat_id, id")
    .not("telegram_chat_id", "is", null);
  let chatId: number | null = null;
  for (const p of owner ?? []) {
    const { data: u } = await sb.auth.admin.getUserById(p.id as string);
    if (u?.user?.email === OWNER_EMAIL) { chatId = Number(p.telegram_chat_id); break; }
  }
  if (!chatId) return Response.json({ error: "owner has no telegram link" }, { status: 500 });

  // yesterday's headline for the caption (same source the flyer renders from)
  let head = "";
  try {
    const { data: rec } = await sb.rpc("public_record");
    const d = (rec as { days?: { won: number; graded: number }[] })?.days?.[0];
    if (d) head = `${d.won}W ${d.graded - d.won}L (${Math.round((d.won / Math.max(1, d.graded)) * 100)}%)`;
  } catch { /* caption stays generic */ }

  const bust = new Date().toISOString().slice(0, 10);
  const sent: string[] = [];
  for (const [name, size] of [["story", "story"], ["feed", "feed"]] as const) {
    const resp = await fetch(`https://api.telegram.org/bot${token}/sendPhoto`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        photo: `${SITE}/flyer/results?size=${size}&d=${bust}`,
        caption: name === "story"
          ? `🗞 Daily flyer pack — yesterday${head ? `: ${head}` : ""}.\nStory size (WhatsApp status / IG story / reel). Feed size follows.`
          : "Feed size (IG post / X).",
      }),
    });
    const j = await resp.json();
    sent.push(`${name}:${j?.ok === true ? "ok" : JSON.stringify(j?.description ?? j)}`);
  }
  return Response.json({ sent });
});
