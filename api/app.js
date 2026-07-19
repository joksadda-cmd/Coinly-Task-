// api/app.js — Mini App backend. ONE serverless function handling every
// Mini App action via `{ action, initData, payload }` in the request body
// (Vercel Hobby plan caps us at 12 functions total, so we can't have a
// separate file per feature).
//
// Every request must include a valid `initData` — we verify it and use the
// telegramId FROM IT, never from `payload`. See lib/verifyInitData.js.

import { connectToDatabase } from '../lib/mongodb.js';
import { verifyInitData } from '../lib/verifyInitData.js';
import { postTask } from '../lib/taskService.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  }

  const { action, initData, payload = {} } = req.body || {};

  const tgUser = verifyInitData(initData);
  if (!tgUser) {
    return res.status(401).json({ ok: false, error: 'invalid_init_data' });
  }
  const telegramId = tgUser.id; // TRUSTED — verified by Telegram's signature

  try {
    const { db } = await connectToDatabase();

    switch (action) {
      case 'getUser': {
        const user = await db.collection('users').findOne({ telegramId });
        if (!user) return res.status(404).json({ ok: false, error: 'user_not_found' });
        if (user.banned) return res.status(403).json({ ok: false, error: 'banned', banReason: user.banReason });
        return res.status(200).json({ ok: true, user });
      }

      case 'postTask': {
        const result = await postTask(db, {
          ownerId: telegramId,
          type: payload.type,
          title: payload.title,
          link: payload.link,
          targetChatId: payload.targetChatId,
          totalSlots: Number(payload.totalSlots),
        });
        return res.status(200).json(result);
      }

      // Coming next: claimAd, completeTask, dailySpin, claimStreak, getFeed, getProfile...
      default:
        return res.status(400).json({ ok: false, error: 'unknown_action' });
    }
  } catch (err) {
    console.error('[api/app] error:', err);
    return res.status(500).json({ ok: false, error: 'server_error' });
  }
}
