// api/approveDeposit.js
// Admin approves or rejects a deposit — handles warning system & deposit ban
// Auto-approved deposits (blockchain-verified) don't need admin action

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

    const { depositId, action, adminNote, warningCount, permBan } = req.body || {};
    if (!depositId || !action) return res.status(400).json({ error: 'depositId and action required' });

    try {
        const depRef  = db.collection('deposits').doc(depositId);
        const depSnap = await depRef.get();
        if (!depSnap.exists) return res.status(404).json({ error: 'Deposit not found' });

        const dep = depSnap.data();
        const uid = String(dep.userId);
        const ton = dep.tonAmount || 0;

        // ── Already auto-approved — skip ──
        if (dep.status === 'auto_approved' && action === 'approve') {
            return res.status(200).json({
                success: false,
                alreadyApproved: true,
                message: 'This deposit was already auto-approved via blockchain verification.'
            });
        }

        // ════════════════════════════════════════════
        // APPROVE (manual — for pending deposits only)
        // ════════════════════════════════════════════
        if (action === 'approve') {
            await db.runTransaction(async (t) => {
                const uRef = db.collection('users').doc(uid);
                t.update(uRef, { tonBalance: FieldValue.increment(ton) });
                t.update(depRef, {
                    status:     'approved',
                    approvedAt: FieldValue.serverTimestamp(),
                    manualApproval: true,
                });
            });

            await tgMsg(uid,
                `🎉 <b>Deposit Approved!</b>\n\n` +
                `✅ Your deposit of <b>${ton} TON</b> has been verified by admin.\n` +
                `💰 <b>${ton} TON</b> added to your TON balance!\n` +
                `You can now create tasks. 🚀\n\n` +
                `💎 Earn Diamond by completing tasks & watching ads.`
            );

            return res.status(200).json({ success: true, action: 'approved', ton });
        }

        // ════════════════════════════════════════════
        // REJECT with warning system
        // ════════════════════════════════════════════
        if (action === 'reject') {
            const warns    = parseInt(warningCount) || 1;
            const isBanned = permBan === true;

            // Update user warnings in Firestore
            const uRef = db.collection('users').doc(uid);
            if (isBanned) {
                await uRef.update({
                    depositBanned:   true,
                    depositWarnings: 3,
                });
            } else {
                await uRef.update({
                    depositWarnings: warns,
                });
            }

            // Update deposit status
            await depRef.update({
                status:     'rejected',
                rejectedAt: FieldValue.serverTimestamp(),
                adminNote:  adminNote || '',
                warns,
                permBan:    isBanned,
            });

            // Build user Telegram message
            let userMsg = '';
            if (isBanned) {
                userMsg =
                    `🚫 <b>Deposit Section Permanently Disabled</b>\n\n` +
                    `Your deposit request of <b>${ton} TON</b> has been rejected.\n\n` +
                    `⛔ <b>This was your 3rd fake deposit violation.</b>\n` +
                    `Your deposit section has been <b>permanently disabled</b>.\n\n` +
                    `You can still earn Diamond by completing tasks & watching ads, ` +
                    `but you will <b>never be able to deposit again</b>.\n\n` +
                    `If you believe this is a mistake, contact support.`;
            } else if (warns >= 2) {
                userMsg =
                    `🚨 <b>Deposit Rejected — FINAL WARNING (${warns}/3)</b>\n\n` +
                    `Your deposit request of <b>${ton} TON</b> has been rejected.\n\n` +
                    `⚠️ This is your <b>FINAL WARNING</b>.\n` +
                    `One more fake request = <b>permanent deposit ban, no appeal</b>.\n\n` +
                    `<b>Reason:</b> ${adminNote || 'Payment not received or invalid.'}`;
            } else {
                userMsg =
                    `⚠️ <b>Deposit Rejected — Warning ${warns}/3</b>\n\n` +
                    `Your deposit request of <b>${ton} TON</b> has been rejected.\n\n` +
                    `Submitting fake deposit requests violates our terms.\n` +
                    `🔴 <b>${3 - warns} more violation(s)</b> = permanent deposit ban.\n\n` +
                    `<b>Reason:</b> ${adminNote || 'Payment not received or invalid.'}`;
            }

            await tgMsg(uid, userMsg);
            return res.status(200).json({ success: true, action: 'rejected', warns, isBanned });
        }

        return res.status(400).json({ error: 'Invalid action' });

    } catch(e) {
        console.error('[approveDeposit]', e.message);
        return res.status(500).json({ error: e.message });
    }
}
