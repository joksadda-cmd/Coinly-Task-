// api/notifyDeposit.js
// Handles: deposit request (with TON auto-verify), withdrawal, task payment, broadcast
// TON auto-verify: checks blockchain before saving as pending — eliminates fake requests

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

// ── Telegram message helper ──
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

// ── TON Blockchain auto-verify ──
// Checks last 20 transactions of DEPOSIT_WALLET via TON Center API
// Returns matched transaction or null
async function checkTonTransaction(userId, expectedTon) {
    try {
        const wallet = process.env.DEPOSIT_WALLET;
        const apiKey = process.env.TON_API_KEY;
        if (!wallet || !apiKey) return null;

        const url = `https://toncenter.com/api/v2/getTransactions?address=${wallet}&limit=20&api_key=${apiKey}`;
        const response = await fetch(url, { signal: AbortSignal.timeout(8000) });
        if (!response.ok) return null;

        const data = await response.json();
        if (!data.ok || !Array.isArray(data.result)) return null;

        // Accept tx within last 10 minutes
        const nanoExpected = Math.floor(parseFloat(expectedTon) * 1e9);
        const tenMinAgo    = Math.floor(Date.now() / 1000) - 600;

        const match = data.result.find(tx => {
            const msg = tx.in_msg;
            if (!msg) return false;
            const comment   = (msg.message || msg.comment || '').trim();
            const value     = parseInt(msg.value || 0);
            const timestamp = tx.utime || 0;
            // memo must match userId, amount must be >= expected, within last 10 min
            return comment === String(userId) &&
                   value   >= nanoExpected    &&
                   timestamp >= tenMinAgo;
        });

        return match || null;
    } catch(e) {
        console.warn('[checkTonTransaction]', e.message);
        return null;
    }
}

