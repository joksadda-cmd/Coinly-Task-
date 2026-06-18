// api/init.js
// User init + data return — TP (Task Points) currency
// Deposit flow removed — no more pendingDeposit check against the
// (now unused) deposits collection. TON system fully removed —
// tonBalance no longer exists for new users (claimPromo.js no longer
// writes to it either, see updated claimPromo.js).

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
const db = getFirestore();

async function registerUserIdForBroadcast(uid) {
    try {
        await db.collection('meta').doc('userIds').set(
            { ids: FieldValue.arrayUnion(uid) },
            { merge: true }
        );
    } catch(e) { console.warn('[registerUserIdForBroadcast]', e.message); }
}

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin',  '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const { userId, firstName, lastName, username, referrerCode } = req.body || {};
    if (!userId) return res.status(400).json({ error: 'userId required' });

    const uid   = String(userId);
    const today = new Date().toLocaleDateString('en-US', { timeZone: 'Asia/Dhaka' });

    try {
        const userRef  = db.collection('users').doc(uid);
        const userSnap = await userRef.get();

        // ── New user ──
        if (!userSnap.exists) {
            const newUser = {
                diamondBalance: 0,
                lootboxBalance: 0,
                completedTasks: [],
                createdTasks:   [],
                totalInvites:         0,
                validReferrals:       0,
                referralDiamondEarned:0,
                telegramUsername: username  || 'N/A',
                firstName:        firstName || '',
                lastName:         lastName  || '',
                isBanned:         false,
                adsWatchedAd1: 0, adsWatchedAd2: 0,
                adsWatchedAd3: 0, adsWatchedAd4: 0,
                lastResetDate:    today,
                joinGiftClaimed:  false,
                isValidatedRef:   false,
                referredBy: (referrerCode && referrerCode !== uid) ? referrerCode : null,
                createdAt:  FieldValue.serverTimestamp(),
            };

            await userRef.set(newUser);
            await registerUserIdForBroadcast(uid);

            if (newUser.referredBy) {
                db.collection('users').doc(newUser.referredBy).update({
                    totalInvites: FieldValue.increment(1)
                }).catch(()=>{});
            }

            return res.status(200).json({ success: true, isNew: true, user: { ...newUser, id: uid } });
        }

        // ── Existing user ──
        const userData = userSnap.data();

        const updates = {};

        if (!userData._broadcastRegistered) {
            registerUserIdForBroadcast(uid);
            updates._broadcastRegistered = true;
        }

        if (firstName && firstName !== userData.firstName) updates.firstName = firstName;
        if (username  && username  !== userData.telegramUsername) updates.telegramUsername = username;

        // Daily ad reset
        if (userData.lastResetDate !== today) {
            updates.adsWatchedAd1 = 0; updates.adsWatchedAd2 = 0;
            updates.adsWatchedAd3 = 0; updates.adsWatchedAd4 = 0;
            updates.lastResetDate = today;
        }

        if (Object.keys(updates).length > 0) await userRef.update(updates);

        const finalUser = { ...userData, ...updates, id: uid };

        return res.status(200).json({ success: true, isNew: false, user: finalUser });

    } catch (e) {
        console.error('[init]', e.message);
        return res.status(500).json({ error: e.message });
    }
}
