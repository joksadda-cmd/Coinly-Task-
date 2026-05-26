// api/checkMember.js
// Checks if a user is member of a specific channel/group

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');

    const { userId, channel } = req.query;

    if (!userId || !channel) {
        return res.status(400).json({ error: 'Missing userId or channel' });
    }

    const BOT_TOKEN = process.env.BOT_TOKEN;

    try {
        const response = await fetch(
            `https://api.telegram.org/bot${BOT_TOKEN}/getChatMember?chat_id=${channel}&user_id=${userId}`
        );
        const data = await response.json();

        if (!data.ok) {
            return res.json({ joined: false, error: data.description });
        }

        const status = data.result?.status;
        const joined = ['member', 'administrator', 'creator'].includes(status);

        return res.json({ joined, status });
    } catch(e) {
        return res.json({ joined: false, error: e.message });
    }
}
