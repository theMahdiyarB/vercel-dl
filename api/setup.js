// api/setup.js
// One-time setup: registers the Telegram webhook
// Visit: https://your-domain.vercel.app/api/setup?secret=YOUR_SETUP_SECRET

export default async function handler(req, res) {
  const { secret } = req.query;

  if (secret !== process.env.SETUP_SECRET) {
    return res.status(403).json({ error: "Forbidden. Provide ?secret=YOUR_SETUP_SECRET" });
  }

  const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
  if (!BOT_TOKEN) return res.status(500).json({ error: "TELEGRAM_BOT_TOKEN not set" });

  const host = req.headers.host;
  const webhookUrl = `https://${host}/api/telegram`;

  const setRes = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/setWebhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      url: webhookUrl,
      allowed_updates: ["message", "callback_query"],
      drop_pending_updates: true,
    }),
  });
  const setData = await setRes.json();

  const infoRes = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getWebhookInfo`);
  const infoData = await infoRes.json();

  const botRes = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getMe`);
  const botData = await botRes.json();

  return res.status(200).json({ setup: setData, webhookInfo: infoData.result, bot: botData.result, webhookUrl });
}
