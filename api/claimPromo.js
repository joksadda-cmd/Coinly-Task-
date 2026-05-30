// api/claimPromo.js
// Promo code redeem API — hacker proof
// Client-side Firestore write বন্ধ — সব server-side verify করা হবে

import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";

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
    res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST')   return res.status(405).json({ error: 'Method not allowed' });

    const { userId, code } = req.body || {};
    if (!userId || !code) return res.status(400).json({ error: 'userId and code required' });

    const cleanCode = String(code).trim().toUpperCase();
    const uid       = String(userId);

    try {
        let rewardAmount = 0;

        await db.runTransaction(async (t) => {
            const promoRef  = db.collection('promo_codes').doc(cleanCode);
            const promoSnap = await t.get(promoRef);

            // Promo exist করে না
            if (!promoSnap.exists) throw new Error('Invalid promo code.');

            const promo = promoSnap.data();

            // Active check
            if (!promo.isActive) throw new Error('This promo code is no longer active.');

            // Max uses check
            if (promo.currentUses >= promo.maxUses) throw new Error('Promo code limit reached.');

            // Already claimed check
            if ((promo.usersClaimed || []).includes(uid)) throw new Error('You already used this code.');

            // Expiry check (optional)
            if (promo.expiresAt && promo.expiresAt.toDate() < new Date()) {
                throw new Error('Promo code has expired.');
            }

            rewardAmount = promo.rewardAmount || 0;
            if (rewardAmount <= 0) throw new Error('Invalid reward amount.');

            const userRef = db.collection('users').doc(uid);
            const userSnap = await t.get(userRef);
            if (!userSnap.exists) throw new Error('User not found.');

            // Diamond credit করো
            t.update(userRef, {
                diamondBalance: FieldValue.increment(rewardAmount)
            });

            // Promo usage update
            t.update(promoRef, {
                currentUses:  FieldValue.increment(1),
                usersClaimed: FieldValue.arrayUnion(uid),
            });

            // Log
            t.set(db.collection('transactions').doc(), {
                userId:        uid,
                type:          'Promo Code',
                details:       `Code: ${cleanCode}`,
                diamondAmount: rewardAmount,
                createdAt:     FieldValue.serverTimestamp(),
            });
        });

        return res.status(200).json({ success: true, reward: rewardAmount });

    } catch (e) {
        console.error('[claimPromo]', e.message);
        // User-friendly error পাঠাও
        return res.status(200).json({ success: false, error: e.message });
    }
}
