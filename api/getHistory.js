// api/getHistory.js
// Withdraw history — returns the most recent 20 withdrawals (pending +
// completed + rejected) for this user, newest first.
//
// CHANGED: previously fetched up to 50 docs with NO orderBy (to avoid needing
// a composite index), then sorted in JS. That meant "which 50" wasn't
// guaranteed to be the most recent 50 — Firestore returns documents in an
// arbitrary order without orderBy, so for a user with 100+ withdrawals,
// .limit(50) could silently miss recent ones. Switched to orderBy+limit so
// "last 20" actually means last 20.
//
// REQUIRES a composite index on withdrawals (userId ASC, createdAt DESC).
// If this hasn't been created yet, the FIRST time this query runs Firestore
// will return an error containing a direct link to auto-create it in the
// Firebase Console — click that link once, it's free and takes effect in a
// minute or two.

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

const HISTORY_LIMIT = 20;

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin',  '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

    const userId = req.query?.userId;
    if (!userId) return res.status(400).json({ error: 'userId required' });

    try {
        const snap = await db.collection('withdrawals')
            .where('userId', '==', String(userId))
            .orderBy('createdAt', 'desc')
            .limit(HISTORY_LIMIT)
            .get();

        const history = [];
        snap.forEach(d => {
            const data = d.data();
            history.push({
                id:            d.id,
                method:        data.method || 'tonkeeper',
                status:        data.status || 'pending',
                diamondAmount: data.diamondAmount || 0,
                tonAmount:     data.tonAmount || 0,
                details:       data.details || '',
                adminNote:     data.adminNote || '',
                date:          data.createdAt
                    ? data.createdAt.toDate().toLocaleDateString('en-GB')
                    : '',
            });
        });

        return res.status(200).json({ success: true, history });

    } catch (e) {
        console.error('[getHistory]', e.message);
        // If this is the missing-index error, Firestore's e.message contains
        // a direct console link to auto-create it — surface it for debugging.
        return res.status(500).json({ error: e.message, history: [] });
    }
}
