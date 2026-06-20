// api/notifyDeposit.js
// Currency: TP (Task Points) — 20K TP = $1 = 0.5 TON
// Withdrawal: daily 1x limit | Tonkeeper min 1000 TP | Binance min 2000 TP
//
// Deposit / task_payment / task_create removed — tasks are now created
// manually via the admin panel, there is no user-facing TON deposit flow.
//
// MERGED FROM approveDeposit.js: withdraw approve/reject/fake-reject logic now
// lives here too (see "WITHDRAW APPROVE/REJECT" section below), distinguished
// by the request body containing `withdrawId` (no `type` field needed — this
// is exactly what the admin panel already sends). This was merged in rather
// than kept as a separate file to stay at 12 total API files — Vercel's Hobby
// plan hard-caps a deployment at 12 Serverless Functions, and this project was
// already at that limit. The admin panel's call target was updated to point
// here (/api/notifyDeposit) instead of /api/approveDeposit.

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
const db       = getFirestore();
const BOT      = process.env.BOT_TOKEN;
const ADMIN_ID = process.env.ADMIN_TELEGRAM_ID;
const APP_URL  = process.env.APP_URL || 'https://coinly-task.vercel.app';

// TP rate constants
const TP_TO_TON = 0.000025;  // 20000 TP = 0.5 TON
const TP_TO_USD = 0.00005;   // 20000 TP = $1

const MIN_WITHDRAW = { tonkeeper: 1000, binance: 2000 };

