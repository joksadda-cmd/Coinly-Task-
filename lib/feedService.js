// lib/feedService.js — Task completion, the discovery feed, like/dislike,
// and profile viewing. Used by api/app.js.

import { ObjectId } from 'mongodb';
import { isMember, tgSend } from './telegram.js';
import { TASK_TYPES, TASK_COMPLETE_REWARD_TC, FORCE_JOIN_CHANNELS, REFERRAL_BONUS_TC, REFERRAL_ACTIVATION_TASKS } from './constants.js';

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

  // Referral bonus activation — checked on every completion, but only ever
  // pays out once per referred user (guarded by referralRewardGiven).
  if (user.referredBy && !user.referralRewardGiven) {
    await maybeActivateReferral(db, { referredUserId: telegramId, referrerId: user.referredBy });
  }

  return { ok: true, reward: TASK_COMPLETE_REWARD_TC, newBalance: user.balanceTC + TASK_COMPLETE_REWARD_TC, taskNowFull: isNowFull };
}

/**
 * Checks whether a referred user has now completed enough tasks
 * (REFERRAL_ACTIVATION_TASKS) to activate their referrer's bonus. If so,
 * pays the referrer, marks the referred user so it can never fire twice,
 * and sends the referrer a Telegram notification.
 *
 * Anti-cheat rationale: paying referrers only after the referred account
 * shows real activity (not just a signup) stops people farming fake/alt
 * accounts for free instant TC.
 */
async function maybeActivateReferral(db, { referredUserId, referrerId }) {
  const users = db.collection('users');
  const completions = db.collection('taskCompletions');

  const completedCount = await completions.countDocuments({ userId: referredUserId });
  if (completedCount < REFERRAL_ACTIVATION_TASKS) return;

  // Atomic guard: only proceeds if referralRewardGiven is still false —
  // prevents a double-pay race if two completions land at nearly the same time.
  const claim = await users.updateOne(
    { telegramId: referredUserId, referralRewardGiven: { $ne: true } },
    { $set: { referralRewardGiven: true, updatedAt: new Date() } }
  );
  if (claim.modifiedCount === 0) return; // already activated by a previous call

  const referrer = await users.findOne({ telegramId: referrerId });
  if (!referrer || referrer.banned) return;

  await users.updateOne(
    { telegramId: referrerId },
    { $inc: { balanceTC: REFERRAL_BONUS_TC, referralCount: 1 }, $set: { updatedAt: new Date() } }
  );

  await tgSend(
    referrerId,
    `🎉 Your referral just completed ${REFERRAL_ACTIVATION_TASKS} tasks!\nYou received +${REFERRAL_BONUS_TC} TC.`
  );
}

