// lib/taskService.js — Shared task-posting + admin-review logic.
// Used by:
//   api/app.js  → postTask()            (user submits a task from Mini App)
//   api/bot.js  → reviewTask()          (admin taps Approve/Reject/Not Found/Adult)
//
// Keeping this in lib/ (not its own api/ file) means it does NOT count
// against the Vercel Hobby 12-function limit.

import { ObjectId } from 'mongodb';
import { tgSend } from './telegram.js';
import { createTaskDoc } from './schema.js';
import { TASK_RULES, TASK_TYPES, MODERATION_POLICY } from './constants.js';

const ADMIN_ID = Number(process.env.ADMIN_TELEGRAM_ID);

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * User submits a new task from the Mini App.
 * Validates everything server-side — never trust client-submitted numbers.
 *
 * @returns {{ok: true, task}} or {{ok: false, error: string}}
 */
export async function postTask(db, { ownerId, type, title, link, targetChatId, totalSlots }) {
  const users = db.collection('users');
  const tasks = db.collection('tasks');

  const user = await users.findOne({ telegramId: ownerId });
  if (!user) return { ok: false, error: 'user_not_found' };
  if (user.banned) return { ok: false, error: 'banned' };

  if (!TASK_TYPES[type]) return { ok: false, error: 'invalid_type' };
  if (TASK_TYPES[type].api_verify && !targetChatId) {
    return { ok: false, error: 'target_chat_required' };
  }

  if (!Number.isInteger(totalSlots) || totalSlots < TASK_RULES.minPostAmount) {
    return { ok: false, error: 'below_minimum' };
  }
  if (totalSlots % TASK_RULES.mustBeMultipleOf !== 0) {
    return { ok: false, error: 'not_multiple_of_50' };
  }

  // Daily post-count reset + limit check
  const today = todayStr();
  const tasksToday = user.tasksToday && user.tasksToday.date === today ? user.tasksToday.count : 0;
  if (tasksToday >= TASK_RULES.maxPostsPerUserPerDay) {
    return { ok: false, error: 'daily_limit_reached' };
  }

  const costTC = totalSlots; // 1 TC per slot
  if (user.balanceTC < costTC) {
    return { ok: false, error: 'insufficient_balance' };
  }

  const task = createTaskDoc({ ownerId, type, title, link, targetChatId: targetChatId || null, totalSlots });
  const insertResult = await tasks.insertOne(task);
  task._id = insertResult.insertedId;

  await users.updateOne(
    { telegramId: ownerId },
    {
      $inc: { balanceTC: -costTC, postCount: 1 },
      $set: {
        tasksToday: { date: today, count: tasksToday + 1 },
        updatedAt: new Date(),
      },
    }
  );

  await notifyAdminForReview(task, user);

  return { ok: true, task };
}

/** Sends the admin a review prompt with Approve / Reject / Not Found / Adult buttons. */
async function notifyAdminForReview(task, ownerUser) {
  if (!ADMIN_ID) {
    console.warn('[taskService] ADMIN_TELEGRAM_ID not set — cannot send review notification');
    return;
  }

  const posterName = ownerUser.username ? `@${ownerUser.username}` : ownerUser.firstName || ownerUser.telegramId;

  const text =
    `🆕 <b>New task pending review</b>\n\n` +
    `👤 From: ${posterName} (<code>${ownerUser.telegramId}</code>)\n` +
    `📌 Type: ${TASK_TYPES[task.type]?.label || task.type}\n` +
    `📝 Title: ${task.title}\n` +
    `🔗 Link: ${task.link}\n` +
    (task.targetChatId ? `🎯 Target chat: <code>${task.targetChatId}</code>\n` : '') +
    `🎟 Slots: ${task.totalSlots} (cost: ${task.costTC} TC)`;

  await tgSend(ADMIN_ID, text, {
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
  });
}

/**
 * Admin taps a review button. Applies the decision, updates balances /
 * strikes / ban status, and notifies the task poster.
 *
 * @param {string} decision - 'approved' | 'rejected' | 'not_found' | 'adult'
 * @returns {{ok: true, task, posterMessage: string}} or {{ok: false, error}}
 */
export async function reviewTask(db, taskId, decision) {
  const tasks = db.collection('tasks');
  const users = db.collection('users');

  const task = await tasks.findOne({ _id: new ObjectId(taskId) });
  if (!task) return { ok: false, error: 'task_not_found' };
  if (task.status !== 'pending') return { ok: false, error: 'already_reviewed' };

  const owner = await users.findOne({ telegramId: task.ownerId });
  let posterMessage = '';

  if (decision === 'approved') {
    await tasks.updateOne(
      { _id: task._id },
      { $set: { status: 'live', reviewedAt: new Date() } }
    );
    posterMessage = `✅ Your task "<b>${task.title}</b>" was approved and is now live in the feed!`;
  } else if (decision === 'rejected') {
    await tasks.updateOne(
      { _id: task._id },
      { $set: { status: 'rejected', rejectionReason: 'other', reviewedAt: new Date() } }
    );

    const newStrikes = (owner?.strikes || 0) + 1;
    const willBan = newStrikes >= MODERATION_POLICY.strikesBeforeBan;

    await users.updateOne(
      { telegramId: task.ownerId },
      {
        $set: {
          strikes: newStrikes,
          updatedAt: new Date(),
          ...(willBan ? { banned: true, banReason: 'repeated_violation' } : {}),
        },
      }
    );

    posterMessage = willBan
      ? `🚫 Your task "<b>${task.title}</b>" was rejected. This was your 2nd violation — your account has been <b>permanently banned</b>.`
      : `⚠️ Your task "<b>${task.title}</b>" was rejected. Your ${task.costTC} TC was <b>not</b> refunded. This is a warning (strike ${newStrikes}/${MODERATION_POLICY.strikesBeforeBan}) — one more violation results in a permanent ban.`;
  } else if (decision === 'not_found') {
    await tasks.updateOne(
      { _id: task._id },
      { $set: { status: 'not_found', reviewedAt: new Date() } }
    );

    if (MODERATION_POLICY.refundOnNotFound) {
      await users.updateOne(
        { telegramId: task.ownerId },
        { $inc: { balanceTC: task.costTC }, $set: { updatedAt: new Date() } }
      );
    }

    posterMessage = MODERATION_POLICY.refundOnNotFound
      ? `🔍 Your task "<b>${task.title}</b>" could not be verified (link/channel not found). Your ${task.costTC} TC has been refunded.`
      : `🔍 Your task "<b>${task.title}</b>" could not be verified (link/channel not found).`;
  } else if (decision === 'adult') {
    await tasks.updateOne(
      { _id: task._id },
      { $set: { status: 'rejected', rejectionReason: 'adult', reviewedAt: new Date() } }
    );
    await users.updateOne(
      { telegramId: task.ownerId },
      { $set: { banned: true, banReason: 'adult_content', updatedAt: new Date() } }
    );
    posterMessage = `🚫 Your task "<b>${task.title}</b>" contained adult/18+ content. Your account has been <b>permanently banned</b> and your balance forfeited.`;
  } else {
    return { ok: false, error: 'invalid_decision' };
  }

  if (task.ownerId) {
    await tgSend(task.ownerId, posterMessage);
  }

  return { ok: true, task, posterMessage };
}
