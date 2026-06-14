// api/claimAd.js
// Currency: TP (Task Points) — 10K TP = $1 = 0.5 TON
// Rewards: ad1(AdsGram Daily)=10TP, ad2(AdsGram Special)=20TP, ad3(Monetag)=10TP, ad4(Giga)=10TP
// Dice: under/over=30TP, lucky7=50TP
// Lootbox min: 150 TP | Dice cooldown: 4hr server-side

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

// ── Updated ad rewards ──
// ad1 = AdsGram Daily    → 10 TP (was 15)
// ad2 = AdsGram Special  → 20 TP (was 30)
// ad3 = Monetag          → 10 TP (was 15)
// ad4 = Giga Pub         → 10 TP (was 15)
const AD_REWARDS = { ad1:10, ad2:20, ad3:10, ad4:10, joinGift:50 };
const AD_LIMITS  = { ad1:10, ad2:5,  ad3:10, ad4:10 };
const AD_FIELDS  = { ad1:'adsWatchedAd1', ad2:'adsWatchedAd2', ad3:'adsWatchedAd3', ad4:'adsWatchedAd4' };
const TODAY = () => new Date().toLocaleDateString('en-US', { timeZone: 'Asia/Dhaka' });

const LOOTBOX_MIN_CLAIM  = 150;
const LOOTBOX_DAILY_MAX  = 2;
const DICE_COOLDOWN_MS   = 4 * 60 * 60 * 1000; // 4 hours
const DICE_VALID_REWARDS = new Set([30, 50]);    // only under/over=30, lucky=50

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

    // ── LOOTBOX CLAIM ──
    if (batch?.lootboxClaim === true) {
        try {
            const result = await db.runTransaction(async (t) => {
                const snap = await t.get(userRef);
                if (!snap.exists) throw new Error('User not found');
                const user = snap.data();
                const lb = parseFloat(user.lootboxBalance || 0);
                if (lb < LOOTBOX_MIN_CLAIM)
                    throw new Error(`Need at least ${LOOTBOX_MIN_CLAIM} TP. You have ${lb.toFixed(0)} TP`);
                const lbToday = user.lootboxClaimDate === today ? (user.lootboxClaimCount || 0) : 0;
                if (lbToday >= LOOTBOX_DAILY_MAX)
                    throw new Error(`Daily claim limit reached (${LOOTBOX_DAILY_MAX}x/day). Come back tomorrow!`);
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

            // Join gift
            if (batch.joinGift && !user.joinGiftClaimed) {
                updates.joinGiftClaimed = true;
                updates.diamondBalance  = FieldValue.increment(AD_REWARDS.joinGift);
                totalReward += AD_REWARDS.joinGift;
            }

            const isNewDay = user.lastResetDate !== today;

            // Ad rewards — server enforces limits and correct reward amounts
            for (const [type, count] of Object.entries(batch)) {
                if (!AD_REWARDS[type] || !AD_FIELDS[type]) continue;
                const field   = AD_FIELDS[type];
                const watched = isNewDay ? 0 : (user[field] || 0);
                const limit   = AD_LIMITS[type] || 10;
                // Clamp count to what's actually allowed (prevent any bypass)
                const safeCnt = Math.min(Math.max(0, parseInt(count) || 0), limit - watched);
                if (safeCnt <= 0) continue;
                // Use SERVER-SIDE reward amount — ignore any client-sent reward value
                const reward = AD_REWARDS[type] * safeCnt;
                updates[field]         = FieldValue.increment(safeCnt);
                updates.lootboxBalance = FieldValue.increment(reward);
                totalReward += reward;
            }

            // ── DICE REWARD — server-side cooldown + valid amount check ──
            if (batch.diceReward && parseFloat(batch.diceReward) > 0) {
                const rawAmt  = parseFloat(batch.diceReward);

                // Only allow valid dice outcomes: 30 (under/over) or 50 (lucky 7)
                const diceAmt = DICE_VALID_REWARDS.has(rawAmt) ? rawAmt : null;

                if (diceAmt !== null) {
                    // Cooldown check using existing user data — 0 extra Firebase read
                    const lastDice = user.lastDiceRollAt || 0;
                    const nowMs    = Date.now();
                    const elapsed  = nowMs - lastDice;

                    if (elapsed >= DICE_COOLDOWN_MS) {
                        // Valid roll — grant reward + save timestamp
                        updates.diamondBalance = FieldValue.increment(diceAmt);
                        updates.lastDiceRollAt = nowMs;
                        totalReward += diceAmt;
                    }
                    // If cooldown not met — silently ignore
                }
                // Invalid amount — silently ignore
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
        if (watched >= limit)
            return res.status(200).json({ success: false, error: 'Daily limit reached' });
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
