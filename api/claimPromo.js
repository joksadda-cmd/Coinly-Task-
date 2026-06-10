// api/claimPromo.js
// Promo code redeem API — hacker proof
// validateOnly=true → শুধু validate করে, reward দেয় না (ad দেখানোর আগে call করা হয়)
// validateOnly=false (default) → validate + reward দেয় (ad দেখানোর পরে call করা হয়)

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

    const { userId, code, validateOnly } = req.body || {};
    if (!userId || !code) return res.status(400).json({ error: 'userId and code required' });

    const cleanCode = String(code).trim().toUpperCase();
    const uid       = String(userId);
    const isValidateOnly = validateOnly === true;

    try {
        // ── VALIDATE ONLY MODE (ad দেখানোর আগে) ──
        if (isValidateOnly) {
            const promoRef  = db.collection('promo_codes').doc(cleanCode);
            const promoSnap = await promoRef.get();

            if (!promoSnap.exists)
                return res.status(200).json({ valid: false, error: 'Invalid promo code.' });

            const promo = promoSnap.data();

            if (!promo.isActive)
                return res.status(200).json({ valid: false, error: 'This promo code is no longer active.' });

            if (promo.currentUses >= promo.maxUses)
                return res.status(200).json({ valid: false, error: 'Promo code limit reached.' });

            if ((promo.usersClaimed || []).includes(uid))
                return res.status(200).json({ valid: false, error: 'Promo code already used.' });

            if (promo.expiresAt && promo.expiresAt.toDate() < new Date())
                return res.status(200).json({ valid: false, error: 'Promo code has expired.' });

            if (!promo.rewardAmount || promo.rewardAmount <= 0)
                return res.status(200).json({ valid: false, error: 'Invalid reward amount.' });

            // Valid — return reward info so client can show "you'll earn X"
            return res.status(200).json({
                valid: true,
                reward: promo.rewardAmount,
                rewardType: promo.rewardType || 'diamond',
            });
        }

        // ── CLAIM MODE (ad দেখানোর পরে) ──
        let rewardAmount = 0;
        let rewardType   = 'diamond';

        await db.runTransaction(async (t) => {
            const promoRef  = db.collection('promo_codes').doc(cleanCode);
            const promoSnap = await t.get(promoRef);

            if (!promoSnap.exists) throw new Error('Invalid promo code.');

            const promo = promoSnap.data();

            if (!promo.isActive) throw new Error('This promo code is no longer active.');
            if (promo.currentUses >= promo.maxUses) throw new Error('Promo code limit reached.');
            if ((promo.usersClaimed || []).includes(uid)) throw new Error('Promo code already used.');
            if (promo.expiresAt && promo.expiresAt.toDate() < new Date()) throw new Error('Promo code has expired.');

            rewardAmount = promo.rewardAmount || 0;
            if (rewardAmount <= 0) throw new Error('Invalid reward amount.');

            rewardType        = promo.rewardType || 'diamond';
            const userRef     = db.collection('users').doc(uid);
            const userSnap    = await t.get(userRef);
            if (!userSnap.exists) throw new Error('User not found.');

            const field = rewardType === 'ton' ? 'tonBalance' : 'diamondBalance';
            t.update(userRef, { [field]: FieldValue.increment(rewardAmount) });

            t.update(promoRef, {
                currentUses:  FieldValue.increment(1),
                usersClaimed: FieldValue.arrayUnion(uid),
            });

            t.set(db.collection('transactions').doc(), {
                userId:        uid,
                type:          'Promo Code',
                details:       `Code: ${cleanCode}`,
                diamondAmount: rewardAmount,
                createdAt:     FieldValue.serverTimestamp(),
            });
        });

        return res.status(200).json({ success: true, reward: rewardAmount, rewardType });

    } catch (e) {
        console.error('[claimPromo]', e.message);
        return res.status(200).json({ success: false, error: e.message });
    }
}