// ── Main handler ──
export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin',  '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const body = req.body || {};
    const type = body.type || 'deposit';

    // ════════════════════════════════════════════
    // WITHDRAWAL
    // ════════════════════════════════════════════
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
                const newAdsCount = (user.adsWatchedAd1||0)+(user.adsWatchedAd2||0)+
                    (user.adsWatchedAd3||0)+(user.adsWatchedAd4||0);
                t.update(uRef, {
                    diamondBalance: FieldValue.increment(-amt),
                    _lastWithdrawAdsCount: newAdsCount,
                });
            });

            const currLabel = method === 'bkash' ? 'BDT' : method === 'binance' ? 'USD' : 'TON';
            const currIcon  = method === 'bkash' ? '৳'   : method === 'binance' ? '$'   : '';

            await tgMsg(ADMIN_ID,
                `🔴 <b>Withdrawal Request</b>\n` +
                `👤 ${firstName||''} (@${username||'N/A'}) [<code>${uid}</code>]\n` +
                `💎 ${amt} Diamond → ${currIcon}${tonAmount} ${currLabel}\n` +
                `📬 ${method}: <code>${address}</code>\n` +
                `🆔 ID: <code>${withdrawId}</code>`
            );
            return res.status(200).json({ success: true, newBalance, withdrawId });
        } catch(e) {
            return res.status(200).json({ success: false, error: e.message });
        }
    }

    // ════════════════════════════════════════════
    // BROADCAST
    // ════════════════════════════════════════════
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

    // ════════════════════════════════════════════
    // DEPOSIT (with TON auto-verify)
    // ════════════════════════════════════════════
    const { userId, username, firstName, tonAmount, expectedDiamond, memo, taskTitle } = body;
    if (!userId) return res.status(400).json({ error: 'userId required' });
    const uid = String(userId);

    // ── Server-side ban check ──
    if (type === 'deposit' || type === 'task_payment') {
        try {
            const uSnap = await db.collection('users').doc(uid).get();
            if (uSnap.exists) {
                const userData = uSnap.data();

                if (userData.isBanned === true) {
                    return res.status(403).json({ success: false, banned: true, error: 'Account is banned.' });
                }

                if (type === 'deposit' && userData.depositBanned === true) {
                    await tgMsg(ADMIN_ID,
                        `🚨 <b>Deposit Ban Bypass Attempt!</b>\n` +
                        `👤 ${firstName||''} (@${username||'N/A'}) [<code>${uid}</code>]\n` +
                        `💰 Tried: ${tonAmount} TON — BLOCKED`
                    );
                    return res.status(403).json({
                        success: false, depositBanned: true,
                        error: 'Your deposit access has been permanently disabled.'
                    });
                }

                body._warnCount = userData.depositWarnings || 0;
            }
        } catch(e) { console.warn('[ban-check]', e.message); }
    }

    // ════════════════════════════════════════════
    // TON AUTO-VERIFY (deposit only)
    // ════════════════════════════════════════════
    if (type === 'deposit') {
        const ton = parseFloat(tonAmount) || 0;
        if (ton <= 0) return res.status(400).json({ error: 'Invalid TON amount' });

        // Check blockchain
        const matchedTx = await checkTonTransaction(uid, ton);

        if (matchedTx) {
            // ── TRANSACTION FOUND → Auto-approve ──
            try {
                const diamond = parseInt(expectedDiamond) || Math.floor(ton * 2000);

                await db.runTransaction(async (t) => {
                    const uRef   = db.collection('users').doc(uid);
                    const depRef = db.collection('deposits').doc();
                    t.set(depRef, {
                        userId: uid, username: username||'', firstName: firstName||'',
                        tonAmount: ton, expectedDiamond: diamond,
                        memo: memo || uid,
                        status: 'auto_approved',
                        autoVerified: true,
                        txHash: matchedTx.transaction_id?.hash || '',
                        createdAt: FieldValue.serverTimestamp(),
                        approvedAt: FieldValue.serverTimestamp(),
                    });
                    t.update(uRef, {
                        tonBalance: FieldValue.increment(ton),
                        pendingDeposit: false,
                    });
                });

                // Notify user
                await tgMsg(uid,
                    `✅ <b>Deposit Auto-Verified!</b>\n\n` +
                    `💰 <b>${ton} TON</b> confirmed on blockchain.\n` +
                    `🏦 <b>${ton} TON</b> added to your balance!\n\n` +
                    `You can now create tasks. 🚀`
                );

                // Notify admin
                const warnNote = body._warnCount > 0 ? `\n⚠️ User has ${body._warnCount} warning(s)` : '';
                await tgMsg(ADMIN_ID,
                    `✅ <b>Deposit Auto-Approved</b>\n` +
                    `👤 ${firstName||''} (@${username||'N/A'}) [<code>${uid}</code>]\n` +
                    `💰 ${ton} TON verified on blockchain\n` +
                    `💎 ${diamond} Diamond credited${warnNote}`
                );

                return res.status(200).json({
                    success: true,
                    autoApproved: true,
                    ton,
                    diamond,
                    message: 'Transaction verified! TON added to your balance.'
                });

            } catch(e) {
                console.error('[auto-approve]', e.message);
                // Fall through to manual review if transaction write fails
            }
        }

        // ── TRANSACTION NOT FOUND → Save as pending for manual review ──
        try {
            const diamond = parseInt(expectedDiamond) || Math.floor(ton * 2000);
            const warnNote = body._warnCount > 0 ? `\n⚠️ <b>User has ${body._warnCount} warning(s)!</b>` : '';

            const depRef = await db.collection('deposits').add({
                userId: uid, username: username||'', firstName: firstName||'',
                tonAmount: ton, expectedDiamond: diamond,
                memo: memo || uid,
                status: 'pending',
                autoVerified: false,
                createdAt: FieldValue.serverTimestamp(),
            });

            await tgMsg(ADMIN_ID,
                `🟡 <b>Deposit Pending (Not Auto-Verified)</b>\n` +
                `👤 ${firstName||''} (@${username||'N/A'}) [<code>${uid}</code>]\n` +
                `💰 ${ton} TON claimed — blockchain check failed\n` +
                `📝 Memo: <code>${memo||uid}</code>\n` +
                `🆔 ID: <code>${depRef.id}</code>${warnNote}\n\n` +
                `⚠️ Verify manually before approving.`
            );

            await tgMsg(uid,
                `⏳ <b>Deposit Under Review</b>\n\n` +
                `💰 ${ton} TON request received.\n\n` +
                `🔍 We couldn't auto-verify your transaction yet.\n` +
                `Admin will review manually within 1–6 hours.\n\n` +
                `⚠️ If you haven't actually sent TON, please do not submit requests — repeated fake requests = permanent ban.`
            );

            return res.status(200).json({
                success: true,
                autoApproved: false,
                depositId: depRef.id,
                message: 'Transaction not found yet. Submitted for manual review.'
            });

        } catch(e) {
            console.error('[deposit-pending]', e.message);
            return res.status(500).json({ error: e.message });
        }
    }

    // ════════════════════════════════════════════
    // TASK PAYMENT
    // ════════════════════════════════════════════
    try {
        const collection_name = type === 'task_payment' ? 'task_payments'
                              : type === 'task_create'  ? 'tasks'
                              : 'deposits';

        const docData = {
            userId: uid, username: username||'', firstName: firstName||'',
            status: type === 'task_create' ? 'pending_approval' : 'pending',
            type: type||'deposit',
            createdAt: FieldValue.serverTimestamp(),
        };

        if (type === 'task_create') {
            const { title, url, category, channelId, rewardDiamond, maxCompletions, tonCost, packageLabel, createdBy } = body;
            Object.assign(docData, {
                title: title||'', url: url||'', category: category||'social',
                channelId: channelId||'', rewardDiamond: parseFloat(rewardDiamond)||1,
                maxCompletions: parseInt(maxCompletions)||100, completionCount: 0,
                isApproved: false, tonCost: parseFloat(tonCost)||0,
                packageLabel: packageLabel||'', createdBy: createdBy||uid,
            });
            const tonCostVal = parseFloat(body.tonCost)||0;
            if (tonCostVal > 0) {
                try {
                    const uRef  = db.collection('users').doc(uid);
                    const uSnap = await uRef.get();
                    if (uSnap.exists) {
                        const curTon = uSnap.data().tonBalance || 0;
                        if (curTon < tonCostVal) {
                            return res.status(200).json({ success: false, error: 'Insufficient TON balance' });
                        }
                        await uRef.update({ tonBalance: FieldValue.increment(-tonCostVal) });
                    }
                } catch(e) { console.warn('[task_create deduct]', e.message); }
            }
        } else {
            Object.assign(docData, {
                tonAmount: parseFloat(tonAmount)||0,
                expectedDiamond: parseInt(expectedDiamond)||0,
                memo: memo||uid,
                ...(taskTitle ? { taskTitle } : {}),
            });
        }

        const docRef = await db.collection(collection_name).add(docData);
        const warnNote = body._warnCount > 0 ? `\n⚠️ <b>User has ${body._warnCount} warning(s)!</b>` : '';
        const isTask   = type === 'task_payment';

        await tgMsg(ADMIN_ID,
            `${isTask ? '🟡 <b>Task Payment' : '🟢 <b>Deposit Request'}</b>\n` +
            `👤 ${firstName||''} (@${username||'N/A'}) [<code>${uid}</code>]\n` +
            `💰 ${tonAmount} TON${isTask ? ` (${taskTitle||''})` : ''}\n` +
            `💎 Expected: ${expectedDiamond} Diamond\n` +
            `📝 Memo: <code>${memo||uid}</code>\n` +
            `🆔 ID: <code>${docRef.id}</code>${warnNote}`
        );

        await tgMsg(uid,
            `${isTask ? '🟡 <b>Task Payment Received!' : '🟢 <b>Deposit Request Submitted!'}</b>\n\n` +
            `💰 ${tonAmount} TON\n` +
            (isTask ? `📋 Task: ${taskTitle||''}\n` : `💎 Expected: ${expectedDiamond} Diamond\n`) +
            `\n⏳ Admin will review shortly.\n` +
            `⚠️ Fake requests = permanent deposit ban.`
        );

        return res.status(200).json({ success: true, depositId: docRef.id });
    } catch(e) {
        console.error('[notifyDeposit]', e.message);
        return res.status(500).json({ error: e.message });
    }
            }
