// lib/adminService.js — Admin-only operations: dashboard stats, direct
// task creation (bypasses approval + cost, since the admin IS the reviewer).
// More admin features (promo codes, gifts, broadcast, user lookup, top
// referrers) get added here in later steps — same pattern.

import { ObjectId } from 'mongodb';
import { createTaskDoc } from './schema.js';

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

/** Dashboard numbers: total users + how many joined today. */
export async function getDashboardStats(db) {
  const users = db.collection('users');
  const tasks = db.collection('tasks');

  const totalUsers = await users.countDocuments();

  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const dailyJoins = await users.countDocuments({ createdAt: { $gte: startOfToday } });

  const liveTasks = await tasks.countDocuments({ status: 'live' });
  const pendingTasks = await tasks.countDocuments({ status: 'pending' });

  const balanceAgg = await users
    .aggregate([{ $group: { _id: null, total: { $sum: '$balanceTC' } } }])
    .toArray();
  const totalTCInCirculation = balanceAgg[0]?.total || 0;

  return { totalUsers, dailyJoins, liveTasks, pendingTasks, totalTCInCirculation };
}

/**
 * Admin posts a task directly — goes straight to 'live', no cost, no
 * approval queue (the admin IS the approver, so there's nothing to review).
 */
export async function adminCreateTask(db, { type, title, link, targetChatId, totalSlots, adminId }) {
  const tasks = db.collection('tasks');

  const task = createTaskDoc({
    ownerId: adminId,
    type,
    title,
    link,
    targetChatId: targetChatId || null,
    totalSlots,
    postedByAdmin: true,
  });

  const insertResult = await tasks.insertOne(task);
  task._id = insertResult.insertedId;

  return { ok: true, task };
}

/** Pending tasks that never got an admin decision (in case a notification was missed). */
export async function listPendingTasks(db, limit = 10) {
  return db.collection('tasks').find({ status: 'pending' }).sort({ createdAt: 1 }).limit(limit).toArray();
}

/** Look up a user by numeric Telegram ID or @username (case-insensitive). */
export async function findUserByIdOrUsername(db, query) {
  const users = db.collection('users');
  const trimmed = (query || '').trim();

  if (/^\d+$/.test(trimmed)) {
    return users.findOne({ telegramId: Number(trimmed) });
  }

  const username = trimmed.replace(/^@/, '');
  return users.findOne({ username: new RegExp(`^${username}$`, 'i') });
}

/** Toggle (or explicitly set) a user's ban status — manual override outside the strike system. */
export async function setUserBanStatus(db, telegramId, banned, banReason = null) {
  await db.collection('users').updateOne(
    { telegramId },
    { $set: { banned, banReason: banned ? banReason || 'manual_ban' : null, updatedAt: new Date() } }
  );
  return db.collection('users').findOne({ telegramId });
}

/** Add (or subtract, with a negative number) TC from a user's balance. Used for manual fixes and gifts. */
export async function adjustUserBalance(db, telegramId, amount) {
  await db.collection('users').updateOne(
    { telegramId },
    { $inc: { balanceTC: amount }, $set: { updatedAt: new Date() } }
  );
  return db.collection('users').findOne({ telegramId });
}

/** Look up a single task by ID without removing it — used to show a preview
 *  before the admin confirms permanent removal. */
export async function findTaskById(db, taskId) {
  try {
    return await db.collection('tasks').findOne({ _id: new ObjectId(taskId) });
  } catch (e) {
    return null;
  }
}

/** Admin permanently removes a task (any status) by ID — e.g. spam, mistake, or a live task gone bad. */
export async function removeTask(db, taskId) {
  const tasks = db.collection('tasks');
  const task = await tasks.findOne({ _id: new ObjectId(taskId) });
  if (!task) return { ok: false, error: 'task_not_found' };
  await tasks.deleteOne({ _id: task._id });
  return { ok: true, task };
}

/** Paginated list of currently LIVE tasks (both user-posted and admin-posted),
 *  newest first — powers the browsable "🗒 Live Tasks" admin view so the
 *  admin can remove any task with one tap instead of typing its ID. */
export async function listLiveTasks(db, { skip = 0, limit = 5 } = {}) {
  const tasks = db.collection('tasks');
  const totalCount = await tasks.countDocuments({ status: 'live' });
  const items = await tasks
    .find({ status: 'live' })
    .sort({ createdAt: -1 })
    .skip(skip)
    .limit(limit)
    .toArray();
  return { items, totalCount };
}

/** Top referrers leaderboard. */
export async function getTopReferrers(db, limit = 10) {
  return db
    .collection('users')
    .find({ referralCount: { $gt: 0 } })
    .sort({ referralCount: -1 })
    .limit(limit)
    .toArray();
}
