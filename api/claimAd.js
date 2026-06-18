// api/claimAd.js
// Currency: TP (Task Points) — 20K TP = $1 = 0.5 TON
// Rewards: ad1(AdsGram Daily)=10TP, ad2(AdsGram Special)=20TP, ad3(Monetag)=10TP, ad4(Giga)=10TP
// Dice: under/over=30TP, lucky7=50TP
// Lootbox min: 150 TP | Dice cooldown: 4hr server-side
//
// ANTI-FAKE-CLAIM DESIGN (replaces the old "batch count" trust model for ads/dice):
// 1. Frontend calls { startAd: { adType } } BEFORE showing the ad SDK. Server checks
//    daily limit / dice cooldown / 7s inter-ad gap, and if OK issues a one-time token.
// 2. Frontend only shows the ad after getting a token, and only calls
//    { claimAd: { adType, token } } AFTER the ad SDK genuinely reports completion.
// 3. Server validates the token (belongs to this user, this adType, unused, not
//    expired), marks it used, and credits the reward. A token can't be replayed,
//    can't be reused for a different ad type, and expires after 2 minutes if unused.
// This does not require trusting any client-reported "ad watched" signal — the
// reward amount and limits are always server-computed, same as before.
//
// Residual gap: this proves "a real ad-watch attempt was started and a token was
// redeemed inside a real Telegram session" — it does not prove the ad pixels were
// actually rendered on screen. A user who can intercept network requests could in
// theory call startAd then immediately call claimAd without the SDK ever running.
// Closing that fully would require the ad network to also confirm the impression
// server-side, which AdsGram/Monetag/GigaPub don't expose for Mini Apps. This
// raises the bar a lot (no more "just hit the API N times for the daily max")
// but it isn't a cryptographic guarantee.
//
// joinGift / lootboxClaim / day-reset-only pings stay on the old "batch" shape
// since they carry no reward-without-proof risk (one-time flag, balance transfer,
// or a no-op reset check).

import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import crypto from "crypto";

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

const BOT_TOKEN = process.env.BOT_TOKEN;
const INITDATA_MAX_AGE_SEC = 3600; // reject initData older than 1 hour

function verifyTelegramInitData(initData) {
    if (!initData || !BOT_TOKEN) return null;
    try {
        const params = new URLSearchParams(initData);
        const hash = params.get('hash');
        if (!hash) return null;
        params.delete('hash');

        const pairs = [];
        for (const key of [...params.keys()].sort()) {
            pairs.push(`${key}=${params.get(key)}`);
        }
        const dataCheckString = pairs.join('\n');

        const secretKey = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
        const computedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
        if (computedHash !== hash) return null;

        const authDate = parseInt(params.get('auth_date') || '0', 10);
        if (!authDate || (Date.now() / 1000 - authDate) > INITDATA_MAX_AGE_SEC) return null;

        const user = JSON.parse(params.get('user') || 'null');
        if (!user || !user.id) return null;

        return String(user.id);
    } catch (e) {
        return null;
    }
}

const AD_REWARDS = { ad1:10, ad2:20, ad3:10, ad4:10, joinGift:50 };
const AD_LIMITS  = { ad1:10, ad2:5,  ad3:10, ad4:10 };
const AD_FIELDS  = { ad1:'adsWatchedAd1', ad2:'adsWatchedAd2', ad3:'adsWatchedAd3', ad4:'adsWatchedAd4' };
const TODAY = () => new Date().toLocaleDateString('en-US', { timeZone: 'Asia/Dhaka' });

const LOOTBOX_MIN_CLAIM  = 150;
const LOOTBOX_DAILY_MAX  = 2;
const DICE_COOLDOWN_MS   = 4 * 60 * 60 * 1000; // 4 hours
const DICE_VALID_REWARDS = new Set([30, 50]);    // only under/over=30, lucky=50

