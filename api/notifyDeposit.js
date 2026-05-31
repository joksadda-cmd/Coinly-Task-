// api/notifyDeposit.js
// Handles: deposit request, withdrawal request, task payment — saves + notifies

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
const db      = getFirestore();
const BOT     = process.env.BOT_TOKEN;
const ADMIN_ID = process.env.ADMIN_TELEGRAM_ID;

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

    const body = req.body || {};
    const type = body.type || 'deposit'; // deposit | withdrawal | task_payment

    // ── WITHDRAWAL ──
    if (type === 'withdrawal') {
        const { userId, username, firstName, method, address, diamondAmount, tonAmount } = body;
        if (!userId || !diamondAmount || !address) {
            return res.status(400).json({ error: 'Missing fields' });
        }
        const amt = parseFloat(diamondAmount);
        const uid = String(userId);
        try {
            let newBalance = 0, withdrawId = '';
            await db.runTransaction(async (t) => {
                const uRef  = db.collection('users').doc(uid);
                const uSnap = await t.get(uRef);
                if (!uSnap.exists) throw new Error('User not found');
                const user = uSnap.data();
                if ((user.diamondBalance || 0) < amt) throw new Error('Insufficient balance');
                newBalance = (user.diamondBalance || 0) - amt;
                const wRef = db.collection('withdrawals').doc();
                withdrawId = wRef.id;
                t.set(wRef, {
                    userId: uid, username: username||'', firstName: firstName||'',
                    method: method||'tonkeeper', details: address,
                    diamondAmount: amt, tonAmount: parseFloat(tonAmount)||0,
                    status: 'pending', createdAt: FieldValue.serverTimestamp(),
                });
                t.update(uRef, { diamondBalance: FieldValue.increment(-amt) });
            });

            // User notification
            await tgMsg(uid,
                `✅ <b>Withdrawal Received!</b>\n\n` +
                `💎 <b>${amt} Diamond</b> → <b>${tonAmount} TON</b>\n` +
                `📬 Method: ${method}\n📍 Address: <code>${address}</code>\n\n` +
                `⏳ Pending admin review. You'll be notified once processed.`
            );
            // Admin notification
            await tgMsg(ADMIN_ID,
                `🔴 <b>Withdrawal Request</b>\n` +
                `👤 ${firstName||''} (@${username||'N/A'}) [<code>${uid}</code>]\n` +
                `💎 ${amt} Diamond → ${tonAmount} TON\n` +
                `📬 ${method}: <code>${address}</code>\n` +
                `🆔 ID: <code>${withdrawId}</code>`
            );
            return res.status(200).json({ success: true, newBalance, withdrawId });
        } catch(e) {
            return res.status(200).json({ success: false, error: e.message });
        }
    }

    // ── BROADCAST (admin sends message to all users) ──
    if (type === 'broadcast') {
        const { message, adminKey } = body;
        if (adminKey !== process.env.FIREBASE_PROJECT_ID) {
            return res.status(403).json({ error: 'Unauthorized' });
        }
        if (!message) return res.status(400).json({ error: 'message required' });
        try {
            // Get all user IDs
            const usersSnap = await db.collection('users').select('id').limit(500).get();
            let sent = 0, failed = 0;
            const promises = [];
            usersSnap.forEach(d => {
                promises.push(
                    tgMsg(d.id, `📢 <b>Announcement</b>\n\n${message}`)
                        .then(()=>sent++)
                        .catch(()=>failed++)
                );
            });
            await Promise.allSettled(promises);
            return res.status(200).json({ success: true, sent, failed });
        } catch(e) {
            return res.status(500).json({ error: e.message });
        }
    }

    // ── DEPOSIT / TASK PAYMENT ──
    const { userId, username, firstName, tonAmount, expectedDiamond, memo, taskTitle } = body;
    if (!userId) return res.status(400).json({ error: 'userId required' });
    const uid = String(userId);

    try {
        // Save deposit record
        const collection_name = type === 'task_payment' ? 'task_payments' : 'deposits';
        const docRef = await db.collection(collection_name).add({
            userId: uid, username: username||'', firstName: firstName||'',
            tonAmount: parseFloat(tonAmount)||0,
            expectedDiamond: parseInt(expectedDiamond)||0,
            memo: memo||uid, status: 'pending',
            type: type||'deposit',
            createdAt: FieldValue.serverTimestamp(),
            ...(taskTitle ? { taskTitle } : {}),
        });

        // Admin notification
        const isTask = type === 'task_payment';
        await tgMsg(ADMIN_ID,
            `${isTask ? '🟡 <b>Task Payment' : '🟢 <b>Deposit Request'}</b>\n` +
            `👤 ${firstName||''} (@${username||'N/A'}) [<code>${uid}</code>]\n` +
            `💰 ${tonAmount} TON${isTask ? ` (${taskTitle||''})` : ''}\n` +
            `💎 Expected: ${expectedDiamond} Diamond\n` +
            `📝 Memo: <code>${memo||uid}</code>\n` +
            `🆔 ID: <code>${docRef.id}</code>`
        );

        // User confirmation
        await tgMsg(uid,
            `${isTask ? '🟡 <b>Task Payment Received!' : '🟢 <b>Deposit Request Submitted!'}</b>\n\n` +
            `💰 ${tonAmount} TON\n` +
            (isTask ? `📋 Task: ${taskTitle||''}\n` : `💎 Expected: ${expectedDiamond} Diamond\n`) +
            `\n⏳ Admin will review and approve shortly.\n` +
            `⚠️ Fake requests = permanent account ban.`
        );

        return res.status(200).json({ success: true, depositId: docRef.id });
    } catch(e) {
        console.error('[notifyDeposit]', e.message);
        return res.status(500).json({ error: e.message });
    }
                    }
