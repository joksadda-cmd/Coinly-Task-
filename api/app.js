// api/app.js — Mini App backend. ONE serverless function handling every
// Mini App action via `{ action, initData, payload }` in the request body
// (Vercel Hobby plan caps us at 12 functions total, so we can't have a
// separate file per feature).
//
// Every request must include a valid `initData` — we verify it and use the
// telegramId FROM IT, never from `payload`. See lib/verifyInitData.js.

import { connectToDatabase } from '../lib/mongodb.js';
import { verifyInitData, getStartParam } from '../lib/verifyInitData.js';
import { createUserDoc } from '../lib/schema.js';
import { postTask } from '../lib/taskService.js';
import { claimAd, claimDailySpin, claimLoginStreak } from '../lib/engagement.js';
import { redeemPromoCode } from '../lib/promoService.js';
import { completeTask, getFeed, reactToTask, getProfile, getReferralLeaderboard, toggleFollow, deleteOwnTask, checkForceJoin } from '../lib/feedService.js';

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
        let user = await db.collection('users').findOne({ telegramId });

        if (!user) {
          // First time this person has EVER opened the Mini App.
          // If they arrived via a referral direct link
          // (https://t.me/Bot/App?startapp=ref_XXX), Telegram passes that
          // value as `start_param` INSIDE the same signed initData string —
          // so it's just as trustworthy as telegramId itself.
          const startParam = getStartParam(initData);
          let referredBy = null;

          if (startParam && startParam.startsWith('ref_')) {
            const refId = Number(startParam.slice(4));
            if (Number.isFinite(refId) && refId !== telegramId) {
              const referrer = await db.collection('users').findOne({ telegramId: refId });
              if (referrer) referredBy = refId;
            }
          }

          const newUser = createUserDoc({
            telegramId,
            username: tgUser.username || null,
            firstName: tgUser.first_name || '',
            referredBy,
          });

          try {
            await db.collection('users').insertOne(newUser);
            user = newUser;
          } catch (err) {
            // Duplicate key (11000) = a near-simultaneous request (e.g. bot
            // /start + Mini App open at almost the same moment) already
            // created this user first. Just re-fetch instead of erroring.
            if (err.code === 11000) {
              user = await db.collection('users').findOne({ telegramId });
            } else {
              throw err;
            }
          }
        }

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
          photoUrl: payload.photoUrl,
          description: payload.description,
        });
        return res.status(200).json(result);
      }

      case 'claimAd': {
        const result = await claimAd(db, { telegramId, network: payload.network });
        return res.status(200).json(result);
      }

      case 'dailySpin': {
        const result = await claimDailySpin(db, { telegramId });
        return res.status(200).json(result);
      }

      case 'claimStreak': {
        const result = await claimLoginStreak(db, { telegramId });
        return res.status(200).json(result);
      }

      case 'redeemPromo': {
        // Frontend must only call this AFTER the user completes watching an
        // ad (same trust model as claimAd — see lib/promoService.js note).
        const result = await redeemPromoCode(db, { telegramId, code: payload.code });
        return res.status(200).json(result);
      }

      case 'completeTask': {
        const result = await completeTask(db, { telegramId, taskId: payload.taskId });
        return res.status(200).json(result);
      }

      case 'getFeed': {
        const result = await getFeed(db, {
          telegramId,
          limit: Number(payload.limit) || 20,
          skip: Number(payload.skip) || 0,
        });
        return res.status(200).json(result);
      }

      case 'reactToTask': {
        const result = await reactToTask(db, { telegramId, taskId: payload.taskId, reaction: payload.reaction });
        return res.status(200).json(result);
      }

      case 'getProfile': {
        const result = await getProfile(db, {
          viewerId: telegramId,
          targetTelegramId: Number(payload.targetTelegramId) || telegramId,
        });
        return res.status(200).json(result);
      }

      case 'getLeaderboard': {
        const list = await getReferralLeaderboard(db);
        return res.status(200).json({ ok: true, leaderboard: list });
      }

      case 'toggleFollow': {
        const result = await toggleFollow(db, { followerId: telegramId, targetTelegramId: Number(payload.targetTelegramId) });
        return res.status(200).json(result);
      }

      case 'deleteTask': {
        const result = await deleteOwnTask(db, { telegramId, taskId: payload.taskId });
        return res.status(200).json(result);
      }

      case 'checkForceJoin': {
        const result = await checkForceJoin(telegramId);
        return res.status(200).json(result);
      }

      default:
        return res.status(400).json({ ok: false, error: 'unknown_action' });
    }
  } catch (err) {
    console.error('[api/app] error:', err);
    return res.status(500).json({ ok: false, error: 'server_error' });
  }
                                         }
