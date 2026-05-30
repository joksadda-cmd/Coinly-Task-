// api/claimAd.js
// Ad reward + joinGift — server-side, Firestore rules bypass

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

const AD_REWARDS = { ad1:0.25, ad2:0.5, ad3:0.25, ad4:0.25, joinGift:5 };
const AD_LIMITS  = { ad1:10, ad2:5, ad3:10, ad4:8 }; // daily limits
const AD_FIELDS  = {
    ad1:'adsWatchedAd1', ad2:'adsWatchedAd2',
    ad3:'adsWatchedAd3', ad4:'adsWatchedAd4'
};

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin',  '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const { userId, adType } = req.body || {};
    if (!userId || !adType) return res.status(400).json({ error: 'userId and adType required' });
    if (!(adType in AD_REWARDS)) return res.status(400).json({ error: 'Invalid adType' });

    const uid    = String(userId);
    const reward = AD_REWARDS[adType];
    const today  = new Date().toLocaleDateString('en-US', { timeZone: 'Asia/Dhaka' });

    try {
        const userRef  = db.collection('users').doc(uid);
        const userSnap = await userRef.get();
        if (!userSnap.exists) return res.status(404).json({ error: 'User not found' });

        const user = userSnap.data();

        // joinGift — one time only
        if (adType === 'joinGift') {
            if (user.joinGiftClaimed) return res.status(200).json({ success: false, error: 'Already claimed' });
            await userRef.update({
                joinGiftClaimed: true,
                diamondBalance: FieldValue.increment(reward),
            });
            return res.status(200).json({ success: true, reward });
        }

        // Daily limit check
        const field   = AD_FIELDS[adType];
        const watched = user.lastResetDate === today ? (user[field] || 0) : 0;
        const limit   = AD_LIMITS[adType] || 10;

        if (watched >= limit) {
            return res.status(200).json({ success: false, error: `Daily limit reached (${limit}/day)` });
        }

        const updates = {
            lootboxBalance: FieldValue.increment(reward),
            [field]: FieldValue.increment(1),
        };
        // Reset if new day
        if (user.lastResetDate !== today) {
            updates.lastResetDate = today;
            Object.values(AD_FIELDS).forEach(f => { if (f !== field) updates[f] = 0; });
        }

        await userRef.update(updates);
        return res.status(200).json({ success: true, reward, watched: watched + 1, limit });

    } catch (e) {
        console.error('[claimAd]', e.message);
        return res.status(500).json({ error: e.message });
    }
}
