// api/getRecentWithdrawals.js
// Returns the last 10 approved withdrawals for the home screen live ticker.
// Only firstName + amount + method are exposed — no userId, no wallet address.
// Used for the "Recent Withdrawals" animated feed on the home section.

import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

if (!getApps().length) {
    initializeApp({
        credential: cert({
            projectId:   process.env.FIREBASE_PROJECT_ID,
            clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
            privateKey:  process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
        }),
    });
}
const db = getFirestore();

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin',  '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

    try {
        // Fetch recent approved withdrawals — no composite index needed (filter in JS)
        const snap = await db.collection('withdrawals')
            .where('status', '==', 'approved')
            .limit(30)
            .get();

        const list = [];
        snap.forEach(d => {
            const data = d.data();
            list.push({
                firstName: data.firstName || 'User',
                diamondAmount: data.diamondAmount || 0,
                tonAmount:     data.tonAmount || 0,
                method:        data.method || 'tonkeeper',
                _ts: data.createdAt ? data.createdAt.toMillis() : 0,
            });
        });

        // Sort newest first, take top 10
        list.sort((a, b) => b._ts - a._ts);
        const recent = list.slice(0, 10).map(({ _ts, ...rest }) => rest);

        return res.status(200).json({ success: true, recent });
    } catch(e) {
        console.error('[getRecentWithdrawals]', e.message);
        return res.status(200).json({ success: true, recent: [] });
    }
}
