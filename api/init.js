// api/init.js
// New user registration + referral reward

import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';

const BOT_TOKEN       = process.env.BOT_TOKEN;
const ADMIN_TG_ID     = process.env.ADMIN_TELEGRAM_ID;
const REFERRAL_REWARD = 500;

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
    } catch(e) { console.warn('[init] Telegram:', e.message); }
}

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const { userId, firstName, lastName, username, referrerCode } = req.body || {};
    if (!userId) return res.status(400).json({ error: 'userId required' });

    try {
        const app = getAdminApp();
        const db  = getFirestore(app);
        const userRef = db.collection('users').doc(String(userId));
        const userSnap = await userRef.get();

        // Existing user — just update last active
        if (userSnap.exists) {
            await userRef.update({ lastActiveDate: new Date().toISOString().slice(0, 10) });
            return res.status(200).json({ ok: true, isNew: false });
        }

        // New user — create document
        await userRef.set({
            telegramId:       String(userId),
            firstName:        firstName || '',
            lastName:         lastName  || '',
            telegramUsername: username  || '',
            tonBalance:       0,
            totalEarned:      0,
            totalInvites:     0,
            completedTasks:   [],
            referredBy:       referrerCode ? String(referrerCode) : null,
            channelVerified:  false,
            isBanned:         false,
            createdAt:        FieldValue.serverTimestamp(),
            lastActiveDate:   new Date().toISOString().slice(0, 10),
        });

        // Handle referral
        if (referrerCode && String(referrerCode) !== String(userId)) {
            const referrerRef  = db.collection('users').doc(String(referrerCode));
            const referrerSnap = await referrerRef.get();

            if (referrerSnap.exists && !referrerSnap.data().isBanned) {
                await referrerRef.update({
                    tonBalance:   FieldValue.increment(REFERRAL_REWARD),
                    totalEarned:  FieldValue.increment(REFERRAL_REWARD),
                    totalInvites: FieldValue.increment(1),
                });

                const newUserName   = firstName || 'A new friend';
                const newUserHandle = username  ? `@${username}` : '';

                await sendMsg(referrerCode,
`✅ <b>You earned ${REFERRAL_REWARD} points!</b>

👤 <b>${newUserName}</b> ${newUserHandle}
joined Coinly Task using your referral link!

💰 <b>+${REFERRAL_REWARD} points</b> added to your account!`,
                    { inline_keyboard: [[
                        { text: '🎮 Open Coinly Task', url: 'https://t.me/YourBot/YourApp' }
                    ]]}
                );

                if (ADMIN_TG_ID) {
                    await sendMsg(ADMIN_TG_ID,
`🆕 <b>New User!</b>
👤 <b>${newUserName}</b> ${newUserHandle}
🆔 ID: <code>${userId}</code>
🔗 Referred by: <code>${referrerCode}</code>`
                    );
                }
            }
        }

        return res.status(200).json({ ok: true, isNew: true });

    } catch(err) {
        console.error('[init]', err);
        return res.status(500).json({ error: 'server_error', message: err.message });
    }
}
