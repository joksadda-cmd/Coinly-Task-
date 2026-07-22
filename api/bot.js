// api/bot.js — Telegram Bot webhook (handles BOTH user and admin flows in
// ONE serverless function, to stay within Vercel Hobby plan's 12-function
// limit — see lib/constants.js comments for the overall API budget plan).

import { connectToDatabase } from '../lib/mongodb.js';
import { tgSend, tgSendPhoto, tgEdit, tgAnswerCallback } from '../lib/telegram.js';
import { createUserDoc } from '../lib/schema.js';
import { reviewTask } from '../lib/taskService.js';
import { getAdminState, setAdminState, clearAdminState } from '../lib/adminState.js';
import { getDashboardStats, adminCreateTask, listPendingTasks, findUserByIdOrUsername, setUserBanStatus, adjustUserBalance, getTopReferrers, removeTask, listLiveTasks, findTaskById } from '../lib/adminService.js';
import { createPromoCode, listActivePromoCodes } from '../lib/promoService.js';
import { broadcastToAllUsers } from '../lib/broadcastService.js';
import { APP_LINKS, REFERRAL_BONUS_TC, REFERRAL_ACTIVATION_TASKS, TASK_TYPES } from '../lib/constants.js';

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

/** Standard "❌ Cancel" inline button shown during every multi-step admin flow. */
function cancelKb() {
  return { reply_markup: { inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'admin:cancelflow' }]] } };
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
    if (isAdmin(from.id)) {
      await ensureUserDoc(from, text); // keep admin's own DB record in sync, silently
      await sendAdminMenu(chatId);
      return;
    }
    await handleStart(chatId, from, text);
    return;
  }
}

/** Creates the user doc if it doesn't exist yet (handles referral crediting too).
 *  Shared by both the normal /start welcome flow and the admin's silent /start. */
async function ensureUserDoc(from, text) {
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

    // NOTE: referral reward is NOT paid here anymore. It only activates once
    // this new user completes REFERRAL_ACTIVATION_TASKS tasks — see
    // maybeActivateReferral() in lib/feedService.js, called from completeTask().
    // This prevents someone farming fake/alt signups for free instant TC.
  }

  return user;
}

