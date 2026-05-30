// api/getTasks.js
// Fetch approved tasks — server-side, no Firestore rules issue

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
        const snap = await db.collection('tasks')
            .where('isApproved', '==', true)
            .limit(100)
            .get();

        const tasks = [];
        snap.forEach(d => {
            const t = d.data();
            tasks.push({
                id:        d.id,
                title:     t.title || '',
                url:       t.url   || '',
                category:  t.category || 'social',
                channelId: t.channelId || '',
                rewardDiamond: t.rewardDiamond || 2,
            });
        });

        return res.status(200).json({ success: true, tasks });
    } catch (e) {
        console.error('[getTasks]', e.message);
        return res.status(500).json({ error: e.message, tasks: [] });
    }
}