const TODAY_DHAKA = () =>
    new Date().toLocaleDateString('en-US', { timeZone: 'Asia/Dhaka' });

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

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin',  '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const body = req.body || {};

    // ════════════════════════════════════
    // WITHDRAW APPROVE / REJECT / FAKE (admin action — called from admin panel)
    // Distinguished from everything else by the presence of withdrawId, which
    // only the admin panel sends; the user-facing withdrawal-creation flow
    // below (type === 'withdrawal') never includes it.
    // ════════════════════════════════════
    if (body.withdrawId) {
        const { withdrawId, action, adminNote } = body;
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
                ? `$${(tp * TP_TO_USD).toFixed(3)} USDT`
                : `${(tp * TP_TO_TON).toFixed(4)} TON`;

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
            console.error('[notifyDeposit withdraw-action]', e.message);
            return res.status(500).json({ error: e.message });
        }
    }

    const type = body.type;

    // ════════════════════════════════════
    // WITHDRAWAL — TP currency, daily 1x (user-facing — creates a request)
    // ════════════════════════════════════
    if (type === 'withdrawal') {
        const { userId, username, firstName, method, address, diamondAmount } = body;
        if (!userId || !diamondAmount || !address) {
            return res.status(400).json({ error: 'Missing fields' });
        }
        if (method === 'bkash') {
            return res.status(400).json({ success: false, error: 'bKash withdrawals are no longer supported.' });
        }

        const amt     = parseFloat(diamondAmount);
        const uid     = String(userId);
        const today   = TODAY_DHAKA();
        const minAmt  = MIN_WITHDRAW[method] || 300;

        if (isNaN(amt) || amt < minAmt) {
            return res.status(200).json({ success: false, error: `Minimum ${minAmt} TP required for ${method}.` });
        }

        // ── Address lock check — 30 days per account ──
        try {
            const key      = Buffer.from(address).toString('base64').replace(/[/+=]/g, '_').slice(0, 100);
            const addrSnap = await db.collection('withdrawAddresses').doc(key).get();
            if (addrSnap.exists) {
                const lockData      = addrSnap.data();
                const registeredUid = lockData.userId;
                const lockedUntilMs = lockData.lockedUntil?._seconds
                    ? lockData.lockedUntil._seconds * 1000
                    : (lockData.lockedUntilMs || 0);

                if (registeredUid && registeredUid !== uid && lockedUntilMs > Date.now()) {
                    const daysLeft = Math.ceil((lockedUntilMs - Date.now()) / (1000*60*60*24));
                    await tgMsg(ADMIN_ID,
                        `🚨 <b>Address Reuse Blocked</b>\n` +
                        `User: ${uid} (@${username||'N/A'})\n` +
                        `Address locked to: <code>${registeredUid}</code>\n` +
                        `Lock expires in: ${daysLeft} days\n` +
                        `Address: <code>${address}</code>`
                    );
                    return res.status(200).json({
                        success: false,
                        error: `🚫 This wallet address is already in use by another account.\n\nOne wallet address can only receive payments for ONE account. You cannot withdraw to the same wallet from two different accounts.\n\nThis address will remain locked for ${daysLeft} more day(s). Please use a different wallet address.`
                    });
                }
            }
        } catch(e) { console.warn('[address-check]', e.message); }

        // ── Main withdrawal transaction — wrapped in its own try-catch ──
        try {
            let newBalance = 0, withdrawId = '', serverTonAmount = 0;
            await db.runTransaction(async (t) => {
                const uRef  = db.collection('users').doc(uid);
                const uSnap = await t.get(uRef);
                if (!uSnap.exists) throw new Error('User not found');
                const user = uSnap.data();

                if ((user.diamondBalance || 0) < amt) throw new Error('Insufficient TP balance');

                // ── Withdraw ban check ──
                if (user.withdrawBanned) {
                    throw new Error('Your account has been permanently banned from withdrawals.');
                }

                // ── Daily 1x withdraw limit ──
                if (user.lastWithdrawDate === today) {
                    throw new Error('You can only withdraw once per day. Try again tomorrow.');
                }

                newBalance = (user.diamondBalance || 0) - amt;
                // Calculate conversion server-side — never trust client tonAmount
                serverTonAmount = method === 'binance'
                    ? parseFloat((amt * TP_TO_USD).toFixed(4))
                    : parseFloat((amt * TP_TO_TON).toFixed(6));

                const wRef = db.collection('withdrawals').doc();
                withdrawId = wRef.id;
                t.set(wRef, {
                    userId: uid, username: username||'', firstName: firstName||'',
                    method: method||'tonkeeper', details: address,
                    diamondAmount: amt, tonAmount: serverTonAmount,
                    status: 'pending', createdAt: FieldValue.serverTimestamp(),
                });
                const newAdsCount = (user.adsWatchedAd1||0)+(user.adsWatchedAd2||0)+
                    (user.adsWatchedAd3||0)+(user.adsWatchedAd4||0);
                t.update(uRef, {
                    diamondBalance:        FieldValue.increment(-amt),
                    lastWithdrawDate:      today,
                    _lastWithdrawAdsCount: newAdsCount,
                });

                // ── Lock wallet address to this userId for 30 days ──
                const addrKey = Buffer.from(address).toString('base64').replace(/[/+=]/g, '_').slice(0, 100);
                const lockedUntilMs = Date.now() + (30 * 24 * 60 * 60 * 1000); // 30 days
                t.set(db.collection('withdrawAddresses').doc(addrKey), {
                    userId:         uid,
                    address,
                    method,
                    lockedUntilMs,
                    lockedUntil:    new Date(lockedUntilMs),
                    registeredAt:   FieldValue.serverTimestamp(),
                }, { merge: true });
            });

            // ── Notifications — wrapped separately so a Telegram failure never breaks the response ──
            try {
                await tgMsg(ADMIN_ID,
                    `🔴 <b>Withdrawal Request</b>\n` +
                    `👤 ${firstName||''} (@${username||'N/A'}) [<code>${uid}</code>]\n` +
                    `💎 ${amt} TP → ${method==='binance'?'$':''}${serverTonAmount} ${method==='binance'?'USDT':'TON'}\n` +
                    `📬 ${method==='binance'?'Binance':'Tonkeeper'}: <code>${address}</code>\n` +
                    `🆔 ID: <code>${withdrawId}</code>`
                );
                await tgMsg(uid,
                    `✅ <b>Withdrawal Request Received!</b>\n\n` +
                    `💎 <b>${amt} TP</b> deducted from your balance.\n` +
                    `💰 You will receive: <b>${method==='binance'?'$':''}${serverTonAmount} ${method==='binance'?'USDT':'TON'}</b>\n` +
                    `📬 Method: <b>${method==='binance'?'Binance':'Tonkeeper'}</b>\n` +
                    `📮 Address: <code>${address}</code>\n\n` +
                    `⏱️ Processing time: <b>1–24 hours</b>\n` +
                    `🆔 Request ID: <code>${withdrawId}</code>\n\n` +
                    `You will receive another notification when completed. 🚀`
                );
            } catch(notifyErr) {
                console.warn('[withdraw-notify]', notifyErr.message);
            }

            return res.status(200).json({ success: true, newBalance, withdrawId });
        } catch(e) {
            console.error('[withdraw]', e.message);
            return res.status(200).json({ success: false, error: e.message });
        }
    }

    // ════════════════════════════════════
    // BROADCAST
    // ════════════════════════════════════
    if (type === 'broadcast') {
        const { message, adminKey } = body;
        if (adminKey !== process.env.FIREBASE_PROJECT_ID) {
            return res.status(403).json({ error: 'Unauthorized' });
        }
        if (!message) return res.status(400).json({ error: 'message required' });
        try {
            const usersSnap = await db.collection('users').select('id').limit(500).get();
            let sent = 0, failed = 0;
            const promises = [];
            usersSnap.forEach(d => {
                promises.push(
                    tgMsg(d.id, `📢 <b>Announcement</b>\n\n${message}`)
                        .then(()=>sent++).catch(()=>failed++)
                );
            });
            await Promise.allSettled(promises);
            return res.status(200).json({ success: true, sent, failed });
        } catch(e) {
            return res.status(500).json({ error: e.message });
        }
    }

    // Deposit / task_payment / task_create no longer exist on this endpoint.
    return res.status(400).json({ error: 'Invalid request type' });
                        }
