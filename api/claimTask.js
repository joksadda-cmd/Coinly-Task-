// api/claimTask.js
// Credits 10 TP per task + stores completion timestamp for refer validation
// Currency: TP (Task Points) — 20K TP = $1
//
// SECURITY: same gap as claimAd.js existed here — nothing verified that the
// caller was the real Telegram user for this userId, so anyone could call this
// directly with any taskId and any userId. initData verification added.

import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import crypto from 'crypto';

const TASK_REWARD_DEFAULT = 10; // 10 TP per task (default if not set in task doc)

const BOT_TOKEN = process.env.BOT_TOKEN;
const INITDATA_MAX_AGE_SEC = 3600;

function verifyTelegramInitData(initData) {
    if (!initData || !BOT_TOKEN) return null;
    try {
        const params = new URLSearchParams(initData);
        const hash = params.get('hash');
        if (!hash) return null;
        params.delete('hash');

        const pairs = [];
        for (const key of [...params.keys()].sort()) {
            pairs.push(`${key}=${params.get(key)}`);
        }
        const dataCheckString = pairs.join('\n');

        const secretKey = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
        const computedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
        if (computedHash !== hash) return null;

        const authDate = parseInt(params.get('auth_date') || '0', 10);
        if (!authDate || (Date.now() / 1000 - authDate) > INITDATA_MAX_AGE_SEC) return null;

        const user = JSON.parse(params.get('user') || 'null');
        if (!user || !user.id) return null;

        return String(user.id);
    } catch (e) {
        return null;
    }
}

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

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const { userId, taskId, initData } = req.body || {};
    if (!userId || !taskId) {
        return res.status(400).json({ ok: false, error: 'missing_fields' });
    }

    const verifiedId = verifyTelegramInitData(initData);
    if (!verifiedId || verifiedId !== String(userId)) {
        return res.status(401).json({ ok: false, error: 'unauthorized' });
    }

    try {
        const db      = getFirestore(getAdminApp());
        const userRef = db.collection('users').doc(String(userId));
        const taskRef = db.collection('tasks').doc(String(taskId));

        const reward = await db.runTransaction(async (t) => {
            const [userSnap, taskSnap] = await Promise.all([t.get(userRef), t.get(taskRef)]);

            if (!userSnap.exists) throw { code: 'user_not_found' };
            if (!taskSnap.exists) throw { code: 'task_not_found' };

            const user = userSnap.data();
            const task = taskSnap.data();

            if (user.isBanned)    throw { code: 'banned' };
            if (!task.isApproved) throw { code: 'task_not_approved' };
            if ((user.completedTasks || []).includes(taskId)) throw { code: 'already_completed' };

            // Use task's own rewardDiamond if set by admin, else default 10 TP
            const taskReward = task.rewardDiamond || TASK_REWARD_DEFAULT;
            const nowMs = Date.now();

            t.update(userRef, {
                completedTasks: FieldValue.arrayUnion(taskId),
                [`completedTasksAt.${taskId}`]: nowMs,
                diamondBalance: FieldValue.increment(taskReward),
                totalEarned:    FieldValue.increment(taskReward),
            });
            t.update(taskRef, {
                completionCount: FieldValue.increment(1),
            });

            return taskReward;
        });

        return res.status(200).json({ ok: true, reward });

    } catch(err) {
        if (err.code) return res.status(200).json({ ok: false, error: err.code });
        console.error('[claimTask]', err);
        return res.status(500).json({ ok: false, error: 'server_error' });
    }
}
