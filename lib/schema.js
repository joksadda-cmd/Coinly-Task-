// lib/schema.js — Database shape reference + default-document factories
//
// We're using the native MongoDB driver (no Mongoose), so there's no
// enforced schema at the DB level. This file is our source of truth for
// what each collection's documents look like, and gives us one place to
// create a "fresh" document with all fields correctly defaulted.
//
// Collections used:
//   users            — one doc per Telegram user
//   tasks            — one doc per posted task
//   taskCompletions  — one doc per (user, task) completion — prevents double-claim
//
// Design notes:
// - Daily counters (ads watched, spin, streak) live directly on the user
//   doc instead of a separate collection — fewer round trips, and daily
//   reset is just "if storedDate !== today, reset to 0" done in code.
// - Referrals are NOT a separate collection for now — `referredBy` +
//   `referralCount` on the user doc is enough for this project's needs.
//   (Easy to split into its own collection later if we need a referral
//   audit log.)

import { LOGIN_STREAK_REWARDS_TC } from './constants.js';

/**
 * users collection
 * Indexed on: telegramId (unique)
 *
 * {
 *   telegramId: Number,          // Telegram user id — primary lookup key
 *   username: String|null,
 *   firstName: String,
 *   balanceTC: Number,
 *   postCount: Number,           // LIFETIME count of tasks ever posted (never decreases, even after task data is purged)
 *   referredBy: Number|null,     // telegramId of referrer, or null
 *   referralRewardGiven: Boolean,// true once the referrer has been paid for THIS user (paid on 5th task completion, not on signup)
 *   referralCount: Number,       // how many people THIS user has referred (only counts ones whose reward has activated)
 *   strikes: Number,             // 0, 1, or 2 (2 = should already be banned)
 *   banned: Boolean,
 *   banReason: String|null,      // 'adult_content' | 'repeated_violation' | null
 *   multiAccountFlag: Boolean,   // tracking only, NOT a block — admin visibility
 *   followers: [Number],         // telegramIds of people following this user
 *   following: [Number],         // telegramIds this user follows
 *   streak: {
 *     count: Number,             // current streak day (1-7, cycles back to 1 after 7 or after a missed day)
 *     lastClaimDate: String|null // 'YYYY-MM-DD'
 *   },
 *   spin: {
 *     lastClaimDate: String|null // 'YYYY-MM-DD'
 *   },
 *   adsToday: {
 *     date: String,               // 'YYYY-MM-DD' — reset trigger
 *     adsgram: Number,
 *     gigapub: Number,
 *     monetag: Number,
 *     lastClaimAt: Date|null      // used for the 30s global cooldown
 *   },
 *   tasksToday: {
 *     date: String,               // 'YYYY-MM-DD'
 *     count: Number                // resets daily, capped at maxPostsPerUserPerDay
 *   },
 *   createdAt: Date,
 *   updatedAt: Date
 * }
 */
export function createUserDoc({ telegramId, username = null, firstName = '', referredBy = null }) {
  const today = new Date().toISOString().slice(0, 10);
  return {
    telegramId,
    username,
    firstName,
    balanceTC: 0,
    postCount: 0,
    referredBy,
    referralRewardGiven: false,
    referralCount: 0,
    strikes: 0,
    banned: false,
    banReason: null,
    multiAccountFlag: false,
    followers: [],
    following: [],
    streak: { count: 0, lastClaimDate: null },
    spin: { lastClaimDate: null },
    adsToday: { date: today, adsgram: 0, gigapub: 0, monetag: 0, lastClaimAt: null },
    tasksToday: { date: today, count: 0 },
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

/**
 * tasks collection
 * Indexed on: ownerId, status
 *
 * {
 *   ownerId: Number,             // telegramId of poster (admin's own id if postedByAdmin)
 *   type: String,                // key from TASK_TYPES in constants.js
 *   title: String,
 *   link: String,                // the URL/username user is sent to
 *   photoUrl: String|null,       // optional direct image link shown on the task card
 *   description: String|null,    // optional, up to 80 words, plain text (rendered with escapeHtml on frontend)
 *   postedByAdmin: Boolean,      // true = admin posted directly, skips approval + cost
 *   targetChatId: String|null,   // only for telegram_channel_join / telegram_group_join (used by isMember())
 *   totalSlots: Number,          // multiple of 50 for user posts — also equals TC cost paid to post
 *   completedSlots: Number,      // increments as users complete it
 *   costTC: Number,              // TC spent to post (== totalSlots, or 0 if postedByAdmin)
 *   status: String,              // 'pending' | 'live' | 'rejected' | 'not_found' | 'completed'
 *   rejectionReason: String|null,// 'adult' | 'other' | null
 *   likes: [Number],             // array of telegramIds who liked
 *   dislikes: [Number],          // array of telegramIds who disliked
 *   createdAt: Date,
 *   reviewedAt: Date|null,
 *   completedAt: Date|null,      // set when completedSlots reaches totalSlots — triggers 48h purge timer
 * }
 */
export function createTaskDoc({
  ownerId,
  type,
  title,
  link,
  targetChatId = null,
  totalSlots,
  photoUrl = null,
  description = null,
  postedByAdmin = false,
}) {
  return {
    ownerId,
    type,
    title,
    link,
    photoUrl,
    description,
    postedByAdmin,
    targetChatId,
    totalSlots,
    completedSlots: 0,
    costTC: postedByAdmin ? 0 : totalSlots, // admin posts are free — not paid from admin's own balance
    status: postedByAdmin ? 'live' : 'pending', // admin posts skip the review queue entirely
    rejectionReason: null,
    likes: [],
    dislikes: [],
    createdAt: new Date(),
    reviewedAt: postedByAdmin ? new Date() : null,
    completedAt: null,
  };
}

/**
 * taskCompletions collection
 * Indexed on: compound unique (taskId, userId) — prevents the same user
 * claiming the same task twice.
 *
 * {
 *   taskId: ObjectId,
 *   userId: Number,           // telegramId of completer
 *   rewardTC: Number,
 *   completedAt: Date
 * }
 */
export function createTaskCompletionDoc({ taskId, userId, rewardTC }) {
  return {
    taskId,
    userId,
    rewardTC,
    completedAt: new Date(),
  };
}

/**
 * Helper: is a stored 'YYYY-MM-DD' date string today?
 * Used everywhere we need daily-reset logic (ads, spin, tasksToday).
 */
export function isToday(dateStr) {
  return dateStr === new Date().toISOString().slice(0, 10);
}

/**
 * Helper: compute the next login-streak day + reward.
 * Call this when user opens the app/bot for the day.
 *
 * @param {{count: number, lastClaimDate: string|null}} streak
 * @returns {{ newCount: number, rewardTC: number, alreadyClaimedToday: boolean }}
 */
export function computeStreakClaim(streak) {
  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);

  if (streak.lastClaimDate === today) {
    return { newCount: streak.count, rewardTC: 0, alreadyClaimedToday: true };
  }

  // Continue streak only if last claim was exactly yesterday; otherwise reset to day 1
  const continuing = streak.lastClaimDate === yesterday;
  const newCount = continuing ? (streak.count % 7) + 1 : 1;
  const rewardTC = LOGIN_STREAK_REWARDS_TC[newCount - 1];

  return { newCount, rewardTC, alreadyClaimedToday: false };
}
