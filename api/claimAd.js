// api/claimAd.js — batch write support + lootbox transfer + joinGift

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

const AD_REWARDS = { ad1:0.5, ad2:1.0, ad3:0.5, ad4:0.5, joinGift:5 };
const AD_LIMITS  = { ad1:10,  ad2:10,  ad3:25,  ad4:25  };
const AD_FIELDS  = { ad1:'adsWatchedAd1', ad2:'adsWatchedAd2', ad3:'adsWatchedAd3', ad4:'adsWatchedAd4' };
const TODAY = () => new Date().toLocaleDateString('en-US', { timeZone: 'Asia/Dhaka' });
const MAX_DAILY_LOOTBOX = 42;

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

    // ── BATCH MODE ──
    if (batch && typeof batch === 'object') {
        try {
            const userSnap = await userRef.get();
            if (!userSnap.exists) return res.status(404).json({ error: 'User not found' });
            const user    = userSnap.data();
            const updates = {};
            let totalReward = 0;

            if (batch.lootboxTransfer && parseFloat(batch.lootboxTransfer) > 0) {
                const lb = parseFloat(batch.lootboxTransfer);
                const serverLb   = parseFloat(user.lootboxBalance || 0);
                const safeAmount = Math.min(lb, serverLb, MAX_DAILY_LOOTBOX);
                if (safeAmount > 0) {
                    updates.diamondBalance      = FieldValue.increment(safeAmount);
                    updates.lootboxBalance      = 0;
                    updates.lastLootboxTransfer = today;
                    updates.adsWatchedAd1 = 0; updates.adsWatchedAd2 = 0;
                    updates.adsWatchedAd3 = 0; updates.adsWatchedAd4 = 0;
                    updates.lastResetDate = today;
                    totalReward = safeAmount;
                }
            }

            if (batch.joinGift && !user.joinGiftClaimed) {
                updates.joinGiftClaimed = true;
                updates.diamondBalance  = FieldValue.increment(5);
                totalReward += 5;
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

            // Dice reward — direct to diamondBalance (not lootbox)
            if (batch.diceReward && parseFloat(batch.diceReward) > 0) {
                const diceAmt = Math.min(parseFloat(batch.diceReward), 2.5); // max 2.5 per roll
                updates.diamondBalance = FieldValue.increment(diceAmt);
                totalReward += diceAmt;
            }

            if (isNewDay && !batch.lootboxTransfer) {
                updates.lastResetDate = today;
                if (!updates.adsWatchedAd1) {
                    updates.adsWatchedAd1 = 0; updates.adsWatchedAd2 = 0;
                    updates.adsWatchedAd3 = 0; updates.adsWatchedAd4 = 0;
                }
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
        if (isNewDay) updates.lastResetDate = today;
        await userRef.update(updates);
        return res.status(200).json({ success: true, reward, watched: watched + 1, limit });
    } catch(e) {
        console.error('[claimAd single]', e.message);
        return res.status(500).json({ error: e.message });
    }
        }