async function handleStart(chatId, from, text) {
  const telegramId = from.id;
  await ensureUserDoc(from, text);

  const referralLink = `https://t.me/${APP_LINKS.botUsername}/${APP_LINKS.miniAppShortName}?startapp=ref_${telegramId}`;
  const shareUrl = `https://t.me/share/url?url=${encodeURIComponent(referralLink)}&text=${encodeURIComponent(
    'Join Coinly Task and grow your project — 100% free promotion!'
  )}`;

  const caption =
    `🎬 <b>Welcome to Coinly Task!</b>\n` +
    `Cross-promote your project · Earn TC · Post Tasks — 100% Free!\n\n` +
    `💰 Complete tasks & watch ads to earn TC\n` +
    `🚀 Use TC to promote <b>your own project</b> — no cost, no investment\n` +
    `👥 Refer friends — get +${REFERRAL_BONUS_TC} TC once they complete ${REFERRAL_ACTIVATION_TASKS} tasks\n` +
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
    await handleAdminCallback(id, from.id, message.chat.id, message.message_id, data);
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
          { text: '🗒 Live Tasks', callback_data: 'admin:livetasks:0' },
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

async function handleAdminCallback(callbackId, adminId, chatId, messageId, data) {
  const { db } = await connectToDatabase();

  if (data === 'admin:cancelflow') {
    await tgAnswerCallback(callbackId, '');
    await clearAdminState(db, adminId);
    await tgSend(chatId, '❌ Cancelled.', { reply_markup: { inline_keyboard: [[{ text: '⬅️ Back to Menu', callback_data: 'admin:menu' }]] } });
    return;
  }

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
    await tgSend(chatId, '➕ <b>Create Task — Step 1</b>\n\nChoose task type:', {
      reply_markup: { inline_keyboard: typeButtons },
    });
    return;
  }

  if (data.startsWith('admin:ct_type:')) {
    await tgAnswerCallback(callbackId, '');
    const type = data.replace('admin:ct_type:', '');
    const needsTarget = TASK_TYPES[type].api_verify;
    const totalSteps = needsTarget ? 6 : 5;
    await setAdminState(db, adminId, 'ct_title', { type, needsTarget, totalSteps });
    await tgSend(chatId, `➕ <b>Create Task — Step 2/${totalSteps}</b>\n\nType: ✅ <b>${TASK_TYPES[type].label}</b>\n\n📝 Send the task title:`, cancelKb());
    return;
  }

  if (data === 'admin:ct_confirm') {
    await tgAnswerCallback(callbackId, '⏳ Creating...');
    const state = await getAdminState(db, adminId);
    if (!state || !state.data?.title) {
      await tgSend(chatId, '⚠️ Nothing to create — please start again from the menu.');
      return;
    }
    const result = await adminCreateTask(db, { ...state.data, adminId });
    await clearAdminState(db, adminId);
    if (!result.ok) {
      await tgSend(chatId, `⚠️ Failed to create task: ${result.error}`, { reply_markup: { inline_keyboard: [[{ text: '⬅️ Back to Menu', callback_data: 'admin:menu' }]] } });
      return;
    }
    await tgSend(
      chatId,
      `✅ Task created and is now <b>live</b>!\n\n` +
        `📝 ${result.task.title}\n` +
        `🎟 Slots: ${result.task.totalSlots}\n` +
        `🆔 <code>${result.task._id}</code>`,
      { reply_markup: { inline_keyboard: [[{ text: '⬅️ Back to Menu', callback_data: 'admin:menu' }]] } }
    );
    return;
  }

  if (data === 'admin:ct_cancel') {
    await tgAnswerCallback(callbackId, '');
    await clearAdminState(db, adminId);
    await tgSend(chatId, '❌ Task creation cancelled.', { reply_markup: { inline_keyboard: [[{ text: '⬅️ Back to Menu', callback_data: 'admin:menu' }]] } });
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
    await tgSend(chatId, '🎁 <b>Generate Promo Code — Step 1/2</b>\n\n💰 How many TC should this code reward per claim? Send a number:', cancelKb());
    return;
  }

  if (data === 'admin:promo_confirm') {
    await tgAnswerCallback(callbackId, '⏳ Creating...');
    const state = await getAdminState(db, adminId);
    if (!state || !state.data?.amountTC) {
      await tgSend(chatId, '⚠️ Nothing to create — please start again from the menu.');
      return;
    }
    const promo = await createPromoCode(db, { amountTC: state.data.amountTC, maxClaims: state.data.maxClaims, createdBy: adminId });
    await clearAdminState(db, adminId);
    await tgSend(
      chatId,
      `✅ Promo code created!\n\n` +
        `🎟 Code: <code>${promo.code}</code>\n` +
        `💰 Reward: ${promo.amountTC} TC\n` +
        `👥 Max claims: ${promo.maxClaims || 'unlimited'}\n\n` +
        `Share this code wherever you like — users redeem it in the Mini App after watching an ad.`,
      { reply_markup: { inline_keyboard: [[{ text: '⬅️ Back to Menu', callback_data: 'admin:menu' }]] } }
    );
    return;
  }

  if (data === 'admin:promo_cancel') {
    await tgAnswerCallback(callbackId, '');
    await clearAdminState(db, adminId);
    await tgSend(chatId, '❌ Promo code cancelled.', { reply_markup: { inline_keyboard: [[{ text: '⬅️ Back to Menu', callback_data: 'admin:menu' }]] } });
    return;
  }

  if (data === 'admin:promo_list') {
    await tgAnswerCallback(callbackId, '');
    const codes = await listActivePromoCodes(db);
    if (codes.length === 0) {
      await tgSend(chatId, 'No active promo codes yet.', { reply_markup: { inline_keyboard: [[{ text: '⬅️ Back to Menu', callback_data: 'admin:menu' }]] } });
      return;
    }
    const lines = codes.map(
      (c) =>
        `<code>${c.code}</code> — ${c.amountTC} TC — claimed ${c.claimedBy.length}${c.maxClaims ? `/${c.maxClaims}` : ' (unlimited)'}`
    );
    await tgSend(chatId, `📃 <b>Active Promo Codes</b>\n\n${lines.join('\n')}`, { reply_markup: { inline_keyboard: [[{ text: '⬅️ Back to Menu', callback_data: 'admin:menu' }]] } });
    return;
  }

  if (data === 'admin:broadcast') {
    await tgAnswerCallback(callbackId, '');
    await setAdminState(db, adminId, 'broadcast_text', {});
    await tgSend(chatId, '📢 <b>Broadcast — Step 1/2</b>\n\nSend the message you want to broadcast to ALL users (HTML formatting supported):', cancelKb());
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
    await tgSend(chatId, `✅ Broadcast complete.\n\nSent: <b>${sent}</b>\nFailed: <b>${failed}</b>`, { reply_markup: { inline_keyboard: [[{ text: '⬅️ Back to Menu', callback_data: 'admin:menu' }]] } });
    return;
  }

  if (data === 'admin:broadcast_cancel') {
    await tgAnswerCallback(callbackId, '');
    await clearAdminState(db, adminId);
    await tgSend(chatId, '❌ Broadcast cancelled.', { reply_markup: { inline_keyboard: [[{ text: '⬅️ Back to Menu', callback_data: 'admin:menu' }]] } });
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
      const caption =
        `🆕 <b>Pending task</b>\n\n` +
        `👤 From: ${posterName} (<code>${task.ownerId}</code>)\n` +
        `📌 Type: ${TASK_TYPES[task.type]?.label || task.type}\n` +
        `📝 Title: ${task.title}\n` +
        `🔗 Link: ${task.link}\n` +
        (task.targetChatId ? `🎯 Target: <code>${task.targetChatId}</code>\n` : '') +
        `🎟 Slots: ${task.totalSlots} (cost: ${task.costTC} TC)`;
      const reviewButtons = {
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
      };

      // ⚠️ If the task has a photo, show the ACTUAL IMAGE inline (not just a
      // link) — this is how the admin catches adult/inappropriate photos users
      // sneak in, instead of them slipping through unseen behind a text link.
      if (task.photoUrl) {
        try {
          await tgSendPhoto(chatId, task.photoUrl, caption, { reply_markup: reviewButtons });
        } catch (e) {
          // Bad/broken image URL — fall back to text so the admin still sees everything else
          await tgSend(chatId, caption + `\n\n⚠️ Photo URL could not be loaded: ${task.photoUrl}`, { reply_markup: reviewButtons });
        }
      } else {
        await tgSend(chatId, caption, { reply_markup: reviewButtons });
      }
    }
    return;
  }

  if (data === 'admin:removetask') {
    await tgAnswerCallback(callbackId, '');
    await setAdminState(db, adminId, 'remove_task_id', {});
    await tgSend(chatId, '🗑️ Send the Task ID to remove permanently (find it via 🕓 Pending Tasks list or a task\'s review message):', cancelKb());
    return;
  }

  if (data.startsWith('admin:removetask_confirm:')) {
    await tgAnswerCallback(callbackId, '⏳ Removing...');
    const taskId = data.replace('admin:removetask_confirm:', '');
    let result;
    try {
      result = await removeTask(db, taskId);
    } catch (e) {
      result = { ok: false, error: 'invalid_id' };
    }
    await clearAdminState(db, adminId);
    if (!result.ok) {
      await tgSend(chatId, `⚠️ Could not remove task (${result.error}).`, { reply_markup: { inline_keyboard: [[{ text: '⬅️ Back to Menu', callback_data: 'admin:menu' }]] } });
      return;
    }
    await tgSend(chatId, `🗑️ Removed: "<b>${result.task.title}</b>"`, { reply_markup: { inline_keyboard: [[{ text: '⬅️ Back to Menu', callback_data: 'admin:menu' }]] } });
    if (result.task.ownerId && !result.task.postedByAdmin) {
      await tgSend(result.task.ownerId, `🗑️ Your task "<b>${result.task.title}</b>" was removed by the admin.`);
    }
    return;
  }

  if (data === 'admin:removetask_cancel') {
    await tgAnswerCallback(callbackId, '');
    await clearAdminState(db, adminId);
    await tgSend(chatId, '❌ Cancelled — task was not removed.', { reply_markup: { inline_keyboard: [[{ text: '⬅️ Back to Menu', callback_data: 'admin:menu' }]] } });
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
    await tgSend(chatId, updated.banned ? `🚫 User <code>${targetId}</code> has been banned.` : `✅ User <code>${targetId}</code> has been unbanned.`, { reply_markup: { inline_keyboard: [[{ text: '⬅️ Back to Menu', callback_data: 'admin:menu' }]] } });
    return;
  }

  if (data.startsWith('admin:user_adjust:')) {
    await tgAnswerCallback(callbackId, '');
    const targetId = Number(data.replace('admin:user_adjust:', ''));
    await setAdminState(db, adminId, 'adjust_amount', { targetId });
    await tgSend(chatId, '💰 <b>Adjust Balance</b>\n\nSend the amount to add (use a negative number to subtract):', cancelKb());
    return;
  }

  if (data === 'admin:adjust_confirm') {
    await tgAnswerCallback(callbackId, '⏳ Applying...');
    const state = await getAdminState(db, adminId);
    if (!state || state.data?.amount === undefined) {
      await tgSend(chatId, '⚠️ Nothing to apply — please start again from the menu.');
      return;
    }
    const { targetId, amount } = state.data;
    const updated = await adjustUserBalance(db, targetId, amount);
    await clearAdminState(db, adminId);
    await tgSend(chatId, `✅ Done. <code>${targetId}</code>'s new balance: <b>${updated.balanceTC} TC</b>`, { reply_markup: { inline_keyboard: [[{ text: '⬅️ Back to Menu', callback_data: 'admin:menu' }]] } });
    await tgSend(
      targetId,
      amount > 0
        ? `💰 Your balance was adjusted by admin: <b>+${amount} TC</b>.`
        : `💰 Your balance was adjusted by admin: <b>${amount} TC</b>.`
    );
    return;
  }

  if (data === 'admin:adjust_cancel') {
    await tgAnswerCallback(callbackId, '');
    await clearAdminState(db, adminId);
    await tgSend(chatId, '❌ Cancelled.', { reply_markup: { inline_keyboard: [[{ text: '⬅️ Back to Menu', callback_data: 'admin:menu' }]] } });
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
    await tgSend(chatId, '🎁 <b>Send Gift — Step 1/2</b>\n\nSend the target user\'s Telegram ID or @username:', cancelKb());
    return;
  }

  if (data === 'admin:gift_confirm') {
    await tgAnswerCallback(callbackId, '⏳ Sending...');
    const state = await getAdminState(db, adminId);
    if (!state || !state.data?.targetId || !state.data?.amount) {
      await tgSend(chatId, '⚠️ Nothing to send — please start again from the menu.');
      return;
    }
    const { targetId, amount } = state.data;
    const updated = await adjustUserBalance(db, targetId, amount);
    await clearAdminState(db, adminId);
    await tgSend(chatId, `✅ Gift sent! <code>${targetId}</code>'s new balance: <b>${updated.balanceTC} TC</b>`, { reply_markup: { inline_keyboard: [[{ text: '⬅️ Back to Menu', callback_data: 'admin:menu' }]] } });
    await tgSend(targetId, `🎁 You received a gift of <b>${amount} TC</b> from the admin!`);
    return;
  }

  if (data === 'admin:gift_cancel') {
    await tgAnswerCallback(callbackId, '');
    await clearAdminState(db, adminId);
    await tgSend(chatId, '❌ Gift cancelled.', { reply_markup: { inline_keyboard: [[{ text: '⬅️ Back to Menu', callback_data: 'admin:menu' }]] } });
    return;
  }

  // ── 🗒 Live Tasks — browsable list + a Remove button next to each ──
  // "admin:livetasks:<page>" where page is a 0-based page index (5 per page)
  if (data.startsWith('admin:livetasks:')) {
    await tgAnswerCallback(callbackId, '');
    const page = Number(data.replace('admin:livetasks:', '')) || 0;
    await renderLiveTasksPage(db, chatId, messageId, page);
    return;
  }

  // "admin:removelive:<taskId>:<page>" — remove one task, then refresh the same page
  if (data.startsWith('admin:removelive:')) {
    const [, , taskId, pageStr] = data.split(':');
    const page = Number(pageStr) || 0;
    const result = await removeTask(db, taskId);
    if (!result.ok) {
      await tgAnswerCallback(callbackId, '⚠️ Could not remove (already gone?).', true);
    } else {
      await tgAnswerCallback(callbackId, '🗑️ Removed');
      if (result.task.ownerId && !result.task.postedByAdmin) {
        await tgSend(result.task.ownerId, `🗑️ Your task "<b>${result.task.title}</b>" was removed by the admin.`);
      }
    }
    await renderLiveTasksPage(db, chatId, messageId, page);
    return;
  }

  await tgAnswerCallback(callbackId, '');
}

