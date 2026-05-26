// api/processWithdraw.js
// Admin: approve or reject withdrawal requests

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  if (req.headers['x-admin-secret'] !== process.env.ADMIN_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { withdrawalId, action, txHash } = req.body;
  if (!withdrawalId || !action) return res.status(400).json({ error: 'withdrawalId and action required' });

  const BOT_TOKEN    = process.env.BOT_TOKEN;
  const FIREBASE_URL = `https://coinly-task-default-rtdb.firebaseio.com`;

  try {
    const wRes  = await fetch(`${FIREBASE_URL}/withdrawals/${withdrawalId}.json`);
    const w     = await wRes.json();

    if (!w) return res.status(404).json({ error: 'Not found' });
    if (w.status !== 'pending') return res.status(400).json({ error: `Already ${w.status}` });

    if (action === 'approve') {
      await fetch(`${FIREBASE_URL}/withdrawals/${withdrawalId}.json`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'approved', txHash: txHash || 'manual', approvedAt: Date.now() })
      });

      await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: w.userId,
          text: `✅ Withdrawal approved!\n💎 ${w.diamondAmount} Diamond → ${w.tonAmount?.toFixed(4)} TON\nMethod: ${w.method}`
        })
      });

    } else if (action === 'reject') {
      // Refund
      const uRes  = await fetch(`${FIREBASE_URL}/users/${w.userId}.json`);
      const uData = await uRes.json();
      const cur   = parseFloat(uData?.diamondBalance || 0);

      await fetch(`${FIREBASE_URL}/users/${w.userId}.json`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ diamondBalance: cur + w.diamondAmount })
      });
      await fetch(`${FIREBASE_URL}/withdrawals/${withdrawalId}.json`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'rejected', rejectedAt: Date.now() })
      });

      await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: w.userId,
          text: `❌ Withdrawal rejected.\n💎 ${w.diamondAmount} Diamond refunded to your balance.`
        })
      });
    }

    return res.status(200).json({ ok: true, action });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
