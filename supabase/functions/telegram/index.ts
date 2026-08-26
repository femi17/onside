// Onside Telegram webhook. Telegram POSTs updates here. Auth = the secret_token we registered with
// setWebhook (sent back in X-Telegram-Bot-Api-Secret-Token). Handles account linking via a deep-link
// code: the app shows t.me/OnsideAIbot?start=<code>; on /start <code> we match profiles.telegram_link_code
// and bind that user's telegram_chat_id. Picks themselves are sent by run-strategies at delivery time.
import { createClient } from "npm:@supabase/supabase-js@2";

const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
async function getSecret(name: string): Promise<string | null> {
  const { data } = await sb.rpc("get_secret", { secret_name: name });
  return (data as string) ?? null;
}
async function tg(method: string, body: unknown): Promise<any> {
  const token = await getSecret("telegram_bot_token");
  if (!token) return null;
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    return await res.json();
  } catch { return null; /* non-fatal */ }
}

// The first thing a freshly-linked user reads — and it stays PINNED in the chat so the
// channel + how-to survive under the daily pick deliveries that follow.
const WELCOME = `✅ Connected! Your agent's picks now land here at delivery time.

📌 Save this — how to get the most from Onside:

1️⃣ Follow the channel → t.me/onsideai
Daily slate in the morning, one sharp lesson in the afternoon, honest results at night — misses included.

2️⃣ Upload any betslip screenshot in the app
Every leg tracks itself live and settles exactly how the bookie settles.

3️⃣ Make it feel like an app
Open onside.com.ng → browser menu → "Add to Home Screen", then Profile → Notifications for goal alerts and verdicts.

4️⃣ Our record is public → onside.com.ng/record

18+ · Bet responsibly · Not financial advice`;

Deno.serve(async (req) => {
  const want = await getSecret("telegram_webhook_secret");
  const got = req.headers.get("x-telegram-bot-api-secret-token");
  if (!want || got !== want) return new Response("forbidden", { status: 403 });

  const update = await req.json().catch(() => null);
  const msg = update?.message ?? update?.edited_message;
  const chatId = msg?.chat?.id;
  const text = String(msg?.text ?? "").trim();
  if (!chatId) return new Response("ok");

  if (text.startsWith("/start")) {
    const code = text.slice(6).trim();
    if (code) {
      const { data: prof } = await sb.from("profiles").select("id").eq("telegram_link_code", code).limit(1).maybeSingle();
      if (prof) {
        await sb.from("profiles").update({ telegram_chat_id: chatId, telegram_linked_at: new Date().toISOString(), telegram_link_code: null }).eq("id", prof.id);
        const sent = await tg("sendMessage", { chat_id: chatId, text: WELCOME, disable_web_page_preview: true });
        const mid = sent?.result?.message_id;
        if (mid) await tg("pinChatMessage", { chat_id: chatId, message_id: mid, disable_notification: true });
      } else {
        await tg("sendMessage", { chat_id: chatId, text: "That link expired. In Onside, open Profile and tap Connect Telegram again." });
      }
    } else {
      await tg("sendMessage", { chat_id: chatId, text: "Welcome to Onside. To link your account, open the app, go to Profile, and tap Connect Telegram." });
    }
  } else {
    await tg("sendMessage", { chat_id: chatId, text: "Your Onside agent picks are delivered here automatically. Manage your agents in the app." });
  }
  return new Response("ok");
});
