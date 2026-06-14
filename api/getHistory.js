// api/getHistory.js
// Withdraw history — returns pending + completed + rejected withdrawals
// Sorted newest first in JS (no Firestore composite index needed)

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

    const userId = req.query?.userId;
    if (!userId) return res.status(400).json({ error: 'userId required' });

    try {
        // No orderBy — avoids composite index requirement
        const snap = await db.collection('withdrawals')
            .where('userId', '==', String(userId))
            .limit(50)
            .get();

        const history = [];
        snap.forEach(d => {
            const data = d.data();
            // Include all statuses so user can see full history
            history.push({
                id:            d.id,
                method:        data.method || 'tonkeeper',
                status:        data.status || 'pending',
                diamondAmount: data.diamondAmount || 0,
                tonAmount:     data.tonAmount || 0,
                details:       data.details || '',
                adminNote:     data.adminNote || '',
                _ts:           data.createdAt ? data.createdAt.toMillis() : 0,
                date:          data.createdAt
                    ? data.createdAt.toDate().toLocaleDateString('en-GB')
                    : '',
            });
        });

        // Sort newest first
        history.sort((a, b) => b._ts - a._ts);
        history.forEach(h => delete h._ts);

        return res.status(200).json({ success: true, history });

    } catch (e) {
        console.error('[getHistory]', e.message);
        return res.status(500).json({ error: e.message, history: [] });
    }
}