const AD_TOKEN_TTL_MS = 2 * 60 * 1000;  // token must be redeemed within 2 minutes
const MIN_AD_GAP_MS   = 7 * 1000;       // 7s minimum between starting two ads (any type)

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin',  '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const { userId, batch, startAd, claimAd, initData } = req.body || {};
    if (!userId) return res.status(400).json({ error: 'userId required' });

    const verifiedId = verifyTelegramInitData(initData);
    if (!verifiedId || verifiedId !== String(userId)) {
        return res.status(401).json({ error: 'unauthorized' });
    }

    const uid     = String(userId);
    const today   = TODAY();
    const userRef = db.collection('users').doc(uid);

    // ════════════════════════════════════
    // START AD — issue a one-time token, no reward yet
    // ════════════════════════════════════
    if (startAd && typeof startAd === 'object') {
        const adType = startAd.adType;
        const isDice = adType === 'dice';
        if (!isDice && !AD_REWARDS[adType]) {
            return res.status(200).json({ success: false, error: 'Invalid adType' });
        }
        try {
            let tokenId = '';
            await db.runTransaction(async (t) => {
                const snap = await t.get(userRef);
                if (!snap.exists) throw new Error('User not found');
                const user = snap.data();

                const lastStart = user.lastAdStartMs || 0;
                const gap = Date.now() - lastStart;
                if (gap < MIN_AD_GAP_MS) {
                    throw new Error(`Please wait ${Math.ceil((MIN_AD_GAP_MS - gap) / 1000)}s before the next ad.`);
                }

                if (isDice) {
                    if (Date.now() - (user.lastDiceRollAt || 0) < DICE_COOLDOWN_MS) {
                        throw new Error('Dice is on cooldown.');
                    }
                } else {
                    const isNewDay = user.lastResetDate !== today;
                    const watched  = isNewDay ? 0 : (user[AD_FIELDS[adType]] || 0);
                    if (watched >= (AD_LIMITS[adType] || 10)) {
                        throw new Error('Daily limit reached for this ad.');
                    }
                }

                const tokenRef = db.collection('adTokens').doc();
                tokenId = tokenRef.id;
                t.set(tokenRef, { uid, adType, used: false, issuedAtMs: Date.now() });
                t.update(userRef, { lastAdStartMs: Date.now() });
            });
            return res.status(200).json({ success: true, token: tokenId });
        } catch(e) {
            return res.status(200).json({ success: false, error: e.message });
        }
    }

    // ════════════════════════════════════
    // CLAIM AD — redeem a token exactly once, server computes the reward
    // ════════════════════════════════════
    if (claimAd && typeof claimAd === 'object') {
        const { adType, token, diceReward } = claimAd;
        const isDice = adType === 'dice';
        if (!token) return res.status(200).json({ success: false, error: 'Missing token' });
        if (!isDice && !AD_REWARDS[adType]) return res.status(200).json({ success: false, error: 'Invalid adType' });

        try {
            let result = {};
            await db.runTransaction(async (t) => {
                const tokenRef  = db.collection('adTokens').doc(String(token));
                const tokenSnap = await t.get(tokenRef);
                if (!tokenSnap.exists) throw new Error('Invalid or expired ad session.');
                const tokenData = tokenSnap.data();
                if (tokenData.used)            throw new Error('This ad was already claimed.');
                if (tokenData.uid !== uid)      throw new Error('Token does not belong to this user.');
                if (tokenData.adType !== adType) throw new Error('Ad type mismatch.');
                if (Date.now() - tokenData.issuedAtMs > AD_TOKEN_TTL_MS) throw new Error('Ad session expired, try again.');

                const userSnap = await t.get(userRef);
                if (!userSnap.exists) throw new Error('User not found');
                const user = userSnap.data();

                t.update(tokenRef, { used: true, claimedAtMs: Date.now() });

                if (isDice) {
                    const rawAmt = parseFloat(diceReward);
                    const amt = DICE_VALID_REWARDS.has(rawAmt) ? rawAmt : null;
                    if (amt === null) throw new Error('Invalid dice reward.');
                    if (Date.now() - (user.lastDiceRollAt || 0) < DICE_COOLDOWN_MS) throw new Error('Dice is on cooldown.');
                    t.update(userRef, {
                        diamondBalance: FieldValue.increment(amt),
                        lastDiceRollAt: Date.now(),
                    });
                    result = { reward: amt };
                } else {
                    const field    = AD_FIELDS[adType];
                    const isNewDay = user.lastResetDate !== today;
                    const watched  = isNewDay ? 0 : (user[field] || 0);
                    const limit    = AD_LIMITS[adType] || 10;
                    if (watched >= limit) throw new Error('Daily limit reached for this ad.');
                    const reward = AD_REWARDS[adType];
                    const updates = {
                        [field]:         FieldValue.increment(1),
                        lootboxBalance:  FieldValue.increment(reward),
                    };
                    if (isNewDay) {
                        updates.lastResetDate = today;
                        updates.adsWatchedAd1 = 0; updates.adsWatchedAd2 = 0;
                        updates.adsWatchedAd3 = 0; updates.adsWatchedAd4 = 0;
                        updates[field] = 1; // overwrite the increment — this is the first watch of the new day
                    }
                    t.update(userRef, updates);
                    result = { reward };
                }
            });
            return res.status(200).json({ success: true, ...result });
        } catch(e) {
            return res.status(200).json({ success: false, error: e.message });
        }
    }

    // ════════════════════════════════════
    // LOOTBOX CLAIM
    // ════════════════════════════════════
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

    // ════════════════════════════════════
    // BATCH MODE — only joinGift + day-reset-only ping now
    // (ad1-4 and dice no longer trusted via raw counts — see startAd/claimAd above)
    // ════════════════════════════════════
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

    return res.status(400).json({ error: 'Invalid request' });
                    }
