// api/getTasks.js
// Fetch approved tasks — TP (Task Points) currency
// Default rewardDiamond: 10 TP per task

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

    const createdBy = req.query?.createdBy;

    try {
        let query = db.collection('tasks');
        if (createdBy) {
            query = query.where('createdBy', '==', String(createdBy)).limit(50);
        } else {
            query = query.where('isApproved', '==', true).limit(100);
        }

        const snap = await query.get();
        const tasks = [];
        snap.forEach(d => {
            const t = d.data();
            tasks.push({
                id:              d.id,
                title:           t.title || '',
                url:             t.url   || '',
                category:        t.category || 'social',
                channelId:       t.channelId || '',
                rewardDiamond:   t.rewardDiamond || 10, // default 10 TP
                isApproved:      t.isApproved || false,
                completionCount: t.completionCount || 0,
                maxCompletions:  t.maxCompletions || 0,
                createdBy:       t.createdBy || '',
                tonCost:         t.tonCost || 0,
                packageLabel:    t.packageLabel || '',
            });
        });

        return res.status(200).json({ success: true, tasks });
    } catch (e) {
        console.error('[getTasks]', e.message);
        return res.status(500).json({ error: e.message, tasks: [] });
    }
}
