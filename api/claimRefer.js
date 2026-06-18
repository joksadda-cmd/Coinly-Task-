// api/claimRefer.js
// 3-Step Refer Reward System:
// Step 1: Friend joins bot+channel+community → +50 TP (immediate on first init)
// Step 2: Friend completes 10 tasks → +80 TP
// Step 3: Friend watches 20 ads total → +100 TP
// All rewards go directly to diamondBalance (not lootbox)
//
// SECURITY: same gap as claimAd.js/claimTask.js had — nothing verified the caller
// actually was the Telegram user for this userId, so any step could be triggered
// directly with an arbitrary userId/step combo. initData verification added; the
// rest of the validation logic (10-tasks-in-24hr window, 20-ads-total check,
// one-time-claimed flags) is unchanged — that part was already server-validated
// against stored data, not client-trusted.

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
const db  = getFirestore();
const BOT = process.env.BOT_TOKEN;
const APP_URL = process.env.APP_URL || 'https://coinly-task.vercel.app';

const REFER_STEP1_REWARD = 50;   // joined bot+channel+community
const REFER_STEP2_REWARD = 80;   // completed 10 tasks
const REFER_STEP3_REWARD = 100;  // watched 20 ads
const REFER_MIN_TASKS    = 10;
const REFER_MIN_ADS      = 20;
const REFER_WINDOW_HR    = 24;   // tasks must be within 24hr for step 2
const TP_TO_USD          = 0.00005; // 20K TP = $1

const INITDATA_MAX_AGE_SEC = 3600;

