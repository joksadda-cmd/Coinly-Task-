// api/webhook.js
// Telegram bot webhook — handles /start with referral

export default async function handler(req, res) {
  const TOKEN = process.env.BOT_TOKEN;

  if (req.method !== "POST") {
    return res.status(200).json({ ok: true });
  }

  const body = req.body || {};
  const chatId = body.message?.chat?.id;
  const text   = body.message?.text;
  const user   = body.message?.from;

  if (!chatId) return res.status(200).json({ ok: true });

  if (text && text.startsWith("/start")) {
    const parts    = text.split(" ");
    const referrer = parts[1] && parts[1] !== String(chatId) ? parts[1] : null;

    try {
      // Save user to new Firebase (coinly-task) via REST
      const FIREBASE_URL = `https://coinly-task-default-rtdb.firebaseio.com`;

      const userRes  = await fetch(`${FIREBASE_URL}/users/${chatId}.json`);
      const userData = await userRes.json();

      if (!userData) {
        // New user — save to Firebase
        await fetch(`${FIREBASE_URL}/users/${chatId}.json`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id:    chatId,
            username:   user?.username || "N/A",
            firstName:  user?.first_name || "",
            referrer:   referrer,
            joinedAt:   Date.now(),
            diamondBalance: 0,
            completedTasks: [],
            isBanned:   false,
            joinGiftClaimed: false
          })
        });

        // Save referral record
        if (referrer) {
          await fetch(`${FIREBASE_URL}/referrals/${referrer}/${chatId}.json`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ joinedAt: Date.now(), valid: false })
          });
        }
      }

      // Mini App URL
      const webAppUrl = "https://ton-bot-11.vercel.app";
      const referLink = `https://t.me/Coinlytix_bot/coinlyTon?startapp=${chatId}`;
      const shareText = "Join Coinly Task! Earn 💎 Diamond by completing tasks 🚀";

      // Send welcome message
      await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text: `⚡ *Welcome to Coinly Task!*\n\nEarn 💎 Diamond by completing tasks.\nRefer friends & earn more!\n\n🎁 New user bonus: *+5 💎 Diamond*`,
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [
              [{ text: "🚀 Open Coinly Task", web_app: { url: webAppUrl } }],
              [{ text: "🎁 Share & Earn", url: `https://t.me/share/url?url=${encodeURIComponent(referLink)}&text=${encodeURIComponent(shareText)}` }],
              [
                { text: "📢 Channel", url: "https://t.me/coinly_task" },
                { text: "👥 Community", url: "https://t.me/newTon_Gc" }
              ]
            ]
          }
        })
      });

    } catch (error) {
      console.error("Webhook error:", error);
    }
  }

  return res.status(200).json({ ok: true });
}
