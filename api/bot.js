// api/bot.js — Telegram Bot webhook (handles BOTH user and admin flows in
// ONE serverless function, to stay within Vercel Hobby plan's 12-function
// limit — see lib/constants.js comments for the overall API budget plan).

import { connectToDatabase } from '../lib/mongodb.js';
import { tgSend, tgSendPhoto, tgEdit, tgAnswerCallback } from '../lib/telegram.js';
import { createUserDoc } from '../lib/schema.js';
import { reviewTask } from '../lib/taskService.js';
import { getAdminState, setAdminState, clearAdminState } from '../lib/adminState.js';
import { getDashboardStats, adminCreateTask } from '../lib/adminService.js';
import { APP_LINKS, REFERRAL_BONUS_TC, TASK_TYPES } from '../lib/constants.js';

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

function isAdmin(id) {
  return id === ADMIN_ID;
}

async function handleMessage(message) {
  const chatId = message.chat.id;
  const from = message.from;
  const text = (message.text || '').trim();

  if (isAdmin(from.id)) {
    if (text === '/admin') {
      await sendAdminMenu(chatId);
      return;
    }
    if (text === '/cancel') {
      const { db } = await connectToDatabase();
      await clearAdminState(db, from.id);
      await tgSend(chatId, '❌ Cancelled.');
      return;
    }

    // If admin is mid-flow (e.g. creating a task), route text there instead
    // of treating it as a normal command.
    const { db } = await connectToDatabase();
    const state = await getAdminState(db, from.id);
    if (state && state.step && state.step.startsWith('ct_')) {
      await handleAdminTaskCreationText(db, chatId, from.id, state, text);
      return;
    }
  }

  if (text.startsWith('/start')) {
    await handleStart(chatId, from, text);
    return;
  }
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
  const { id, from, data, message } = callbackQuery;

  // Admin task-review buttons: "rev:<decision>:<taskId>"
  if (data && data.startsWith('rev:')) {
    if (from.id !== ADMIN_ID) {
      await tgAnswerCallback(id, '⛔ Admins only.', true);
      return;
    }

    const [, decision, taskId] = data.split(':');
    const { db } = await connectToDatabase();
    const result = await reviewTask(db, taskId, decision);

    if (!result.ok) {
      await tgAnswerCallback(id, `⚠️ ${result.error}`, true);
      return;
    }

    await tgAnswerCallback(id, '✅ Done');

    // Edit the admin's message so the buttons disappear and the decision is visible
    const decisionLabel = { approved: '✅ Approved', rejected: '❌ Rejected', not_found: '🔍 Not Found', adult: '🔞 Adult — Banned' }[decision];
    await tgEdit(message.chat.id, message.message_id, `${message.text}\n\n— ${decisionLabel} —`);
    return;
  }

  // Admin panel buttons: "admin:<action>" or "admin:ct_type:<type>"
  if (data && data.startsWith('admin:')) {
    if (!isAdmin(from.id)) {
      await tgAnswerCallback(id, '⛔ Admins only.', true);
      return;
    }
    await handleAdminCallback(id, from.id, message.chat.id, data);
    return;
  }

  await tgAnswerCallback(id, '');
}

// ─────────────────────────────────────────────────────────
// ADMIN PANEL
// ─────────────────────────────────────────────────────────

async function sendAdminMenu(chatId) {
  await tgSend(chatId, '🛠 <b>Admin Panel</b>\n\nChoose an option:', {
    reply_markup: {
      inline_keyboard: [
        [{ text: '📊 Dashboard', callback_data: 'admin:dashboard' }],
        [{ text: '🎁 Promo Code', callback_data: 'admin:promo' }],
        [
          { text: '➕ Create Task', callback_data: 'admin:createtask' },
          { text: '📋 Manage Tasks', callback_data: 'admin:managetasks' },
        ],
        [{ text: '👤 User Lookup', callback_data: 'admin:userlookup' }],
        [{ text: '🏆 Top Referrers', callback_data: 'admin:topref' }],
        [
          { text: '🎁 Send Gift', callback_data: 'admin:gift' },
          { text: '📢 Broadcast', callback_data: 'admin:broadcast' },
        ],
      ],
    },
  });
}

