// api/checkJoin.js
// Checks if user joined BOTH official channels

const REQUIRED_CHANNELS = [
  '@coinly_task',
  '@newTon_Gc',
];

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const { userId } = req.query;
  if (!userId) return res.status(400).json({ ok: false, error: 'userId required' });

  const BOT_TOKEN = process.env.BOT_TOKEN;

  try {
    const results = {};

    for (const ch of REQUIRED_CHANNELS) {
      const r = await fetch(
        `https://api.telegram.org/bot${BOT_TOKEN}/getChatMember?chat_id=${ch}&user_id=${userId}`
      );
      const data = await r.json();
      const status = data?.result?.status;
      results[ch] = ['member', 'administrator', 'creator'].includes(status);
    }

    const channel  = results['@coinly_task'];
    const group    = results['@newTon_Gc'];
    const allJoined = channel && group;

    return res.status(200).json({ ok: allJoined, channel, group });

  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
}
