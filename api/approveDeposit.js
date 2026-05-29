// api/approveDeposit.js
// Admin approves a deposit → adds diamond to user account

import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';

const BOT_TOKEN = process.env.BOT_TOKEN;

function getAdminApp() {
    if (getApps().length > 0) return getApps()[0];
    return initializeApp({
        credential: cert({
            projectId:   process.env.FIREBASE_PROJECT_ID,
            clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
            privateKey:  process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
        }),
    });
}

async function sendMsg(chatId, text) {
    if (!BOT_TOKEN || !chatId) return;
    try {
        await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
        });
    } catch(e) {}
}

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const { depositId, userId, diamondAmount } = req.body || {};
    if (!depositId || !userId || !diamondAmount) {
        return res.status(400).json({ ok: false, error: 'missing_fields' });
    }

    try {
        const app = getAdminApp();
        const db  = getFirestore(app);

        const depositRef = db.collection('deposits').doc(String(depositId));
        const userRef    = db.collection('users').doc(String(userId));

        await db.runTransaction(async (t) => {
            const depSnap = await t.get(depositRef);
            if (!depSnap.exists) throw new Error('deposit_not_found');
            if (depSnap.data().status === 'approved') throw new Error('already_approved');

            t.update(depositRef, {
                status:     'approved',
                approvedAt: FieldValue.serverTimestamp(),
            });
            t.update(userRef, {
                diamondBalance: FieldValue.increment(Number(diamondAmount)),
                totalEarned:    FieldValue.increment(Number(diamondAmount)),
            });
        });

        // Notify user
        await sendMsg(userId,
`✅ <b>Deposit Approved!</b>

💎 <b>+${diamondAmount} Diamond</b> added to your account!

You can now use Diamond to create tasks or withdraw.`
        );

        return res.status(200).json({ ok: true, diamondAmount });

    } catch(err) {
        if (err.message === 'already_approved') {
            return res.status(200).json({ ok: false, error: 'already_approved' });
        }
        console.error('[approveDeposit]', err);
        return res.status(500).json({ ok: false, error: 'server_error', message: err.message });
    }
}
