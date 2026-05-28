// api/checkMember.js
// Checks if user is member of a specific channel/group (for task verification)

const BOT_TOKEN = process.env.BOT_TOKEN;

async function isMember(chatId, userId) {
    if (!chatId || !BOT_TOKEN) return false;
    try {
        const normalizedId = chatId.startsWith('@') ? chatId : chatId;
        const url  = `https://api.telegram.org/bot${BOT_TOKEN}/getChatMember?chat_id=${encodeURIComponent(normalizedId)}&user_id=${userId}`;
        const res  = await fetch(url);
        const data = await res.json();
        if (!data.ok) {
            console.warn('[checkMember] Telegram error:', data.description, 'chatId:', chatId);
            return false;
        }
        const status = data.result?.status;
        return ['member', 'administrator', 'creator'].includes(status);
    } catch(e) {
        console.error('[checkMember]', e.message);
        return false;
    }
}

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();

    const userId  = req.query?.userId || req.body?.userId;
    const channel = req.query?.channel || req.body?.channel;

    if (!userId || !channel) {
        return res.status(400).json({ ok: false, error: 'missing_params' });
    }

    try {
        const joined = await isMember(channel, userId);
        console.log(`[checkMember] userId=${userId} channel=${channel} joined=${joined}`);
        return res.status(200).json({ ok: true, joined, isMember: joined });
    } catch(err) {
        console.error('[checkMember]', err.message);
        return res.status(200).json({ ok: true, joined: false });
    }
}
