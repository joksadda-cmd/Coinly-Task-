// lib/feedService.js — Task completion, the discovery feed, like/dislike,
// and profile viewing. Used by api/app.js.

import { ObjectId } from 'mongodb';
import { isMember } from './telegram.js';
import { TASK_TYPES, TASK_COMPLETE_REWARD_TC } from './constants.js';

/**
 * User taps "Complete" on someone else's task.
 * - channel/group join types → verified live via Telegram getChatMember
 * - everything else → self-reported (same trust model as ad claims; there
 *   is no external API to verify a YouTube subscribe or FB like)
 */
export async function completeTask(db, { telegramId, taskId }) {
  const tasks = db.collection('tasks');
  const users = db.collection('users');
  const completions = db.collection('taskCompletions');

  const task = await tasks.findOne({ _id: new ObjectId(taskId) });
  if (!task) return { ok: false, error: 'task_not_found' };
  if (task.status !== 'live') return { ok: false, error: 'task_not_live' };
  if (task.ownerId === telegramId) return { ok: false, error: 'cannot_complete_own_task' };

  const user = await users.findOne({ telegramId });
  if (!user) return { ok: false, error: 'user_not_found' };
  if (user.banned) return { ok: false, error: 'banned' };

  const already = await completions.findOne({ taskId: task._id, userId: telegramId });
  if (already) return { ok: false, error: 'already_completed' };

  // Live verification for channel/group join tasks
  if (TASK_TYPES[task.type]?.api_verify) {
    const membership = await isMember(task.targetChatId, telegramId);
    if (!membership.ok) return { ok: false, error: 'verification_failed', detail: membership.error };
    if (!membership.joined) return { ok: false, error: 'not_joined' };
  }

  await completions.insertOne({
    taskId: task._id,
    userId: telegramId,
    rewardTC: TASK_COMPLETE_REWARD_TC,
    completedAt: new Date(),
  });

  const newCompletedSlots = task.completedSlots + 1;
  const isNowFull = newCompletedSlots >= task.totalSlots;

  await tasks.updateOne(
    { _id: task._id },
    {
      $set: {
        completedSlots: newCompletedSlots,
        ...(isNowFull ? { status: 'completed', completedAt: new Date() } : {}),
      },
    }
  );

  await users.updateOne(
    { telegramId },
    { $inc: { balanceTC: TASK_COMPLETE_REWARD_TC }, $set: { updatedAt: new Date() } }
  );

  return { ok: true, reward: TASK_COMPLETE_REWARD_TC, newBalance: user.balanceTC + TASK_COMPLETE_REWARD_TC, taskNowFull: isNowFull };
}

/** Discovery feed — only 'live' tasks, newest first. Marks which ones this user already completed. */
export async function getFeed(db, { telegramId, limit = 20, skip = 0 }) {
  const tasks = db.collection('tasks');
  const completions = db.collection('taskCompletions');

  const list = await tasks
    .find({ status: 'live' })
    .sort({ createdAt: -1 })
    .skip(skip)
    .limit(limit)
    .toArray();

  const taskIds = list.map((t) => t._id);
  const myCompletions = await completions.find({ userId: telegramId, taskId: { $in: taskIds } }).toArray();
  const completedSet = new Set(myCompletions.map((c) => c.taskId.toString()));

  return {
    ok: true,
    tasks: list.map((t) => ({
      _id: t._id,
      type: t.type,
      title: t.title,
      link: t.link,
      photoUrl: t.photoUrl,
      totalSlots: t.totalSlots,
      completedSlots: t.completedSlots,
      likes: t.likes.length,
      dislikes: t.dislikes.length,
      likedByMe: t.likes.includes(telegramId),
      dislikedByMe: t.dislikes.includes(telegramId),
      ownerId: t.ownerId,
      alreadyCompletedByMe: completedSet.has(t._id.toString()),
    })),
  };
}

/** Like or dislike a task. Toggling the same reaction twice removes it. Switching removes the old one. */
export async function reactToTask(db, { telegramId, taskId, reaction }) {
  if (!['like', 'dislike'].includes(reaction)) return { ok: false, error: 'invalid_reaction' };

  const tasks = db.collection('tasks');
  const task = await tasks.findOne({ _id: new ObjectId(taskId) });
  if (!task) return { ok: false, error: 'task_not_found' };

  const alreadyLiked = task.likes.includes(telegramId);
  const alreadyDisliked = task.dislikes.includes(telegramId);

  const update = { $pull: {}, $addToSet: {} };

  if (reaction === 'like') {
    if (alreadyLiked) {
      update.$pull.likes = telegramId; // toggle off
    } else {
      update.$addToSet.likes = telegramId;
      if (alreadyDisliked) update.$pull.dislikes = telegramId;
    }
  } else {
    if (alreadyDisliked) {
      update.$pull.dislikes = telegramId; // toggle off
    } else {
      update.$addToSet.dislikes = telegramId;
      if (alreadyLiked) update.$pull.likes = telegramId;
    }
  }

  // Mongo doesn't allow empty $pull/$addToSet objects — strip if unused
  if (Object.keys(update.$pull).length === 0) delete update.$pull;
  if (Object.keys(update.$addToSet).length === 0) delete update.$addToSet;

  await tasks.updateOne({ _id: task._id }, update);
  const updated = await tasks.findOne({ _id: task._id });

  return { ok: true, likes: updated.likes.length, dislikes: updated.dislikes.length };
}

/**
 * Public Top 20 referrers leaderboard — sanitized (no balance, no telegramId
 * exposed beyond what's needed to show a name), usable by any logged-in user.
 */
export async function getReferralLeaderboard(db, limit = 20) {
  const users = db
    .collection('users')
    .find({ referralCount: { $gt: 0 } }, { projection: { username: 1, firstName: 1, referralCount: 1 } })
    .sort({ referralCount: -1 })
    .limit(limit);

  const list = await users.toArray();
  return list.map((u, i) => ({
    rank: i + 1,
    name: u.username ? `@${u.username}` : u.firstName || 'Anonymous',
    referralCount: u.referralCount,
  }));
}

/**
 * View a profile — own or someone else's.
 * Visiting someone ELSE's profile only shows their 'live' tasks (never
 * pending, rejected, not_found, or purged-completed ones) — just the
 * lifetime postCount number reflects the rest.
 */
export async function getProfile(db, { viewerId, targetTelegramId }) {
  const users = db.collection('users');
  const tasks = db.collection('tasks');

  const target = await users.findOne({ telegramId: targetTelegramId });
  if (!target) return { ok: false, error: 'user_not_found' };

  const isSelf = viewerId === targetTelegramId;

  const liveTasks = await tasks
    .find({ ownerId: targetTelegramId, status: 'live' })
    .sort({ createdAt: -1 })
    .toArray();

  return {
    ok: true,
    profile: {
      telegramId: target.telegramId,
      username: target.username,
      firstName: target.firstName,
      postCount: target.postCount,
      referralCount: target.referralCount,
      // Balance and daily counters are private — only shown to the account owner
      balanceTC: isSelf ? target.balanceTC : undefined,
      tasks: liveTasks.map((t) => ({
        _id: t._id,
        type: t.type,
        title: t.title,
        photoUrl: t.photoUrl,
        totalSlots: t.totalSlots,
        completedSlots: t.completedSlots,
        likes: t.likes.length,
        dislikes: t.dislikes.length,
      })),
    },
  };
}