/** Renders one page of the "🗒 Live Tasks" browsable list, editing the admin's
 *  existing message in place (so tapping around feels like a real app screen
 *  instead of spamming new messages). Each task is its own 🗑 Remove button —
 *  no need to type a Task ID. */
async function renderLiveTasksPage(db, chatId, messageId, page) {
  const PAGE_SIZE = 5;
  const { items, totalCount } = await listLiveTasks(db, { skip: page * PAGE_SIZE, limit: PAGE_SIZE });

  if (totalCount === 0) {
    await tgEdit(chatId, messageId, '🗒 <b>Live Tasks</b>\n\nNo live tasks right now.', {
      reply_markup: { inline_keyboard: [[{ text: '⬅️ Back', callback_data: 'admin:menu' }]] },
    });
    return;
  }

  const users = db.collection('users');
  const rows = [];
  for (const task of items) {
    const owner = task.postedByAdmin ? null : await users.findOne({ telegramId: task.ownerId });
    const ownerLabel = task.postedByAdmin ? 'admin' : owner?.username ? `@${owner.username}` : owner?.firstName || task.ownerId;
    const shortTitle = task.title.length > 28 ? task.title.slice(0, 28) + '…' : task.title;
    rows.push([{ text: `🗑 ${shortTitle} — ${ownerLabel}`, callback_data: `admin:removelive:${task._id}:${page}` }]);
  }

  const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));
  const navRow = [];
  if (page > 0) navRow.push({ text: '⬅️ Prev', callback_data: `admin:livetasks:${page - 1}` });
  if (page < totalPages - 1) navRow.push({ text: '➡️ Next', callback_data: `admin:livetasks:${page + 1}` });
  if (navRow.length) rows.push(navRow);
  rows.push([{ text: '⬅️ Back to Menu', callback_data: 'admin:menu' }]);

  await tgEdit(
    chatId,
    messageId,
    `🗒 <b>Live Tasks</b> (${totalCount} total) — page ${page + 1}/${totalPages}\n\nTap a task to remove it instantly:`,
    { reply_markup: { inline_keyboard: rows } }
  );
}

