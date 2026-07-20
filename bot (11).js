// api/bot.js — Telegram Bot webhook (handles BOTH user and admin flows in
// ONE serverless function, to stay within Vercel Hobby plan's 12-function
// limit — see lib/constants.js comments for the overall API budget plan).

import { connectToDatabase } from '../lib/mongodb.js';
import { tgSend, tgSendPhoto, tgEdit, tgAnswerCallback } from '../lib/telegram.js';
import { createUserDoc } from '../lib/schema.js';
import { reviewTask } from '../lib/taskService.js';
import { getAdminState, setAdminState, clearAdminState } from '../lib/adminState.js';
import { getDashboardStats, adminCreateTask, listPendingTasks, findUserByIdOrUsername, setUserBanStatus, adjustUserBalance, getTopReferrers, removeTask } from '../lib/adminService.js';
import { createPromoCode, listActivePromoCodes } from '../lib/promoService.js';
import { broadcastToAllUsers } from '../lib/broadcastService.js';
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
    if (state && state.step) {
      if (state.step.startsWith('ct_')) {
        await handleAdminTaskCreationText(db, chatId, from.id, state, text);
        return;
      }
      if (state.step.startsWith('promo_')) {
        await handleAdminPromoText(db, chatId, from.id, state, text);
        return;
      }
      if (state.step.startsWith('broadcast_')) {
        await handleAdminBroadcastText(db, chatId, from.id, state, text);
        return;
      }
      if (state.step.startsWith('lookup_')) {
        await handleAdminLookupText(db, chatId, from.id, state, text);
        return;
      }
      if (state.step.startsWith('gift_')) {
        await handleAdminGiftText(db, chatId, from.id, state, text);
        return;
      }
      if (state.step === 'adjust_amount') {
        await handleAdminAdjustText(db, chatId, from.id, state, text);
        return;
      }
      if (state.step === 'remove_task_id') {
        await handleAdminRemoveTaskText(db, chatId, from.id, text);
        return;
      }
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
          { text: '🕓 Pending Tasks', callback_data: 'admin:managetasks' },
        ],
        [
          { text: '🗑️ Remove Task', callback_data: 'admin:removetask' },
          { text: '👤 User Lookup', callback_data: 'admin:userlookup' },
        ],
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

  if (data === 'admin:promo') {
    await tgAnswerCallback(callbackId, '');
    await tgSend(chatId, '🎁 <b>Promo Code</b>', {
      reply_markup: {
        inline_keyboard: [
          [{ text: '➕ Generate Code', callback_data: 'admin:promo_gen' }],
          [{ text: '📃 List Active Codes', callback_data: 'admin:promo_list' }],
          [{ text: '⬅️ Back', callback_data: 'admin:menu' }],
        ],
      },
    });
    return;
  }

  if (data === 'admin:promo_gen') {
    await tgAnswerCallback(callbackId, '');
    await setAdminState(db, adminId, 'promo_amount', {});
    await tgSend(chatId, '💰 How many TC should this code reward per claim? Send a number:');
    return;
  }

  if (data === 'admin:promo_list') {
    await tgAnswerCallback(callbackId, '');
    const codes = await listActivePromoCodes(db);
    if (codes.length === 0) {
      await tgSend(chatId, 'No active promo codes yet.');
      return;
    }
    const lines = codes.map(
      (c) =>
        `<code>${c.code}</code> — ${c.amountTC} TC — claimed ${c.claimedBy.length}${c.maxClaims ? `/${c.maxClaims}` : ' (unlimited)'}`
    );
    await tgSend(chatId, `📃 <b>Active Promo Codes</b>\n\n${lines.join('\n')}`);
    return;
  }

  if (data === 'admin:broadcast') {
    await tgAnswerCallback(callbackId, '');
    await setAdminState(db, adminId, 'broadcast_text', {});
    await tgSend(chatId, '📢 Send the message you want to broadcast to ALL users (HTML formatting supported):');
    return;
  }

  if (data === 'admin:broadcast_send') {
    await tgAnswerCallback(callbackId, '⏳ Sending...');
    const state = await getAdminState(db, adminId);
    if (!state || !state.data?.text) {
      await tgSend(chatId, '⚠️ Nothing to broadcast — please start again with /admin.');
      return;
    }
    const { sent, failed } = await broadcastToAllUsers(db, state.data.text);
    await clearAdminState(db, adminId);
    await tgSend(chatId, `✅ Broadcast complete.\n\nSent: <b>${sent}</b>\nFailed: <b>${failed}</b>`);
    return;
  }

  if (data === 'admin:broadcast_cancel') {
    await tgAnswerCallback(callbackId, '');
    await clearAdminState(db, adminId);
    await tgSend(chatId, '❌ Broadcast cancelled.');
    return;
  }

  if (data === 'admin:managetasks') {
    await tgAnswerCallback(callbackId, '');
    const pending = await listPendingTasks(db);
    if (pending.length === 0) {
      await tgSend(chatId, '✅ No pending tasks — all caught up!');
      return;
    }
    for (const task of pending) {
      const owner = await db.collection('users').findOne({ telegramId: task.ownerId });
      const posterName = owner?.username ? `@${owner.username}` : owner?.firstName || task.ownerId;
      await tgSend(
        chatId,
        `🆕 <b>Pending task</b>\n\n` +
          `👤 From: ${posterName} (<code>${task.ownerId}</code>)\n` +
          `📌 Type: ${TASK_TYPES[task.type]?.label || task.type}\n` +
          `📝 Title: ${task.title}\n` +
          `🔗 Link: ${task.link}\n` +
          (task.targetChatId ? `🎯 Target: <code>${task.targetChatId}</code>\n` : '') +
          `🎟 Slots: ${task.totalSlots} (cost: ${task.costTC} TC)`,
        {
          reply_markup: {
            inline_keyboard: [
              [
                { text: '✅ Approve', callback_data: `rev:approved:${task._id}` },
                { text: '❌ Reject', callback_data: `rev:rejected:${task._id}` },
              ],
              [
                { text: '🔍 Not Found', callback_data: `rev:not_found:${task._id}` },
                { text: '🔞 Adult (BAN)', callback_data: `rev:adult:${task._id}` },
              ],
            ],
          },
        }
      );
    }
    return;
  }

  if (data === 'admin:removetask') {
    await tgAnswerCallback(callbackId, '');
    await setAdminState(db, adminId, 'remove_task_id', {});
    await tgSend(chatId, '🗑️ Send the Task ID to remove permanently (find it via 🕓 Pending Tasks list or a task\'s review message):');
    return;
  }

  if (data === 'admin:userlookup') {
    await tgAnswerCallback(callbackId, '');
    await setAdminState(db, adminId, 'lookup_query', {});
    await tgSend(chatId, '👤 Send the user\'s Telegram ID or @username:');
    return;
  }

  if (data.startsWith('admin:user_toggleban:')) {
    await tgAnswerCallback(callbackId, '');
    const targetId = Number(data.replace('admin:user_toggleban:', ''));
    const target = await db.collection('users').findOne({ telegramId: targetId });
    if (!target) {
      await tgSend(chatId, '⚠️ User not found.');
      return;
    }
    const updated = await setUserBanStatus(db, targetId, !target.banned, !target.banned ? 'manual_ban' : null);
    await tgSend(chatId, updated.banned ? `🚫 User <code>${targetId}</code> has been banned.` : `✅ User <code>${targetId}</code> has been unbanned.`);
    return;
  }

  if (data.startsWith('admin:user_adjust:')) {
    await tgAnswerCallback(callbackId, '');
    const targetId = Number(data.replace('admin:user_adjust:', ''));
    await setAdminState(db, adminId, 'adjust_amount', { targetId });
    await tgSend(chatId, '💰 Send the amount to add (use a negative number to subtract):');
    return;
  }

  if (data === 'admin:topref') {
    await tgAnswerCallback(callbackId, '');
    const top = await getTopReferrers(db);
    if (top.length === 0) {
      await tgSend(chatId, 'No referrals yet.');
      return;
    }
    const lines = top.map(
      (u, i) => `${i + 1}. ${u.username ? '@' + u.username : u.firstName} — <b>${u.referralCount}</b> refers`
    );
    await tgSend(chatId, `🏆 <b>Top Referrers</b>\n\n${lines.join('\n')}`);
    return;
  }

  if (data === 'admin:gift') {
    await tgAnswerCallback(callbackId, '');
    await setAdminState(db, adminId, 'gift_target', {});
    await tgSend(chatId, '🎁 Send the target user\'s Telegram ID or @username:');
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

/** Handles each text message the admin sends while creating a promo code. */
async function handleAdminPromoText(db, chatId, adminId, state, text) {
  const { step, data } = state;

  if (step === 'promo_amount') {
    const amount = Number(text);
    if (!Number.isInteger(amount) || amount <= 0) {
      await tgSend(chatId, '⚠️ Please send a valid positive number.');
      return;
    }
    data.amountTC = amount;
    await setAdminState(db, adminId, 'promo_maxclaims', data);
    await tgSend(chatId, '👥 How many people can claim this code? Send a number, or type "unlimited":');
    return;
  }

  if (step === 'promo_maxclaims') {
    let maxClaims = null;
    if (text.toLowerCase() !== 'unlimited') {
      const n = Number(text);
      if (!Number.isInteger(n) || n <= 0) {
        await tgSend(chatId, '⚠️ Please send a valid positive number, or type "unlimited".');
        return;
      }
      maxClaims = n;
    }

    const promo = await createPromoCode(db, { amountTC: data.amountTC, maxClaims, createdBy: adminId });
    await clearAdminState(db, adminId);

    await tgSend(
      chatId,
      `✅ Promo code created!\n\n` +
        `🎟 Code: <code>${promo.code}</code>\n` +
        `💰 Reward: ${promo.amountTC} TC\n` +
        `👥 Max claims: ${promo.maxClaims || 'unlimited'}\n\n` +
        `Share this code wherever you like — users redeem it in the Mini App after watching an ad.`
    );
    return;
  }
}

/** Handles each text message the admin sends while composing a broadcast. */
async function handleAdminBroadcastText(db, chatId, adminId, state, text) {
  const { step, data } = state;

  if (step === 'broadcast_text') {
    data.text = text;
    await setAdminState(db, adminId, 'broadcast_confirm', data);
    await tgSend(chatId, `📢 <b>Preview:</b>\n\n${text}\n\n— Send this to all users?`, {
      reply_markup: {
        inline_keyboard: [
          [
            { text: '✅ Confirm & Send', callback_data: 'admin:broadcast_send' },
            { text: '❌ Cancel', callback_data: 'admin:broadcast_cancel' },
          ],
        ],
      },
    });
    return;
  }
}

/** Handles the admin sending a Telegram ID or @username to look up. */
async function handleAdminLookupText(db, chatId, adminId, state, text) {
  const user = await findUserByIdOrUsername(db, text);
  await clearAdminState(db, adminId);

  if (!user) {
    await tgSend(chatId, '⚠️ No user found with that ID/username.');
    return;
  }

  const posterName = user.username ? `@${user.username}` : user.firstName || user.telegramId;

  await tgSend(
    chatId,
    `👤 <b>${posterName}</b> (<code>${user.telegramId}</code>)\n\n` +
      `💰 Balance: <b>${user.balanceTC} TC</b>\n` +
      `📝 Posts (lifetime): ${user.postCount}\n` +
      `👥 Referrals: ${user.referralCount}\n` +
      `⚠️ Strikes: ${user.strikes}\n` +
      `🚩 Multi-account flag: ${user.multiAccountFlag ? 'Yes' : 'No'}\n` +
      `🚫 Banned: ${user.banned ? `Yes (${user.banReason})` : 'No'}\n` +
      `📅 Joined: ${new Date(user.createdAt).toISOString().slice(0, 10)}`,
    {
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: user.banned ? '✅ Unban' : '🚫 Ban',
              callback_data: `admin:user_toggleban:${user.telegramId}`,
            },
            { text: '💰 Adjust Balance', callback_data: `admin:user_adjust:${user.telegramId}` },
          ],
        ],
      },
    }
  );
}

