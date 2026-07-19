// lib/adminService.js — Admin-only operations: dashboard stats, direct
// task creation (bypasses approval + cost, since the admin IS the reviewer).
// More admin features (promo codes, gifts, broadcast, user lookup, top
// referrers) get added here in later steps — same pattern.

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
export async function adminCreateTask(db, { type, title, link, targetChatId, totalSlots, photoUrl, adminId }) {
  const tasks = db.collection('tasks');

  const task = createTaskDoc({
    ownerId: adminId,
    type,
    title,
    link,
    targetChatId: targetChatId || null,
    totalSlots,
    photoUrl: photoUrl || null,
    postedByAdmin: true,
  });

  const insertResult = await tasks.insertOne(task);
  task._id = insertResult.insertedId;

  return { ok: true, task };
}
