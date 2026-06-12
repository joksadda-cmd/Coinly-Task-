// api/claimAd.js
// Currency: TP (Task Points) — 10K TP = $1 = 0.5 TON
// Rewards: ad2=30TP, ad1/ad3/ad4=15TP each | Dice: under/over=30TP, lucky7=50TP
// Lootbox min claim: 150 TP

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

const AD_REWARDS = { ad1:15, ad2:30, ad3:15, ad4:15, joinGift:50 }; // TP rewards
const AD_LIMITS  = { ad1:10, ad2:5,  ad3:10, ad4:10 };
const AD_FIELDS  = { ad1:'adsWatchedAd1', ad2:'adsWatchedAd2', ad3:'adsWatchedAd3', ad4:'adsWatchedAd4' };
const TODAY = () => new Date().toLocaleDateString('en-US', { timeZone: 'Asia/Dhaka' });

const LOOTBOX_MIN_CLAIM = 150;  // 150 TP min to claim
const LOOTBOX_DAILY_MAX = 2;

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin',  '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const { userId, adType, batch } = req.body || {};
    if (!userId) return res.status(400).json({ error: 'userId required' });

    const uid     = String(userId);
    const today   = TODAY();
    const userRef = db.collection('users').doc(uid);

    // ── LOOTBOX CLAIM MODE ──
    if (batch?.lootboxClaim === true) {
        try {
            const result = await db.runTransaction(async (t) => {
                const snap = await t.get(userRef);
                if (!snap.exists) throw new Error('User not found');
                const user = snap.data();
                const lb = parseFloat(user.lootboxBalance || 0);
                if (lb < LOOTBOX_MIN_CLAIM) {
                    throw new Error(`Need at least ${LOOTBOX_MIN_CLAIM} TP in Lootbox to claim. You have ${lb.toFixed(0)} TP`);
                }
                const lbToday = user.lootboxClaimDate === today ? (user.lootboxClaimCount || 0) : 0;
                if (lbToday >= LOOTBOX_DAILY_MAX) {
                    throw new Error(`Daily claim limit reached (${LOOTBOX_DAILY_MAX}x per day). Come back tomorrow!`);
                }
                t.update(userRef, {
                    diamondBalance:    FieldValue.increment(lb),
                    lootboxBalance:    0,
                    lootboxClaimDate:  today,
                    lootboxClaimCount: lbToday + 1,
                });
                return { transferred: lb, claimsLeft: LOOTBOX_DAILY_MAX - lbToday - 1 };
            });
            return res.status(200).json({ success: true, ...result });
        } catch(e) {
            return res.status(200).json({ success: false, error: e.message });
        }
    }

    // ── BATCH MODE ──
    if (batch && typeof batch === 'object') {
        try {
            const userSnap = await userRef.get();
            if (!userSnap.exists) return res.status(404).json({ error: 'User not found' });
            const user    = userSnap.data();
            const updates = {};
            let totalReward = 0;

            if (batch.joinGift && !user.joinGiftClaimed) {
                updates.joinGiftClaimed = true;
                updates.diamondBalance  = FieldValue.increment(AD_REWARDS.joinGift);
                totalReward += AD_REWARDS.joinGift;
            }

            const isNewDay = user.lastResetDate !== today;

            for (const [type, count] of Object.entries(batch)) {
                if (!AD_REWARDS[type] || !AD_FIELDS[type]) continue;
                const field   = AD_FIELDS[type];
                const watched = isNewDay ? 0 : (user[field] || 0);
                const limit   = AD_LIMITS[type] || 10;
                const safeCnt = Math.min(Math.max(0, parseInt(count) || 0), limit - watched);
                if (safeCnt <= 0) continue;
                const reward = AD_REWARDS[type] * safeCnt;
                updates[field]         = FieldValue.increment(safeCnt);
                updates.lootboxBalance = FieldValue.increment(reward);
                totalReward += reward;
            }

            // Dice reward → direct to diamondBalance (not lootbox), max 50 TP
            if (batch.diceReward && parseFloat(batch.diceReward) > 0) {
                const diceAmt = Math.min(parseFloat(batch.diceReward), 50);
                updates.diamondBalance = FieldValue.increment(diceAmt);
                totalReward += diceAmt;
            }

            if (isNewDay) {
                updates.lastResetDate  = today;
                updates.adsWatchedAd1  = 0;
                updates.adsWatchedAd2  = 0;
                updates.adsWatchedAd3  = 0;
                updates.adsWatchedAd4  = 0;
            }

            if (Object.keys(updates).length > 0) await userRef.update(updates);
            return res.status(200).json({ success: true, reward: totalReward });
        } catch(e) {
            console.error('[claimAd batch]', e.message);
            return res.status(500).json({ error: e.message });
        }
    }

    // ── SINGLE MODE ──
    if (!adType || !(adType in AD_REWARDS)) return res.status(400).json({ error: 'Invalid adType' });
    const reward = AD_REWARDS[adType];
    try {
        const userSnap = await userRef.get();
        if (!userSnap.exists) return res.status(404).json({ error: 'User not found' });
        const user    = userSnap.data();
        const field   = AD_FIELDS[adType];
        const isNewDay = user.lastResetDate !== today;
        const watched  = isNewDay ? 0 : (user[field] || 0);
        const limit    = AD_LIMITS[adType] || 10;
        if (watched >= limit) return res.status(200).json({ success: false, error: 'Daily limit reached' });
        const updates = { lootboxBalance: FieldValue.increment(reward), [field]: FieldValue.increment(1) };
        if (isNewDay) {
            updates.lastResetDate = today;
            updates.adsWatchedAd1 = 0; updates.adsWatchedAd2 = 0;
            updates.adsWatchedAd3 = 0; updates.adsWatchedAd4 = 0;
        }
        await userRef.update(updates);
        return res.status(200).json({ success: true, reward, watched: watched + 1, limit });
    } catch(e) {
        console.error('[claimAd single]', e.message);
        return res.status(500).json({ error: e.message });
    }
    }