/** Handles the amount the admin sends after tapping "Adjust Balance". */
async function handleAdminAdjustText(db, chatId, adminId, state, text) {
  const amount = Number(text);
  if (!Number.isInteger(amount) || amount === 0) {
    await tgSend(chatId, '⚠️ Please send a valid non-zero whole number (negative to subtract).');
    return;
  }

  const { targetId } = state.data;
  const updated = await adjustUserBalance(db, targetId, amount);
  await clearAdminState(db, adminId);

  await tgSend(chatId, `✅ Done. <code>${targetId}</code>'s new balance: <b>${updated.balanceTC} TC</b>`);
  await tgSend(
    targetId,
    amount > 0
      ? `💰 Your balance was adjusted by admin: <b>+${amount} TC</b>.`
      : `💰 Your balance was adjusted by admin: <b>${amount} TC</b>.`
  );
}

/** Handles the Task ID the admin sends after tapping "Remove Task". */
async function handleAdminRemoveTaskText(db, chatId, adminId, taskIdText) {
  const taskId = taskIdText.trim();
  let result;
  try {
    result = await removeTask(db, taskId);
  } catch (e) {
    result = { ok: false, error: 'invalid_id' };
  }
  await clearAdminState(db, adminId);

  if (!result.ok) {
    await tgSend(chatId, `⚠️ Could not remove task (${result.error}). Double-check the Task ID and try again from the menu.`);
    return;
  }

  await tgSend(chatId, `🗑️ Removed: "<b>${result.task.title}</b>"`);
  if (result.task.ownerId && !result.task.postedByAdmin) {
    await tgSend(result.task.ownerId, `🗑️ Your task "<b>${result.task.title}</b>" was removed by the admin.`);
  }
}

/** Handles each text message the admin sends while sending a gift. */
async function handleAdminGiftText(db, chatId, adminId, state, text) {
  const { step, data } = state;

  if (step === 'gift_target') {
    const user = await findUserByIdOrUsername(db, text);
    if (!user) {
      await tgSend(chatId, '⚠️ No user found — try again, or /cancel:');
      return;
    }
    data.targetId = user.telegramId;
    await setAdminState(db, adminId, 'gift_amount', data);
    await tgSend(chatId, `🎁 Sending gift to <code>${user.telegramId}</code>. How many TC?`);
    return;
  }

  if (step === 'gift_amount') {
    const amount = Number(text);
    if (!Number.isInteger(amount) || amount <= 0) {
      await tgSend(chatId, '⚠️ Please send a valid positive number.');
      return;
    }
    const updated = await adjustUserBalance(db, data.targetId, amount);
    await clearAdminState(db, adminId);

    await tgSend(chatId, `✅ Gift sent! <code>${data.targetId}</code>'s new balance: <b>${updated.balanceTC} TC</b>`);
    await tgSend(data.targetId, `🎁 You received a gift of <b>${amount} TC</b> from the admin!`);
    return;
  }
}
