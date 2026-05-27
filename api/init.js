// api/init.js
// Called when new user opens mini app — saves to Firestore via REST

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const { userId, firstName, username, referrerCode } = req.body || {};
  if (!userId) return res.status(400).json({ error: 'userId required' });

  const BOT_TOKEN    = process.env.BOT_TOKEN;
  const FIREBASE_URL = 'https://coinly-task-default-rtdb.firebaseio.com';

  try {
    // Check if user exists
    const userRes  = await fetch(`${FIREBASE_URL}/users/${userId}.json`);
    const userData = await userRes.json();

    if (!userData) {
      // New user — create record
      const newUser = {
        chat_id:        userId,
        firstName:      firstName || 'User',
        username:       username  || 'N/A',
        diamondBalance: 0,
        completedTasks: [],
        totalInvites:   0,
        validReferrals: 0,
        referralDiamondEarned: 0,
        isBanned:       false,
        joinGiftClaimed: false,
        isValidatedRef:  false,
        joinedAt:        Date.now(),
        referredBy:      referrerCode && referrerCode !== userId ? referrerCode : null
      };

      await fetch(`${FIREBASE_URL}/users/${userId}.json`, {
        method:  'PUT',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(newUser)
      });

      // Save referral record
      if (referrerCode && referrerCode !== userId) {
        await fetch(`${FIREBASE_URL}/referrals/${referrerCode}/${userId}.json`, {
          method:  'PUT',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ joinedAt: Date.now(), valid: false })
        });

        // Increment referrer's totalInvites
        const refRes  = await fetch(`${FIREBASE_URL}/users/${referrerCode}.json`);
        const refData = await refRes.json();
        if (refData) {
          await fetch(`${FIREBASE_URL}/users/${referrerCode}.json`, {
            method:  'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ totalInvites: (refData.totalInvites || 0) + 1 })
          });
        }
      }

      return res.status(200).json({ ok: true, isNew: true });
    }

    return res.status(200).json({ ok: true, isNew: false });

  } catch (err) {
    console.error('init error:', err);
    return res.status(500).json({ error: err.message });
  }
}
