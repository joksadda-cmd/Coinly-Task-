// api/claimAd.js
// Currency: TP (Task Points) — 20K TP = $1 = 0.5 TON
// Rewards: ad1(AdsGram Daily)=10TP/10 limit, ad2(AdsGram Special)=25TP/5 limit, ad3(Monetag)=15TP/15 limit, ad4(Giga)=15TP/15 limit
// Dice: under/over=30TP, lucky7=50TP
// Lootbox min: 300 TP | Dice cooldown: 4hr server-side
//
// ANTI-FAKE-CLAIM DESIGN v2 — same security properties as before, cheaper:
// Previously each ad-watch wrote a separate document to a standalone `adTokens`
// collection (3 reads + 4 writes per watch: token-create, user-read+write in
// startAd; token-read, user-read, token-update, user-update in claimAd). The
// token is now just a field on the user's own document (`pendingAdToken`)
// instead of a separate collection doc — cuts this to 1 read + 1 write per
// step (2 reads + 2 writes per full ad watch total), with IDENTICAL security
// guarantees:
//   - single-use:  cleared the moment it's redeemed, in the same transaction
//                  that credits the reward — a replayed claimAd call finds no
//                  matching pending token and is rejected
//   - time-limited: issuedAtMs + AD_TOKEN_TTL_MS, same as before
//   - tied to this exact user: it's a field ON their own document, and every
//     request is already authenticated via initData (HMAC against BOT_TOKEN)
//     to be this exact Telegram user — no separate random token ID needed,
//     since there's no cross-document lookup happening that a random ID would
//     protect against
//   - tied to a specific ad type: adType match checked at claim time
// Trade-off: only ONE ad can be "in flight" per user at a time (starting ad2
// while ad1's token is still pending overwrites it). This matches how the UI
// already works — one ad modal at a time, user finishes or cancels before
// starting another — so it's not a real behavior change for normal usage.
//
// Residual gap (same as before, restated): this proves "a real ad-watch
// attempt was started and claimed inside a real Telegram session" — it does
// not cryptographically prove the ad pixels were rendered on screen. Closing
// that fully would need the ad network to confirm impressions server-side,
// which AdsGram/Monetag/GigaPub don't expose for Mini Apps.
//
// joinGift / lootboxClaim / day-reset-only pings stay on the old "batch" shape
// since they carry no reward-without-proof risk.

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

const AD_REWARDS = { ad1:10, ad2:25, ad3:15, ad4:15, joinGift:50 };
const AD_LIMITS  = { ad1:10, ad2:5,  ad3:15, ad4:15 };
const AD_FIELDS  = { ad1:'adsWatchedAd1', ad2:'adsWatchedAd2', ad3:'adsWatchedAd3', ad4:'adsWatchedAd4' };
const TODAY = () => new Date().toLocaleDateString('en-US', { timeZone: 'Asia/Dhaka' });

const LOOTBOX_MIN_CLAIM  = 300;
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
    // START AD — store a one-time pending-token field on the user doc, no reward yet
    // 1 read + 1 write (was: 1 read + 2 writes against a separate collection)
    // ════════════════════════════════════
    if (startAd && typeof startAd === 'object') {
        const adType = startAd.adType;
        const isDice = adType === 'dice';
        if (!isDice && !AD_REWARDS[adType]) {
            return res.status(200).json({ success: false, error: 'Invalid adType' });
        }
        try {
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

                t.update(userRef, {
                    lastAdStartMs:   Date.now(),
                    pendingAdToken:  { adType, issuedAtMs: Date.now() },
                });
            });
            // The "token" returned to the client is just the adType — the real
            // state lives server-side on the user doc. The client only needs
            // to echo adType back at claim time, nothing secret to leak here.
            return res.status(200).json({ success: true, token: adType });
        } catch(e) {
            return res.status(200).json({ success: false, error: e.message });
        }
    }

    // ════════════════════════════════════
    // CLAIM AD — redeem the pending token exactly once, server computes the reward
    // 1 read + 1 write (was: 2 reads + 2 writes across two documents)
    // ════════════════════════════════════
    if (claimAd && typeof claimAd === 'object') {
        const { adType, diceReward } = claimAd;
        const isDice = adType === 'dice';
        if (!isDice && !AD_REWARDS[adType]) return res.status(200).json({ success: false, error: 'Invalid adType' });

        try {
            let result = {};
            await db.runTransaction(async (t) => {
                const userSnap = await t.get(userRef);
                if (!userSnap.exists) throw new Error('User not found');
                const user = userSnap.data();

                const pending = user.pendingAdToken;
                if (!pending)                          throw new Error('Invalid or expired ad session.');
                if (pending.adType !== adType)         throw new Error('Ad type mismatch.');
                if (Date.now() - pending.issuedAtMs > AD_TOKEN_TTL_MS) throw new Error('Ad session expired, try again.');

                if (isDice) {
                    const rawAmt = parseFloat(diceReward);
                    const amt = DICE_VALID_REWARDS.has(rawAmt) ? rawAmt : null;
                    if (amt === null) throw new Error('Invalid dice reward.');
                    if (Date.now() - (user.lastDiceRollAt || 0) < DICE_COOLDOWN_MS) throw new Error('Dice is on cooldown.');
                    t.update(userRef, {
                        diamondBalance: FieldValue.increment(amt),
                        lastDiceRollAt: Date.now(),
                        pendingAdToken: FieldValue.delete(),
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
                        pendingAdToken:  FieldValue.delete(),
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
