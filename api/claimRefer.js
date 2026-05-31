// api/claimRefer.js — refer reward + Telegram notification to referrer

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

const REFER_REWARD    = 5;
const REFER_MIN_TASKS = 10;
const DIAMOND_TO_TON  = 0.0005;

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
        if (user.isValidatedRef) return res.status(200).json({ success: true, alreadyClaimed: true });

        const referrerId = user.referredBy;
        if (!referrerId) return res.status(400).json({ error: 'No referrer' });

        const completedTasks = user.completedTasks || [];
        if (completedTasks.length < REFER_MIN_TASKS) {
            return res.status(400).json({ error: `Need ${REFER_MIN_TASKS} tasks. Done: ${completedTasks.length}` });
        }

        await db.runTransaction(async (t) => {
            const referrerRef  = db.collection('users').doc(String(referrerId));
            const referrerSnap = await t.get(referrerRef);
            if (!referrerSnap.exists) throw new Error('Referrer not found');

            t.update(userRef, { isValidatedRef: true });
            t.update(referrerRef, {
                diamondBalance:        FieldValue.increment(REFER_REWARD),
                validReferrals:        FieldValue.increment(1),
                referralDiamondEarned: FieldValue.increment(REFER_REWARD),
            });
            t.set(db.collection('transactions').doc(), {
                userId:    referrerId,
                type:      'Refer Reward',
                details:   `Friend UID: ${uid}`,
                diamondAmount: REFER_REWARD,
                createdAt: FieldValue.serverTimestamp(),
            });
        });

        // Referrer কে Telegram notification
        const tonValue = (REFER_REWARD * DIAMOND_TO_TON).toFixed(4);
        await tgMsg(referrerId,
            `🎉 <b>Refer Successful!</b>\n\n` +
            `Your referral (UID: <code>${uid}</code>) has completed ${REFER_MIN_TASKS} tasks!\n\n` +
            `💎 You earned: <b>${REFER_REWARD} Diamond</b>\n` +
            `💰 Value: <b>${tonValue} TON</b>\n\n` +
            `Keep referring to earn more! 🚀`
        );

        return res.status(200).json({ success: true, reward: REFER_REWARD });
    } catch (e) {
        console.error('[claimRefer]', e.message);
        return res.status(500).json({ error: e.message });
    }
}
