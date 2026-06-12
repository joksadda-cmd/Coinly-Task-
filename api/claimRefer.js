// api/claimRefer.js
// Refer reward: 100 TP | Friend must complete 10 tasks within 24 hours
// Currency: TP (Task Points) — 10K TP = $1

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
const db  = getFirestore();
const BOT = process.env.BOT_TOKEN;

const REFER_REWARD    = 100;   // 100 TP per valid refer
const REFER_MIN_TASKS = 10;
const REFER_WINDOW_HR = 24;
const TP_TO_USD       = 0.0001; // 10K TP = $1

async function tgMsg(chatId, text) {
    if (!BOT || !chatId) return;
    try {
        await fetch(`https://api.telegram.org/bot${BOT}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: String(chatId), text, parse_mode: 'HTML' })
        });
    } catch(e) { console.warn('[tgMsg]', e.message); }
}

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin',  '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const { userId } = req.body || {};
    if (!userId) return res.status(400).json({ error: 'userId required' });

    const uid = String(userId);
    try {
        const userRef  = db.collection('users').doc(uid);
        const userSnap = await userRef.get();
        if (!userSnap.exists) return res.status(404).json({ error: 'User not found' });

        const user = userSnap.data();

        if (user.isValidatedRef) {
            return res.status(200).json({ success: true, alreadyClaimed: true });
        }

        const referrerId = user.referredBy;
        if (!referrerId) return res.status(400).json({ error: 'No referrer' });

        const completedTasks   = user.completedTasks   || [];
        const completedTasksAt = user.completedTasksAt || {};

        if (completedTasks.length < REFER_MIN_TASKS) {
            return res.status(400).json({
                error: `Complete ${REFER_MIN_TASKS} tasks within 24 hours. Done: ${completedTasks.length}`
            });
        }

        const windowMs = REFER_WINDOW_HR * 60 * 60 * 1000;
        const timestamps = completedTasks
            .map(id => completedTasksAt[id])
            .filter(Boolean)
            .sort((a, b) => a - b);

        let windowValid = false;
        for (let i = 0; i <= timestamps.length - REFER_MIN_TASKS; i++) {
            if (timestamps[i + REFER_MIN_TASKS - 1] - timestamps[i] <= windowMs) {
                windowValid = true; break;
            }
        }
        if (timestamps.length < REFER_MIN_TASKS) {
            windowValid = completedTasks.length >= REFER_MIN_TASKS;
        }
        if (!windowValid) {
            return res.status(400).json({
                error: `Complete ${REFER_MIN_TASKS} tasks within ${REFER_WINDOW_HR} hours to qualify.`
            });
        }

        let newReferrerBalance = 0, newValidReferrals = 0, newTpEarned = 0;

        await db.runTransaction(async (t) => {
            const referrerRef  = db.collection('users').doc(String(referrerId));
            const referrerSnap = await t.get(referrerRef);
            if (!referrerSnap.exists) throw new Error('Referrer not found');

            const referrer = referrerSnap.data();
            newReferrerBalance = (referrer.diamondBalance || 0) + REFER_REWARD;
            newValidReferrals  = (referrer.validReferrals || 0) + 1;
            newTpEarned        = (referrer.referralDiamondEarned || 0) + REFER_REWARD;

            t.update(userRef, { isValidatedRef: true });
            t.update(referrerRef, {
                diamondBalance:        FieldValue.increment(REFER_REWARD),
                validReferrals:        FieldValue.increment(1),
                referralDiamondEarned: FieldValue.increment(REFER_REWARD),
            });
            t.set(db.collection('transactions').doc(), {
                userId:        referrerId,
                type:          'Refer Reward',
                details:       `Friend UID: ${uid}`,
                diamondAmount: REFER_REWARD,
                createdAt:     FieldValue.serverTimestamp(),
            });
        });

        const usdtValue = (REFER_REWARD * TP_TO_USD).toFixed(3);
        await tgMsg(referrerId,
            `🎉 <b>Refer Reward!</b>\n\n` +
            `Your referral (UID: <code>${uid}</code>) completed ${REFER_MIN_TASKS} tasks within ${REFER_WINDOW_HR} hours!\n\n` +
            `💎 <b>+${REFER_REWARD} TP</b> added!\n` +
            `💵 Value: <b>$${usdtValue} USDT</b>\n` +
            `🏦 New Balance: <b>${newReferrerBalance} TP</b>\n\n` +
            `Keep referring! 🚀`
        );

        return res.status(200).json({
            success: true,
            reward:  REFER_REWARD,
            referrerNewBalance: newReferrerBalance,
            referrerValidRefs:  newValidReferrals,
        });

    } catch (e) {
        console.error('[claimRefer]', e.message);
        return res.status(500).json({ error: e.message });
    }
                }
