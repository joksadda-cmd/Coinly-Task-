// api/checkMember.js
// Checks if user is member of a specific channel/group (for task verification)

const BOT_TOKEN = process.env.BOT_TOKEN;

async function isMember(chatId, userId) {
    if (!chatId || !BOT_TOKEN) {
        console.warn('[checkMember] Missing chatId or BOT_TOKEN');
        return false;
    }
    try {
        // Ensure @ prefix for username-based IDs
        let normalizedId = chatId.trim();
        if (!normalizedId.startsWith('@') && !normalizedId.startsWith('-')) {
            normalizedId = '@' + normalizedId;
        }

        const url  = `https://api.telegram.org/bot${BOT_TOKEN}/getChatMember?chat_id=${encodeURIComponent(normalizedId)}&user_id=${userId}`;
        const res  = await fetch(url);
        const data = await res.json();

        if (!data.ok) {
            console.warn('[checkMember] Telegram API error:', data.description, '| chatId:', normalizedId, '| userId:', userId);
            // Common errors:
            // "Bad Request: chat not found" — wrong username
            // "Bad Request: user not found" — user never started bot
            // "Forbidden: bot is not a member" — bot not in channel
            return false;
        }

        const status = data.result?.status;
        console.log(`[checkMember] userId=${userId} chatId=${normalizedId} status=${status}`);
        return ['member', 'administrator', 'creator'].includes(status);

    } catch(e) {
        console.error('[checkMember] fetch error:', e.message);
        return false;
    }
}

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();

    const userId  = req.query?.userId  || req.body?.userId;
    const channel = req.query?.channel || req.body?.channel;

    if (!userId || !channel) {
        return res.status(400).json({ ok: false, isMember: false, error: 'missing_params' });
    }

    try {
        const memberResult = await isMember(channel, userId);
        console.log(`[checkMember] RESULT userId=${userId} channel=${channel} isMember=${memberResult}`);

        // IMPORTANT: never return ok:true with isMember:false in a way that frontend misreads
        return res.status(200).json({
            ok: true,
            isMember: memberResult,
            joined:   memberResult   // alias for compatibility
        });

    } catch(err) {
        console.error('[checkMember] handler error:', err.message);
        // On error — return false, do NOT let user pass
        return res.status(200).json({ ok: true, isMember: false, joined: false });
    }
}