/** Handles each text message the admin sends while inside the "create task" flow. */
async function handleAdminTaskCreationText(db, chatId, adminId, state, text) {
  const { step, data } = state;
  const total = data.totalSteps || 5;

  if (step === 'ct_title') {
    data.title = text;
    const needsTarget = data.needsTarget;
    if (needsTarget) {
      await setAdminState(db, adminId, 'ct_target', data);
      await tgSend(chatId, `➕ <b>Create Task — Step 3/${total}</b>\n\nTitle: ✅ <b>${data.title}</b>\n\n🎯 Send the target channel/group @username or chat id (bot must be admin there):`, cancelKb());
    } else {
      await setAdminState(db, adminId, 'ct_link', data);
      await tgSend(chatId, `➕ <b>Create Task — Step 3/${total}</b>\n\nTitle: ✅ <b>${data.title}</b>\n\n🔗 Send the task link (URL):`, cancelKb());
    }
    return;
  }

  if (step === 'ct_target') {
    data.targetChatId = text;
    await setAdminState(db, adminId, 'ct_link', data);
    await tgSend(chatId, `➕ <b>Create Task — Step 4/${total}</b>\n\nTarget: ✅ <code>${data.targetChatId}</code>\n\n🔗 Send the task link (URL):`, cancelKb());
    return;
  }

  if (step === 'ct_link') {
    data.link = text;
    const stepNum = data.needsTarget ? 5 : 4;
    await setAdminState(db, adminId, 'ct_slots', data);
    await tgSend(chatId, `➕ <b>Create Task — Step ${stepNum}/${total}</b>\n\nLink: ✅ ${data.link}\n\n🎟 Send number of slots (e.g. 50, 100, 500):`, cancelKb());
    return;
  }

  if (step === 'ct_slots') {
    const slots = Number(text);
    if (!Number.isInteger(slots) || slots <= 0) {
      await tgSend(chatId, '⚠️ Please send a valid positive number.', cancelKb());
      return;
    }
    data.totalSlots = slots;
    const stepNum = data.needsTarget ? 6 : 5;
    await setAdminState(db, adminId, 'ct_photo', data);
    await tgSend(chatId, `➕ <b>Create Task — Step ${stepNum}/${total}</b>\n\nSlots: ✅ ${data.totalSlots}\n\n🖼 Send a direct photo link for this task, or type "skip":`, cancelKb());
    return;
  }

  if (step === 'ct_photo') {
    data.photoUrl = text.toLowerCase() === 'skip' ? null : text;
    await setAdminState(db, adminId, 'ct_confirm', data);

    const preview =
      `➕ <b>Create Task — Preview</b>\n\n` +
      `📌 Type: <b>${TASK_TYPES[data.type].label}</b>\n` +
      `📝 Title: <b>${data.title}</b>\n` +
      (data.targetChatId ? `🎯 Target: <code>${data.targetChatId}</code>\n` : '') +
      `🔗 Link: ${data.link}\n` +
      `🎟 Slots: <b>${data.totalSlots}</b>\n` +
      `🖼 Photo: ${data.photoUrl ? 'attached' : 'none'}\n\n` +
      `Everything look right?`;

    await tgSend(chatId, preview, {
      reply_markup: {
        inline_keyboard: [
          [
            { text: '✅ Confirm & Create', callback_data: 'admin:ct_confirm' },
            { text: '❌ Cancel', callback_data: 'admin:ct_cancel' },
          ],
        ],
      },
    });
    return;
  }
}