/** Discovery feed — only 'live' tasks, newest first. Marks which ones this user already completed. */
export async function getFeed(db, { telegramId, limit = 20, skip = 0 }) {
  const tasks = db.collection('tasks');
  const completions = db.collection('taskCompletions');
  const users = db.collection('users');

  const list = await tasks
    .find({ status: 'live' })
    .sort({ createdAt: -1 })
    .skip(skip)
    .limit(limit)
    .toArray();

  const taskIds = list.map((t) => t._id);
  const myCompletions = await completions.find({ userId: telegramId, taskId: { $in: taskIds } }).toArray();
  const completedSet = new Set(myCompletions.map((c) => c.taskId.toString()));

  // Batch-fetch posters so every card can show who posted it
  const ownerIds = [...new Set(list.map((t) => t.ownerId))];
  const owners = await users
    .find({ telegramId: { $in: ownerIds } }, { projection: { telegramId: 1, username: 1, firstName: 1 } })
    .toArray();
  const ownerMap = new Map(owners.map((o) => [o.telegramId, o]));

  return {
    ok: true,
    tasks: list.map((t) => {
      const owner = ownerMap.get(t.ownerId);
      return {
        _id: t._id,
        type: t.type,
        title: t.title,
        link: t.link,
        description: t.description,
        totalSlots: t.totalSlots,
        completedSlots: t.completedSlots,
        likes: t.likes.length,
        dislikes: t.dislikes.length,
        likedByMe: t.likes.includes(telegramId),
        dislikedByMe: t.dislikes.includes(telegramId),
        ownerId: t.ownerId,
        ownerName: t.postedByAdmin ? 'Coinly Task Admin' : owner ? (owner.username ? `@${owner.username}` : owner.firstName) : 'Unknown',
        alreadyCompletedByMe: completedSet.has(t._id.toString()),
        createdAt: t.createdAt,
      };
    }),
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
 * User deletes their OWN posted task (from the Mini App profile screen).
 * Only the owner can delete it — never trust a client-submitted ownerId.
 * No refund on self-delete (mirrors admin removal behavior); the user
 * chose to take it down themselves.
 */
export async function deleteOwnTask(db, { telegramId, taskId }) {
  const tasks = db.collection('tasks');

  let task;
  try {
    task = await tasks.findOne({ _id: new ObjectId(taskId) });
  } catch (e) {
    return { ok: false, error: 'task_not_found' };
  }
  if (!task) return { ok: false, error: 'task_not_found' };
  if (task.ownerId !== telegramId) return { ok: false, error: 'not_owner' };

  await tasks.deleteOne({ _id: task._id });
  return { ok: true, task };
}

/**
 * Mandatory-join gate — checks the user's membership in every chat listed
 * in FORCE_JOIN_CHANNELS (lib/constants.js). Called on Mini App startup,
 * before the person can reach the main tabs.
 *
 * ⚠️ Requires the bot to already be a member (admin, for channels) of each
 * target chat — otherwise Telegram's getChatMember call fails for everyone,
 * every time. That setup step happens in Telegram, not in this code.
 */
export async function checkForceJoin(telegramId) {
  const results = await Promise.all(
    FORCE_JOIN_CHANNELS.map(async (ch) => {
      const membership = await isMember(`@${ch.username}`, telegramId);
      return { ...ch, joined: !!membership.joined, checkFailed: !membership.ok };
    })
  );
  return { ok: true, allJoined: results.every((r) => r.joined), channels: results };
}

/**
 * Public Top 20 referrers leaderboard — sanitized (no balance, no telegramId
 * exposed beyond what's needed to show a name), usable by any logged-in user.
 */
export async function getReferralLeaderboard(db, limit = 20) {
  const users = db
    .collection('users')
    .find({ referralCount: { $gt: 0 } }, { projection: { telegramId: 1, username: 1, firstName: 1, referralCount: 1 } })
    .sort({ referralCount: -1 })
    .limit(limit);

  const list = await users.toArray();
  return list.map((u, i) => ({
    rank: i + 1,
    telegramId: u.telegramId,
    name: u.username ? `@${u.username}` : u.firstName || 'Anonymous',
    referralCount: u.referralCount,
  }));
}

/**
 * Follow or unfollow another user. Toggling twice removes the follow.
 * A user cannot follow themselves.
 */
export async function toggleFollow(db, { followerId, targetTelegramId }) {
  if (followerId === targetTelegramId) return { ok: false, error: 'cannot_follow_self' };

  const users = db.collection('users');
  const target = await users.findOne({ telegramId: targetTelegramId });
  if (!target) return { ok: false, error: 'user_not_found' };

  const alreadyFollowing = (target.followers || []).includes(followerId);

  if (alreadyFollowing) {
    await users.updateOne({ telegramId: targetTelegramId }, { $pull: { followers: followerId } });
    await users.updateOne({ telegramId: followerId }, { $pull: { following: targetTelegramId } });
  } else {
    await users.updateOne({ telegramId: targetTelegramId }, { $addToSet: { followers: followerId } });
    await users.updateOne({ telegramId: followerId }, { $addToSet: { following: targetTelegramId } });
  }

  const updatedTarget = await users.findOne({ telegramId: targetTelegramId });
  return { ok: true, following: !alreadyFollowing, followerCount: (updatedTarget.followers || []).length };
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
  const completions = db.collection('taskCompletions');

  const target = await users.findOne({ telegramId: targetTelegramId });
  if (!target) return { ok: false, error: 'user_not_found' };

  const isSelf = viewerId === targetTelegramId;

  const liveTasks = await tasks
    .find({ ownerId: targetTelegramId, status: 'live' })
    .sort({ createdAt: -1 })
    .toArray();

  const completedCount = await completions.countDocuments({ userId: targetTelegramId });

  return {
    ok: true,
    profile: {
      telegramId: target.telegramId,
      username: target.username,
      firstName: target.firstName,
      postCount: target.postCount,
      completedCount,
      referralCount: target.referralCount,
      followerCount: (target.followers || []).length,
      followingCount: (target.following || []).length,
      isFollowedByMe: !isSelf && (target.followers || []).includes(viewerId),
      isSelf,
      // Balance and daily counters are private — only shown to the account owner
      balanceTC: isSelf ? target.balanceTC : undefined,
      tasks: liveTasks.map((t) => ({
        _id: t._id,
        type: t.type,
        title: t.title,
        description: t.description,
        totalSlots: t.totalSlots,
        completedSlots: t.completedSlots,
        likes: t.likes.length,
        dislikes: t.dislikes.length,
        createdAt: t.createdAt,
      })),
    },
  };
    }
