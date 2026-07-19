// api/bot.js — Telegram Bot webhook (handles BOTH user and admin flows in
// ONE serverless function, to stay within Vercel Hobby plan's 12-function
// limit — see lib/constants.js comments for the overall API budget plan).

import { connectToDatabase } from '../lib/mongodb.js';
import { tgSend, tgSendPhoto, tgAnswerCallback } from '../lib/telegram.js';
import { createUserDoc } from '../lib/schema.js';
import { APP_LINKS, REFERRAL_BONUS_TC } from '../lib/constants.js';

// Used by admin-only flows (task approval, broadcast, etc.) added in later steps
const ADMIN_ID = Number(process.env.ADMIN_TELEGRAM_ID);

const WELCOME_PHOTO = 'https://i.postimg.cc/vHg75j14/file-00000000785c8208ba8891bbe41122d0.png';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    // Telegram never sends GET, but Vercel/health-checkers might ping this
    return res.status(200).json({ ok: true });
  }

  try {
    const update = req.body;

    if (update.message) {
      await handleMessage(update.message);
    } else if (update.callback_query) {
      await handleCallback(update.callback_query);
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('[bot webhook] error:', err);
    // Still return 200 — if we don't, Telegram will keep retrying the same
    // update forever and can cause duplicate processing.
    return res.status(200).json({ ok: false });
  }
}

async function handleMessage(message) {
  const chatId = message.chat.id;
  const text = (message.text || '').trim();

  if (text.startsWith('/start')) {
    await handleStart(chatId, message.from, text);
    return;
  }

  // Future: admin text-based flows (broadcast composing, rejection notes,
  // etc.) get routed here based on a stored admin conversation state —
  // same pattern as the reference admin panel bot.
}

async function handleStart(chatId, from, text) {
  const { db } = await connectToDatabase();
  const users = db.collection('users');

  const telegramId = from.id;
  let user = await users.findOne({ telegramId });

  if (!user) {
    // Referral payload looks like: "/start ref_123456789"
    const parts = text.split(' ');
    let referredBy = null;

    if (parts[1] && parts[1].startsWith('ref_')) {
      const refId = Number(parts[1].replace('ref_', ''));
      if (refId && refId !== telegramId) {
        const referrer = await users.findOne({ telegramId: refId });
        if (referrer && !referrer.banned) referredBy = refId;
      }
    }

    user = createUserDoc({
      telegramId,
      username: from.username || null,
      firstName: from.first_name || '',
      referredBy,
    });

    await users.insertOne(user);

    // Reward the referrer — server-side only, never trust a client claim
    if (referredBy) {
      await users.updateOne(
        { telegramId: referredBy },
        {
          $inc: { balanceTC: REFERRAL_BONUS_TC, referralCount: 1 },
          $set: { updatedAt: new Date() },
        }
      );
      await tgSend(
        referredBy,
        `🎉 Someone joined using your referral link!\n+${REFERRAL_BONUS_TC} TC added to your balance.`
      );
    }
  }

  const referralLink = `https://t.me/${APP_LINKS.botUsername}/${APP_LINKS.miniAppShortName}?startapp=ref_${telegramId}`;
  const shareUrl = `https://t.me/share/url?url=${encodeURIComponent(referralLink)}&text=${encodeURIComponent(
    'Join Coinly Task and grow your project — 100% free promotion!'
  )}`;

  const caption =
    `🎬 <b>Welcome to Coinly Task!</b>\n` +
    `Cross-promote your project · Earn TC · Post Tasks — 100% Free!\n\n` +
    `💰 Complete tasks & watch ads to earn TC\n` +
    `🚀 Use TC to promote <b>your own project</b> — no cost, no investment\n` +
    `👥 Refer friends for bonus TC (+${REFERRAL_BONUS_TC} TC each)\n` +
    `🎁 Daily spin + 7-day login streak bonus\n\n` +
    `👇 Tap below to get started!`;

  await tgSendPhoto(chatId, WELCOME_PHOTO, caption, {
    reply_markup: {
      inline_keyboard: [
        // web_app (NOT a plain url button) — this is what makes Telegram
        // hand the Mini App a verified initData payload for that user.
        [{ text: '🚀 Open Coinly Task', web_app: { url: APP_LINKS.webAppUrl } }],
        [{ text: '👥 Share & Earn', url: shareUrl }],
        [{ text: '📢 Long-term cross-promotion? Contact Admin', url: APP_LINKS.adminContact }],
      ],
    },
  });
}

async function handleCallback(callbackQuery) {
  const { id } = callbackQuery;
  // Placeholder — admin approve/reject buttons and other inline actions
  // will be routed here in a later step.
  await tgAnswerCallback(id, '');
}