/** Handles each text message the admin sends while creating a promo code. */
async function handleAdminPromoText(db, chatId, adminId, state, text) {
  const { step, data } = state;

  if (step === 'promo_amount') {
    const amount = Number(text);
    if (!Number.isInteger(amount) || amount <= 0) {
      await tgSend(chatId, '⚠️ Please send a valid positive number.', cancelKb());
      return;
    }
    data.amountTC = amount;
    await setAdminState(db, adminId, 'promo_maxclaims', data);
    await tgSend(chatId, `🎁 <b>Generate Promo Code — Step 2/2</b>\n\nReward: ✅ ${data.amountTC} TC\n\n👥 How many people can claim this code? Send a number, or type "unlimited":`, cancelKb());
    return;
  }

  if (step === 'promo_maxclaims') {
    let maxClaims = null;
    if (text.toLowerCase() !== 'unlimited') {
      const n = Number(text);
      if (!Number.isInteger(n) || n <= 0) {
        await tgSend(chatId, '⚠️ Please send a valid positive number, or type "unlimited".', cancelKb());
        return;
      }
      maxClaims = n;
    }
    data.maxClaims = maxClaims;
    await setAdminState(db, adminId, 'promo_confirm', data);

    const preview =
      `🎁 <b>Promo Code Preview</b>\n\n` +
      `💰 Reward: <b>${data.amountTC} TC</b> per claim\n` +
      `👥 Max claims: <b>${maxClaims || 'unlimited'}</b>\n\n` +
      `Everything look right?`;

    await tgSend(chatId, preview, {
      reply_markup: {
        inline_keyboard: [
          [
            { text: '✅ Confirm & Create', callback_data: 'admin:promo_confirm' },
            { text: '❌ Cancel', callback_data: 'admin:promo_cancel' },
          ],
        ],
      },
    });
    return;
  }
}