function verifyTelegramInitData(initData) {
    if (!initData || !BOT) return null;
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

        const secretKey = crypto.createHmac('sha256', 'WebAppData').update(BOT).digest();
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

const miniAppBtn = {
    reply_markup: {
        inline_keyboard: [[
            { text: '🚀 Open Coinly Task', web_app: { url: APP_URL } }
        ]]
    }
};

async function tgMsg(chatId, text, extra = {}) {
    if (!BOT || !chatId) return;
    try {
        await fetch(`https://api.telegram.org/bot${BOT}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: String(chatId), text, parse_mode: 'HTML', ...extra })
        });
    } catch(e) { console.warn('[tgMsg]', e.message); }
}

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin',  '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const { userId, step, initData } = req.body || {};
    if (!userId) return res.status(400).json({ error: 'userId required' });

    const verifiedId = verifyTelegramInitData(initData);
    if (!verifiedId || verifiedId !== String(userId)) {
        return res.status(401).json({ error: 'unauthorized' });
    }

    const uid      = String(userId);
    const stepNum  = parseInt(step) || 2; // default step 2 (backward compat)

    try {
        const userRef  = db.collection('users').doc(uid);
        const userSnap = await userRef.get();
        if (!userSnap.exists) return res.status(404).json({ error: 'User not found' });

        const user      = userSnap.data();
        const referrerId = user.referredBy;
        if (!referrerId) return res.status(400).json({ error: 'No referrer' });

        // ══════════════════════════════
        // STEP 1 — Joined bot+channel+community
        // ══════════════════════════════
        if (stepNum === 1) {
            if (user.referStep1Claimed) {
                return res.status(200).json({ success: true, alreadyClaimed: true, step: 1 });
            }

            let newBal = 0;
            await db.runTransaction(async (t) => {
                const refRef  = db.collection('users').doc(String(referrerId));
                const refSnap = await t.get(refRef);
                if (!refSnap.exists) throw new Error('Referrer not found');
                const refData = refSnap.data();
                newBal = (refData.diamondBalance || 0) + REFER_STEP1_REWARD;

                t.update(userRef, { referStep1Claimed: true });
                t.update(refRef, {
                    diamondBalance:        FieldValue.increment(REFER_STEP1_REWARD),
                    totalInvites:          FieldValue.increment(1),
                    referralDiamondEarned: FieldValue.increment(REFER_STEP1_REWARD),
                });
            });

            await tgMsg(referrerId,
                `🎉 <b>Refer Reward — Step 1!</b>\n\n` +
                `👤 Your referral joined Coinly Task!\n\n` +
                `🥇 <b>+${REFER_STEP1_REWARD} TP</b> added to your balance!\n` +
                `💰 Value: <b>$${(REFER_STEP1_REWARD * TP_TO_USD).toFixed(3)} USDT</b>\n` +
                `🏦 New Balance: <b>${newBal} TP</b>\n\n` +
                `📋 <b>More rewards coming:</b>\n` +
                `🥈 +${REFER_STEP2_REWARD} TP when friend completes 10 tasks\n` +
                `🥉 +${REFER_STEP3_REWARD} TP when friend watches 20 ads`,
                miniAppBtn
            );

            return res.status(200).json({ success: true, reward: REFER_STEP1_REWARD, step: 1 });
        }

        // ══════════════════════════════
        // STEP 2 — Friend completed 10 tasks within 24hr
        // ══════════════════════════════
        if (stepNum === 2) {
            if (user.referStep2Claimed || user.isValidatedRef) {
                return res.status(200).json({ success: true, alreadyClaimed: true, step: 2 });
            }

            const completedTasks   = user.completedTasks   || [];
            const completedTasksAt = user.completedTasksAt || {};

            if (completedTasks.length < REFER_MIN_TASKS) {
                return res.status(400).json({
                    error: `Complete ${REFER_MIN_TASKS} tasks to unlock. Done: ${completedTasks.length}/${REFER_MIN_TASKS}`
                });
            }

            // 24hr window check
            const windowMs   = REFER_WINDOW_HR * 60 * 60 * 1000;
            const timestamps = completedTasks.map(id => completedTasksAt[id]).filter(Boolean).sort((a,b)=>a-b);
            let windowValid  = timestamps.length < REFER_MIN_TASKS
                ? completedTasks.length >= REFER_MIN_TASKS
                : false;

            for (let i = 0; i <= timestamps.length - REFER_MIN_TASKS; i++) {
                if (timestamps[i + REFER_MIN_TASKS - 1] - timestamps[i] <= windowMs) {
                    windowValid = true; break;
                }
            }
            if (!windowValid) {
                return res.status(400).json({
                    error: `Complete ${REFER_MIN_TASKS} tasks within ${REFER_WINDOW_HR} hours to qualify.`
                });
            }

            let newBal = 0, newValidRefs = 0;
            await db.runTransaction(async (t) => {
                const refRef  = db.collection('users').doc(String(referrerId));
                const refSnap = await t.get(refRef);
                if (!refSnap.exists) throw new Error('Referrer not found');
                const refData = refSnap.data();
                newBal      = (refData.diamondBalance || 0) + REFER_STEP2_REWARD;
                newValidRefs = (refData.validReferrals || 0) + 1;

                t.update(userRef, { referStep2Claimed: true, isValidatedRef: true });
                t.update(refRef, {
                    diamondBalance:        FieldValue.increment(REFER_STEP2_REWARD),
                    validReferrals:        FieldValue.increment(1),
                    referralDiamondEarned: FieldValue.increment(REFER_STEP2_REWARD),
                });
                t.set(db.collection('transactions').doc(), {
                    userId: referrerId, type: 'Refer Reward Step 2',
                    details: `Friend UID: ${uid}`, diamondAmount: REFER_STEP2_REWARD,
                    createdAt: FieldValue.serverTimestamp(),
                });
            });

            await tgMsg(referrerId,
                `🎊 <b>Refer Reward — Step 2!</b>\n\n` +
                `✅ Your referral completed <b>10 tasks</b>!\n\n` +
                `🥈 <b>+${REFER_STEP2_REWARD} TP</b> added to your balance!\n` +
                `💰 Value: <b>$${(REFER_STEP2_REWARD * TP_TO_USD).toFixed(3)} USDT</b>\n` +
                `🏦 New Balance: <b>${newBal} TP</b>\n` +
                `👥 Valid Referrals: <b>${newValidRefs}</b>\n\n` +
                `🥉 <b>One more:</b> +${REFER_STEP3_REWARD} TP when friend watches 20 ads!`,
                miniAppBtn
            );

            return res.status(200).json({ success: true, reward: REFER_STEP2_REWARD, step: 2 });
        }

        // ══════════════════════════════
        // STEP 3 — Friend watched 20 ads total
        // ══════════════════════════════
        if (stepNum === 3) {
            if (user.referStep3Claimed) {
                return res.status(200).json({ success: true, alreadyClaimed: true, step: 3 });
            }

            const totalAds = (user.adsWatchedAd1||0) + (user.adsWatchedAd2||0) +
                             (user.adsWatchedAd3||0) + (user.adsWatchedAd4||0);

            if (totalAds < REFER_MIN_ADS) {
                return res.status(400).json({
                    error: `Friend needs to watch ${REFER_MIN_ADS} ads. Watched: ${totalAds}/${REFER_MIN_ADS}`
                });
            }

            let newBal = 0;
            await db.runTransaction(async (t) => {
                const refRef  = db.collection('users').doc(String(referrerId));
                const refSnap = await t.get(refRef);
                if (!refSnap.exists) throw new Error('Referrer not found');
                const refData = refSnap.data();
                newBal = (refData.diamondBalance || 0) + REFER_STEP3_REWARD;

                t.update(userRef, { referStep3Claimed: true });
                t.update(refRef, {
                    diamondBalance:        FieldValue.increment(REFER_STEP3_REWARD),
                    referralDiamondEarned: FieldValue.increment(REFER_STEP3_REWARD),
                });
                t.set(db.collection('transactions').doc(), {
                    userId: referrerId, type: 'Refer Reward Step 3',
                    details: `Friend UID: ${uid}`, diamondAmount: REFER_STEP3_REWARD,
                    createdAt: FieldValue.serverTimestamp(),
                });
            });

            const totalEarned = REFER_STEP1_REWARD + REFER_STEP2_REWARD + REFER_STEP3_REWARD;
            await tgMsg(referrerId,
                `🏆 <b>Refer Reward — Step 3 Complete!</b>\n\n` +
                `🎯 Your referral watched <b>20 ads</b>!\n\n` +
                `🥉 <b>+${REFER_STEP3_REWARD} TP</b> added to your balance!\n` +
                `💰 Value: <b>$${(REFER_STEP3_REWARD * TP_TO_USD).toFixed(3)} USDT</b>\n` +
                `🏦 New Balance: <b>${newBal} TP</b>\n\n` +
                `✅ <b>All 3 steps complete!</b> Total earned: <b>${totalEarned} TP</b> from this referral!\n` +
                `Keep referring to earn more! 🚀`,
                miniAppBtn
            );

            return res.status(200).json({ success: true, reward: REFER_STEP3_REWARD, step: 3 });
        }

        return res.status(400).json({ error: 'Invalid step. Must be 1, 2, or 3.' });

    } catch (e) {
        console.error('[claimRefer]', e.message);
        return res.status(500).json({ error: e.message });
    }
                                    }
