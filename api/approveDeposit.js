// api/approveDeposit.js
// Handles: deposit approve/reject + withdraw approve/reject/fake
// Wallet address lock: 30 days per account

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
const APP_URL = process.env.APP_URL || 'https://coinly-task.vercel.app';

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

const miniAppBtn = {
    reply_markup: {
        inline_keyboard: [[
            { text: '🚀 Open Coinly Task', web_app: { url: APP_URL } }
        ]]
    }
};

function addrKey(address) {
    return Buffer.from(address).toString('base64').replace(/[/+=]/g, '_').slice(0, 100);
}

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin',  '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const { depositId, withdrawId, action, adminNote, warningCount, permBan } = req.body || {};

    // ════════════════════════════════════════════
    // WITHDRAW APPROVE / REJECT / FAKE
    // ════════════════════════════════════════════
    if (withdrawId) {
        if (!action) return res.status(400).json({ error: 'action required' });

        try {
            const wRef  = db.collection('withdrawals').doc(String(withdrawId));
            const wSnap = await wRef.get();
            if (!wSnap.exists) return res.status(404).json({ error: 'Withdrawal not found' });

            const wd  = wSnap.data();
            const uid = String(wd.userId);
            const tp  = wd.diamondAmount || 0;
            const methodLabel = wd.method === 'binance' ? 'Binance USDT' : 'Tonkeeper TON';
            const converted   = wd.method === 'binance'
                ? `$${(tp * 0.00005).toFixed(3)} USDT`
                : `${(tp * 0.000025).toFixed(4)} TON`;

            // ── APPROVE ──
            if (action === 'approve') {
                await wRef.update({
                    status:     'completed',
                    approvedAt: FieldValue.serverTimestamp(),
                    adminNote:  adminNote || '',
                });
                await tgMsg(uid,
                    `✅ <b>Withdrawal Successfully Sent!</b>\n\n` +
                    `🎉 Your withdrawal has been processed!\n\n` +
                    `💎 <b>${tp} TP</b> withdrawn\n` +
                    `💰 <b>Amount sent: ${converted}</b>\n` +
                    `📬 Method: <b>${methodLabel}</b>\n` +
                    `📮 Address: <code>${wd.details || 'N/A'}</code>\n\n` +
                    `⏱️ May take a few minutes to reflect in your wallet.\n` +
                    `🆔 Request ID: <code>${withdrawId}</code>`,
                    miniAppBtn
                );
                return res.status(200).json({ success: true, action: 'approved', withdrawId });
            }

            // ── REJECT WITH REFUND ──
            if (action === 'reject') {
                const uRef = db.collection('users').doc(uid);
                await db.runTransaction(async (t) => {
                    t.update(uRef, { diamondBalance: FieldValue.increment(tp) });
                    t.update(wRef, {
                        status:     'rejected',
                        rejectedAt: FieldValue.serverTimestamp(),
                        adminNote:  adminNote || '',
                        refunded:   true,
                    });
                });
                await tgMsg(uid,
                    `❌ <b>Withdrawal Rejected</b>\n\n` +
                    `Your withdrawal request has been rejected.\n\n` +
                    `💎 <b>${tp} TP</b> has been refunded to your balance.\n` +
                    `📋 Reason: ${adminNote || 'Please contact support.'}\n\n` +
                    `You can try withdrawing again. 🔄`,
                    miniAppBtn
                );
                return res.status(200).json({ success: true, action: 'rejected', withdrawId, refunded: tp });
            }

            // ── FAKE — NO REFUND ──
            if (action === 'reject_no_refund') {
                await wRef.update({
                    status:     'rejected_fake',
                    rejectedAt: FieldValue.serverTimestamp(),
                    adminNote:  adminNote || 'Fake withdrawal attempt',
                    refunded:   false,
                });
                await tgMsg(uid,
                    `🚫 <b>Withdrawal Rejected — Fake Attempt</b>\n\n` +
                    `Your withdrawal request of <b>${tp} TP</b> has been rejected.\n\n` +
                    `⚠️ This was flagged as a <b>fraudulent request</b>.\n` +
                    `❌ <b>No TP has been refunded.</b>\n\n` +
                    `Repeated fake attempts may result in account ban.\n` +
                    `Contact support if you believe this is a mistake.`,
                    miniAppBtn
                );
                return res.status(200).json({ success: true, action: 'rejected_fake', withdrawId });
            }

            return res.status(400).json({ error: 'Invalid action for withdraw' });

        } catch(e) {
            console.error('[approveDeposit withdraw]', e.message);
            return res.status(500).json({ error: e.message });
        }
    }

    // ════════════════════════════════════════════
    // DEPOSIT APPROVE / REJECT
    // ════════════════════════════════════════════
    if (!depositId || !action) return res.status(400).json({ error: 'depositId and action required' });

    try {
        const depRef  = db.collection('deposits').doc(depositId);
        const depSnap = await depRef.get();
        if (!depSnap.exists) return res.status(404).json({ error: 'Deposit not found' });

        const dep = depSnap.data();
        const uid = String(dep.userId);
        const ton = dep.tonAmount || 0;

        if (dep.status === 'auto_approved' && action === 'approve') {
            return res.status(200).json({
                success: false,
                alreadyApproved: true,
                message: 'Already auto-approved via blockchain.'
            });
        }

        if (action === 'approve') {
            await db.runTransaction(async (t) => {
                const uRef = db.collection('users').doc(uid);
                t.update(uRef, { tonBalance: FieldValue.increment(ton) });
                t.update(depRef, {
                    status:        'approved',
                    approvedAt:    FieldValue.serverTimestamp(),
                    manualApproval: true,
                });
            });
            await tgMsg(uid,
                `🎉 <b>Deposit Approved!</b>\n\n` +
                `✅ Your deposit of <b>${ton} TON</b> has been verified.\n` +
                `💰 <b>${ton} TON</b> added to your TON balance!\n\n` +
                `💎 Earn TP by completing tasks & watching ads.`,
                miniAppBtn
            );
            return res.status(200).json({ success: true, action: 'approved', ton });
        }

        if (action === 'reject') {
            const warns    = parseInt(warningCount) || 1;
            const isBanned = permBan === true;
            const uRef = db.collection('users').doc(uid);
            if (isBanned) {
                await uRef.update({ depositBanned: true, depositWarnings: 3 });
            } else {
                await uRef.update({ depositWarnings: warns });
            }
            await depRef.update({
                status:     'rejected',
                rejectedAt: FieldValue.serverTimestamp(),
                adminNote:  adminNote || '',
                warns, permBan: isBanned,
            });
            let userMsg = isBanned
                ? `🚫 <b>Deposit Permanently Disabled</b>\n\nYour deposit of <b>${ton} TON</b> rejected.\n⛔ 3rd violation — deposit permanently disabled.`
                : warns >= 2
                    ? `🚨 <b>Deposit Rejected — FINAL WARNING (${warns}/3)</b>\n\nYour deposit of <b>${ton} TON</b> rejected.\n⚠️ One more fake = permanent ban.\nReason: ${adminNote || 'Invalid.'}`
                    : `⚠️ <b>Deposit Rejected — Warning ${warns}/3</b>\n\nYour deposit of <b>${ton} TON</b> rejected.\n🔴 ${3-warns} more violation(s) = permanent ban.\nReason: ${adminNote || 'Invalid.'}`;
            await tgMsg(uid, userMsg, miniAppBtn);
            return res.status(200).json({ success: true, action: 'rejected', warns, isBanned });
        }

        return res.status(400).json({ error: 'Invalid action' });

    } catch(e) {
        console.error('[approveDeposit]', e.message);
        return res.status(500).json({ error: e.message });
    }
                    }