/** Handles each text message the admin sends while composing a broadcast. */
async function handleAdminBroadcastText(db, chatId, adminId, state, text) {
  const { step, data } = state;

  if (step === 'broadcast_text') {
    data.text = text;
    await setAdminState(db, adminId, 'broadcast_confirm', data);
    await tgSend(chatId, `📢 <b>Broadcast — Step 2/2 (Preview)</b>\n\n${text}\n\n— Send this to all users?`, {
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
    await tgSend(chatId, '⚠️ Please send a valid non-zero whole number (negative to subtract).', cancelKb());
    return;
  }

  const { targetId } = state.data;
  await setAdminState(db, adminId, 'adjust_confirm', { targetId, amount });

  const preview =
    `💰 <b>Adjust Balance Preview</b>\n\n` +
    `👤 User: <code>${targetId}</code>\n` +
    `📈 Change: <b>${amount > 0 ? '+' : ''}${amount} TC</b>\n\n` +
    `Apply this change?`;

  await tgSend(chatId, preview, {
    reply_markup: {
      inline_keyboard: [
        [
          { text: '✅ Confirm', callback_data: 'admin:adjust_confirm' },
          { text: '❌ Cancel', callback_data: 'admin:adjust_cancel' },
        ],
      ],
    },
  });
}

/** Handles the Task ID the admin sends after tapping "Remove Task". */
async function handleAdminRemoveTaskText(db, chatId, adminId, taskIdText) {
  const taskId = taskIdText.trim();
  const task = await findTaskById(db, taskId);

  if (!task) {
    await tgSend(chatId, '⚠️ No task found with that ID. Double-check and try again, or tap Cancel:', cancelKb());
    return;
  }

  await setAdminState(db, adminId, 'remove_task_confirm', { taskId });

  await tgSend(
    chatId,
    `🗑️ <b>Remove Task Preview</b>\n\n` +
      `📝 ${task.title}\n` +
      `📌 Status: ${task.status}\n` +
      `🆔 <code>${task._id}</code>\n\n` +
      `This is permanent. Remove it?`,
    {
      reply_markup: {
        inline_keyboard: [
          [
            { text: '✅ Confirm & Remove', callback_data: `admin:removetask_confirm:${task._id}` },
            { text: '❌ Cancel', callback_data: 'admin:removetask_cancel' },
          ],
        ],
      },
    }
  );
}

/** Handles each text message the admin sends while sending a gift. */
async function handleAdminGiftText(db, chatId, adminId, state, text) {
  const { step, data } = state;

  if (step === 'gift_target') {
    const user = await findUserByIdOrUsername(db, text);
    if (!user) {
      await tgSend(chatId, '⚠️ No user found — try again, or tap Cancel:', cancelKb());
      return;
    }
    const posterName = user.username ? `@${user.username}` : user.firstName || user.telegramId;
    data.targetId = user.telegramId;
    data.targetLabel = posterName;
    await setAdminState(db, adminId, 'gift_amount', data);
    await tgSend(chatId, `🎁 <b>Send Gift — Step 2/2</b>\n\nTarget: ✅ ${posterName} (<code>${user.telegramId}</code>)\n\nHow many TC?`, cancelKb());
    return;
  }

  if (step === 'gift_amount') {
    const amount = Number(text);
    if (!Number.isInteger(amount) || amount <= 0) {
      await tgSend(chatId, '⚠️ Please send a valid positive number.', cancelKb());
      return;
    }
    data.amount = amount;
    await setAdminState(db, adminId, 'gift_confirm', data);

    const preview =
      `🎁 <b>Gift Preview</b>\n\n` +
      `👤 To: <b>${data.targetLabel}</b> (<code>${data.targetId}</code>)\n` +
      `💰 Amount: <b>${amount} TC</b>\n\n` +
      `Send this gift?`;

    await tgSend(chatId, preview, {
      reply_markup: {
        inline_keyboard: [
          [
            { text: '✅ Confirm & Send', callback_data: 'admin:gift_confirm' },
            { text: '❌ Cancel', callback_data: 'admin:gift_cancel' },
          ],
        ],
      },
    });
    return;
  }
}
