// api/cronCheck.js
// Runs every hour — triggers verifyDeposit

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  try {
    const baseUrl = `https://${req.headers.host}`;
    const r = await fetch(`${baseUrl}/api/verifyDeposit`);
    const d = await r.json();
    return res.status(200).json({ ok: true, timestamp: new Date().toISOString(), result: d });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
