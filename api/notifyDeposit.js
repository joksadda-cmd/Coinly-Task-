// api/notifyDeposit.js
// Called when user confirms a TON deposit.
// Saves to Firestore + sends admin Telegram notification.

import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

const BOT_TOKEN   = process.env.BOT_TOKEN;
const ADMIN_TG_ID = process.env.ADMIN_TELEGRAM_ID;
const DEPOSIT_WALLET = process.env.DEPOSIT_WALLET;

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

async function sendMsg(chatId, text, replyMarkup = null) {
    if (!BOT_TOKEN || !chatId) return;
    try {
        const body = { chat_id: chatId, text, parse_mode: 'HTML' };
        if (replyMarkup) body.reply_markup = replyMarkup;
        await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
    } catch(e) { console.warn('[notifyDeposit]', e.message); }
}

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const { depositId, userId, username, firstName, tonAmount, expectedDiamond, memo } = req.body || {};
    if (!userId || !tonAmount) {
        return res.status(400).json({ ok: false, error: 'missing_fields' });
    }

    try {
        // Notify admin with approve button
        if (ADMIN_TG_ID) {
            const userHandle = username ? `@${username}` : firstName || 'Unknown';
            await sendMsg(ADMIN_TG_ID,
`💰 <b>New Deposit Request!</b>

👤 User: <b>${firstName || 'Unknown'}</b> ${username ? `(@${username})` : ''}
🆔 Telegram ID: <code>${userId}</code>
💎 Memo: <code>${memo}</code>

💸 Amount: <b>${tonAmount} TON</b>
💎 Diamond to add: <b>${expectedDiamond} 💎</b>
🏦 Wallet: <code>${DEPOSIT_WALLET || 'N/A'}</code>

📋 Deposit ID: <code>${depositId}</code>

✅ Verify TON received, then approve in admin panel.`,
                { inline_keyboard: [[
                    { text: '✅ Approve Deposit', callback_data: `approve_deposit_${depositId}_${userId}_${expectedDiamond}` }
                ]]}
            );
        }

        return res.status(200).json({ ok: true });

    } catch(err) {
        console.error('[notifyDeposit]', err);
        return res.status(500).json({ ok: false, error: 'server_error' });
    }
}
