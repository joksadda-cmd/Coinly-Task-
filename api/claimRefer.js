// api/claimRefer.js
// Refer reward API — client-side থেকে Firestore write বন্ধ
// User 10 task complete করলে referrer কে 5 diamond দেওয়া হবে

import { initializeApp, getApps } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";


// Firebase Admin init
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

const REFER_REWARD    = 5;
const REFER_MIN_TASKS = 10;

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin',  '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST')   return res.status(405).json({ error: 'Method not allowed' });

    const { userId } = req.body || {};
    if (!userId) return res.status(400).json({ error: 'userId required' });

    try {
        const userRef  = db.collection('users').doc(String(userId));
        const userSnap = await userRef.get();
        if (!userSnap.exists) return res.status(404).json({ error: 'User not found' });

        const user = userSnap.data();

        // Already validated — double-claim থেকে রক্ষা
        if (user.isValidatedRef) {
            return res.status(200).json({ success: true, alreadyClaimed: true });
        }

        // Referrer নেই
        const referrerId = user.referredBy;
        if (!referrerId) return res.status(400).json({ error: 'No referrer' });

        // Task count check — server-side
        const completedTasks = user.completedTasks || [];
        if (completedTasks.length < REFER_MIN_TASKS) {
            return res.status(400).json({
                error: `Need ${REFER_MIN_TASKS} tasks. Done: ${completedTasks.length}`
            });
        }

        // Transaction: referrer reward + mark user validated
        await db.runTransaction(async (t) => {
            const referrerRef  = db.collection('users').doc(String(referrerId));
            const referrerSnap = await t.get(referrerRef);
            if (!referrerSnap.exists) throw new Error('Referrer not found');

            // user কে validated mark করো
            t.update(userRef, { isValidatedRef: true });

            // referrer কে diamond দাও
            t.update(referrerRef, {
                diamondBalance:        FieldValue.increment(REFER_REWARD),
                validReferrals:        FieldValue.increment(1),
                referralDiamondEarned: FieldValue.increment(REFER_REWARD),
            });

            // transaction log
            t.set(db.collection('transactions').doc(), {
                userId:    referrerId,
                type:      'Refer Reward',
                details:   `Friend UID: ${userId}`,
                diamondAmount: REFER_REWARD,
                createdAt: FieldValue.serverTimestamp(),
            });
        });

        return res.status(200).json({ success: true, reward: REFER_REWARD });

    } catch (e) {
        console.error('[claimRefer]', e.message);
        return res.status(500).json({ error: e.message });
    }
                                    }
