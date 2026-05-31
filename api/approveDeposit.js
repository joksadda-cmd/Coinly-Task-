// api/approveDeposit.js
// Admin approves or rejects a deposit — notifies user via Telegram

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

    const { depositId, action, adminNote } = req.body || {};
    // action: 'approve' | 'reject'
    if (!depositId || !action) return res.status(400).json({ error: 'depositId and action required' });

    try {
        const depRef  = db.collection('deposits').doc(depositId);
        const depSnap = await depRef.get();
        if (!depSnap.exists) return res.status(404).json({ error: 'Deposit not found' });

        const dep = depSnap.data();
        const uid = dep.userId;
        const ton = dep.tonAmount || 0;
        const diamond = dep.expectedDiamond || 0;

        if (action === 'approve') {
            // Credit diamond to user
            await db.runTransaction(async (t) => {
                const uRef = db.collection('users').doc(String(uid));
                t.update(uRef, {
                    diamondBalance: FieldValue.increment(diamond),
                });
                t.update(depRef, {
                    status: 'approved',
                    approvedAt: FieldValue.serverTimestamp(),
                });
            });

            // Notify user
            await tgMsg(uid,
                `🎉 <b>Deposit Approved!</b>\n\n` +
                `✅ Your deposit of <b>${ton} TON</b> has been verified.\n` +
                `💎 <b>${diamond} Diamond</b> has been added to your wallet!\n\n` +
                `You can now create tasks or withdraw your earnings. 🚀`
            );

            return res.status(200).json({ success: true, action: 'approved', diamond });

        } else if (action === 'reject') {
            await depRef.update({
                status: 'rejected',
                rejectedAt: FieldValue.serverTimestamp(),
                adminNote: adminNote || '',
            });

            // Warn user
            await tgMsg(uid,
                `⚠️ <b>Deposit Request Rejected</b>\n\n` +
                `Your deposit request of <b>${ton} TON</b> could not be verified.\n\n` +
                `<b>Reason:</b> ${adminNote || 'Payment not received or invalid.'}\n\n` +
                `⚠️ <b>Warning:</b> Submitting fake deposit requests is a violation of our terms.\n` +
                `🚫 Repeated violations will result in a <b>permanent account ban</b>.\n\n` +
                `If you believe this is an error, contact support.`
            );

            return res.status(200).json({ success: true, action: 'rejected' });
        }

        return res.status(400).json({ error: 'Invalid action' });

    } catch(e) {
        console.error('[approveDeposit]', e.message);
        return res.status(500).json({ error: e.message });
    }
}