async function handleAdminCallback(callbackId, adminId, chatId, data) {
  const { db } = await connectToDatabase();

  if (data === 'admin:menu') {
    await tgAnswerCallback(callbackId, '');
    await sendAdminMenu(chatId);
    return;
  }

  if (data === 'admin:dashboard') {
    await tgAnswerCallback(callbackId, '');
    const stats = await getDashboardStats(db);
    await tgSend(
      chatId,
      `📊 <b>Dashboard</b>\n\n` +
        `👥 Total users: <b>${stats.totalUsers}</b>\n` +
        `🆕 Joined today: <b>${stats.dailyJoins}</b>\n` +
        `🟢 Live tasks: <b>${stats.liveTasks}</b>\n` +
        `⏳ Pending review: <b>${stats.pendingTasks}</b>\n` +
        `💰 Total TC in circulation: <b>${stats.totalTCInCirculation}</b>`,
      { reply_markup: { inline_keyboard: [[{ text: '⬅️ Back', callback_data: 'admin:menu' }]] } }
    );
    return;
  }

  if (data === 'admin:createtask') {
    await tgAnswerCallback(callbackId, '');
    await setAdminState(db, adminId, 'ct_type', {});
    const typeButtons = Object.entries(TASK_TYPES).map(([key, cfg]) => [
      { text: cfg.label, callback_data: `admin:ct_type:${key}` },
    ]);
    await tgSend(chatId, '➕ <b>Create Task</b>\n\nChoose task type:', {
      reply_markup: { inline_keyboard: typeButtons },
    });
    return;
  }

  if (data.startsWith('admin:ct_type:')) {
    await tgAnswerCallback(callbackId, '');
    const type = data.replace('admin:ct_type:', '');
    await setAdminState(db, adminId, 'ct_title', { type });
    await tgSend(chatId, `Type: <b>${TASK_TYPES[type].label}</b>\n\n📝 Send the task title:`);
    return;
  }

  // Placeholders — built in upcoming steps
  if (['admin:promo', 'admin:managetasks', 'admin:userlookup', 'admin:topref', 'admin:gift', 'admin:broadcast'].includes(data)) {
    await tgAnswerCallback(callbackId, '🚧 Coming soon', true);
    return;
  }

  await tgAnswerCallback(callbackId, '');
}

/** Handles each text message the admin sends while inside the "create task" flow. */
async function handleAdminTaskCreationText(db, chatId, adminId, state, text) {
  const { step, data } = state;

  if (step === 'ct_title') {
    data.title = text;
    const needsTarget = TASK_TYPES[data.type].api_verify;
    if (needsTarget) {
      await setAdminState(db, adminId, 'ct_target', data);
      await tgSend(chatId, '🎯 Send the target channel/group @username or chat id (bot must be admin there):');
    } else {
      await setAdminState(db, adminId, 'ct_link', data);
      await tgSend(chatId, '🔗 Send the task link (URL):');
    }
    return;
  }

  if (step === 'ct_target') {
    data.targetChatId = text;
    await setAdminState(db, adminId, 'ct_link', data);
    await tgSend(chatId, '🔗 Send the task link (URL):');
    return;
  }

  if (step === 'ct_link') {
    data.link = text;
    await setAdminState(db, adminId, 'ct_slots', data);
    await tgSend(chatId, '🎟 Send number of slots (e.g. 50, 100, 500):');
    return;
  }

  if (step === 'ct_slots') {
    const slots = Number(text);
    if (!Number.isInteger(slots) || slots <= 0) {
      await tgSend(chatId, '⚠️ Please send a valid positive number.');
      return;
    }
    data.totalSlots = slots;
    await setAdminState(db, adminId, 'ct_photo', data);
    await tgSend(chatId, '🖼 Send a direct photo link for this task, or type "skip":');
    return;
  }

  if (step === 'ct_photo') {
    data.photoUrl = text.toLowerCase() === 'skip' ? null : text;

    const result = await adminCreateTask(db, { ...data, adminId });
    await clearAdminState(db, adminId);

    if (!result.ok) {
      await tgSend(chatId, `⚠️ Failed to create task: ${result.error}`);
      return;
    }

    await tgSend(
      chatId,
      `✅ Task created and is now <b>live</b>!\n\n` +
        `📝 ${result.task.title}\n` +
        `🎟 Slots: ${result.task.totalSlots}\n` +
        `🆔 <code>${result.task._id}</code>`
    );
    return;
  }
            }
