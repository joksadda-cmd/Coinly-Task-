// api/checkJoin.js
// Checks if user joined required channel & group

const BOT_TOKEN  = process.env.BOT_TOKEN;
const CHANNEL_ID = process.env.CHANNEL_ID;
const GROUP_ID   = process.env.GROUP_ID;

async function isMember(chatId, userId) {
    if (!chatId || !BOT_TOKEN) return false;
    try {
        const url  = `https://api.telegram.org/bot${BOT_TOKEN}/getChatMember?chat_id=${encodeURIComponent(chatId)}&user_id=${userId}`;
        const res  = await fetch(url);
        const data = await res.json();
        if (!data.ok) return false;
        const status = data.result?.status;
        return ['member', 'administrator', 'creator'].includes(status);
    } catch(e) {
        console.error('[checkJoin]', e.message);
        return false;
    }
}

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();

    const userId = req.method === 'POST'
        ? (req.body?.userId || req.query?.userId)
        : req.query?.userId;

    if (!userId) return res.status(400).json({ ok: false, error: 'missing_userId' });

    try {
        const [inChannel, inGroup] = await Promise.all([
            isMember(CHANNEL_ID, userId),
            GROUP_ID ? isMember(GROUP_ID, userId) : Promise.resolve(true),
        ]);

        const joined = inChannel && inGroup;
        console.log(`[checkJoin] userId=${userId} channel=${inChannel} group=${inGroup}`);

        return res.status(200).json({ ok: true, joined, channel: inChannel, group: inGroup });
    } catch(err) {
        console.error('[checkJoin]', err.message);
        return res.status(200).json({ ok: true, joined: false });
    }
}
