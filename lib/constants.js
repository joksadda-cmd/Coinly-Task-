// lib/constants.js — Single source of truth for all reward numbers,
// limits, and rules. Change a number here → it applies everywhere.
//
// NOTE: Some values below are placeholders (marked ⚠️). Adjust freely —
// nothing else in the codebase should hardcode these numbers directly.

// ─────────────────────────────────────────────────────────
// CURRENCY
// ─────────────────────────────────────────────────────────
export const CURRENCY_NAME = 'TC'; // Task Coin

// ─────────────────────────────────────────────────────────
// AD NETWORKS — daily watch limit + reward per view
// ─────────────────────────────────────────────────────────
export const AD_NETWORKS = {
  adsgram: { label: 'Adsgram', dailyLimit: 5, rewardTC: 4 }, // higher reward — special
  gigapub: { label: 'GigaPub', dailyLimit: 10, rewardTC: 2 },
  monetag: { label: 'Monetag', dailyLimit: 10, rewardTC: 2 },
};

// ─────────────────────────────────────────────────────────
// TASK COMPLETION REWARD
// ─────────────────────────────────────────────────────────
export const TASK_COMPLETE_REWARD_TC = 2;

// ─────────────────────────────────────────────────────────
// DAILY FREE SPIN  ⚠️ placeholder range — adjust as needed
// ─────────────────────────────────────────────────────────
export const DAILY_SPIN = {
  enabled: true,
  minTC: 1,
  maxTC: 5,
  cooldownHours: 24,
};

// ─────────────────────────────────────────────────────────
// 7-DAY LOGIN STREAK BONUS  ⚠️ placeholder numbers — adjust as needed
// Resets to day 1 if user misses a day; cycles back to day 1 after day 7.
// ─────────────────────────────────────────────────────────
export const LOGIN_STREAK_REWARDS_TC = [1, 1, 2, 2, 3, 3, 5]; // index 0 = Day 1 ... index 6 = Day 7

// ─────────────────────────────────────────────────────────
// REFERRAL
// 15 TC per successful refer ≈ almost enough for a fresh user to unlock
// task-posting (min 50 TC) after ~4 refers.
// ─────────────────────────────────────────────────────────
export const REFERRAL_BONUS_TC = 15;

// ─────────────────────────────────────────────────────────
// TASK POSTING RULES
// ─────────────────────────────────────────────────────────
export const TASK_RULES = {
  minPostAmount: 50,
  mustBeMultipleOf: 50, // 50, 100, 150, 200 ... never 51, 78, 101 etc.
  requiresAdminApproval: true, // stays "pending" until admin approves in bot
  maxPostsPerUserPerDay: 3, // hard cap — no exceptions, no "request more" allowed
};

// ─────────────────────────────────────────────────────────
// TASK TYPES
// api_verify: true  → checked live via Telegram getChatMember (lib/telegram.js)
// api_verify: false → self-reported by user, relies on anti-cheat + admin spot check
// adult_allowed: false → NEVER allow adult content in this task type
// ─────────────────────────────────────────────────────────
export const TASK_TYPES = {
  youtube_subscribe: { label: 'YouTube Subscribe', api_verify: false, adult_allowed: false },
  fb_page_follow: { label: 'Facebook Page Follow', api_verify: false, adult_allowed: false },
  fb_like: { label: 'Facebook Like', api_verify: false, adult_allowed: false },
  telegram_bot: { label: 'Telegram Bot Start', api_verify: false, adult_allowed: false },
  telegram_channel_join: { label: 'Telegram Channel Join', api_verify: true, adult_allowed: false },
  telegram_group_join: { label: 'Telegram Group Join', api_verify: true, adult_allowed: false },
  direct_link: { label: 'Direct Link (Adsterra / 3rd-party)', api_verify: false, adult_allowed: false },
};

// ─────────────────────────────────────────────────────────
// ADULT CONTENT BAN POLICY
// Any task (especially direct_link) flagged/reported as adult content →
// permanent ban, account + all data locked. Shown as a hard warning
// before a user can submit a direct_link task.
// ─────────────────────────────────────────────────────────
export const ADULT_CONTENT_POLICY = {
  banOnAdultContent: true,
  warningText:
    '⚠️ Adult/18+ links are strictly forbidden. Submitting one will result in an immediate, permanent ban of your account and all your TC/tasks. This rule protects everyone — do not risk it.',
};

// ─────────────────────────────────────────────────────────
// ADMIN TASK REVIEW — outcomes when admin reviews a posted task
//
//  approved    → task goes live in the feed
//  rejected    → balance NOT refunded, user gets 1 strike + warning
//  not_found   → link/channel invalid or unreachable — balance IS
//                refunded (assumed not the user's fault; change to
//                `refundOnNotFound: false` below if that's wrong)
//  adult       → instant permanent ban, balance forfeited, NO strike
//                system involved (this skips straight to ban)
// ─────────────────────────────────────────────────────────
export const TASK_REVIEW_OUTCOMES = ['approved', 'rejected', 'not_found', 'adult'];

export const MODERATION_POLICY = {
  refundOnNotFound: true,       // ⚠️ confirm this — see comment above
  refundOnReject: false,        // non-adult reject → balance forfeited
  strikesBeforeBan: 2,          // 1st non-adult reject = warning (strike 1), 2nd = permanent ban
  adultContentSkipsStrikes: true, // adult violation bans immediately, no warning step
};

// ─────────────────────────────────────────────────────────
// DISCOVERY / NEWS FEED
// ─────────────────────────────────────────────────────────
export const FEED_RULES = {
  removeCompletedAfterHours: 48, // task data purged 2 days after it hits 100% completion
  likeDislikeEnabled: true,
  // Profile page: only tasks with status 'live' are shown when visiting
  // someone else's profile. Pending / completed(removed) tasks stay
  // invisible — only the lifetime `postCount` number on the user doc
  // reflects how many they've ever posted.
  profileShowsOnlyLiveTasks: true,
};

// ─────────────────────────────────────────────────────────
// ANTI-CHEAT
// ─────────────────────────────────────────────────────────
export const ANTI_CHEAT = {
  // All balance/point changes MUST happen server-side inside api/app.js
  // or api/bot.js — never trust a client-submitted TC amount.
  maxAdClaimsPerNetworkPerDay: true, // enforced by checking AD_NETWORKS[network].dailyLimit
  minSecondsBetweenAdClaims: 30, // global cooldown — ANY ad claim (any network) blocks the next claim for 30s
};
