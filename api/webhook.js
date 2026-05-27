// api/webhook.js
// Telegram bot — handles /start command

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(200).json({ ok: true });

  const TOKEN = process.env.BOT_TOKEN;
  const body  = req.body || {};
  const msg   = body.message;

  if (!msg?.chat?.id) return res.status(200).json({ ok: true });

  const chatId   = String(msg.chat.id);
  const text     = msg.text || '';
  const user     = msg.from;

  if (text.startsWith('/start')) {
    const parts       = text.split(' ');
    const referrer    = parts[1] && parts[1] !== chatId ? parts[1] : null;
    const webAppUrl   = 'https://coinly-task.vercel.app';
    const referLink   = `https://t.me/Coinlytix_bot/TaskEarn?startapp=${chatId}`;
    const shareText   = 'Join Coinly Task! Earn 💎 Diamond by completing tasks 🚀';

    // Send welcome message
    await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id:    chatId,
        text:       `⚡ *Welcome to Coinly Task!*\n\n💎 Earn Diamond by completing tasks\n🎁 New user bonus: *+5 💎 Diamond*\n👥 Refer friends & earn *+5 💎* each`,
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: '🚀 Open Coinly Task', web_app: { url: webAppUrl } }],
            [{ text: '🎁 Share & Earn', url: `https://t.me/share/url?url=${encodeURIComponent(referLink)}&text=${encodeURIComponent(shareText)}` }],
            [
              { text: '📢 Channel',   url: 'https://t.me/coinly_task' },
              { text: '👥 Community', url: 'https://t.me/newTon_Gc'   }
            ]
          ]
        }
      })
    });

    // Init user via our own API (non-blocking)
    fetch(`https://coinly-task.vercel.app/api/init`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userId:       chatId,
        firstName:    user?.first_name || 'User',
        username:     user?.username   || 'N/A',
        referrerCode: referrer
      })
    }).catch(() => {});
  }

  return res.status(200).json({ ok: true });
}
