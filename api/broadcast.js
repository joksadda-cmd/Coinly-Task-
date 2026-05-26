// api/broadcast.js
// Admin broadcast to all users via Telegram

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'POST only' });
  }

  if (req.headers['x-admin-secret'] !== process.env.ADMIN_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { message, parseMode, buttonText, buttonUrl } = req.body;
  if (!message?.trim()) return res.status(400).json({ error: 'message required' });

  const BOT_TOKEN    = process.env.BOT_TOKEN;
  const FIREBASE_URL = `https://coinly-task-default-rtdb.firebaseio.com`;

  try {
    // Get all users from Firebase
    const snap = await fetch(`${FIREBASE_URL}/users.json?shallow=true`);
    const data = await snap.json();
    const userIds = data ? Object.keys(data) : [];

    let sent = 0, failed = 0;

    const inlineBtn = buttonText && buttonUrl
      ? { inline_keyboard: [[{ text: buttonText, url: buttonUrl }]] }
      : null;

    for (let i = 0; i < userIds.length; i++) {
      const body = {
        chat_id: userIds[i],
        text: message,
        parse_mode: parseMode || 'HTML',
        disable_web_page_preview: true,
      };
      if (inlineBtn) body.reply_markup = inlineBtn;

      try {
        const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        });
        if (r.ok) sent++; else failed++;
      } catch { failed++; }

      // Rate limit: 25 msgs/sec
      if ((i + 1) % 25 === 0) await new Promise(r => setTimeout(r, 1100));
    }

    return res.status(200).json({ ok: true, total: userIds.length, sent, failed });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
