// lib/engagement.js — Daily engagement rewards: ad claims, free spin, and
// login streak. All server-side, all with daily-reset + anti-abuse checks.
// Used by api/app.js.

import { AD_NETWORKS, DAILY_SPIN, ANTI_CHEAT } from './constants.js';
import { computeStreakClaim } from './schema.js';

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * User watched an ad on one of the supported networks and wants their
 * reward. Validates daily limit per network + a global cooldown between
 * ANY ad claims (blocks script/Termux rapid-fire clicking).
 */
export async function claimAd(db, { telegramId, network }) {
  const users = db.collection('users');
  const user = await users.findOne({ telegramId });

  if (!user) return { ok: false, error: 'user_not_found' };
  if (user.banned) return { ok: false, error: 'banned' };

  const networkConfig = AD_NETWORKS[network];
  if (!networkConfig) return { ok: false, error: 'invalid_network' };

  const today = todayStr();
  const adsToday =
    user.adsToday && user.adsToday.date === today
      ? user.adsToday
      : { date: today, adsgram: 0, gigapub: 0, monetag: 0, lastClaimAt: null };

  // Global cooldown — any network, not just this one
  if (adsToday.lastClaimAt) {
    const secondsSinceLast = (Date.now() - new Date(adsToday.lastClaimAt).getTime()) / 1000;
    if (secondsSinceLast < ANTI_CHEAT.minSecondsBetweenAdClaims) {
      return {
        ok: false,
        error: 'cooldown',
        retryAfterSeconds: Math.ceil(ANTI_CHEAT.minSecondsBetweenAdClaims - secondsSinceLast),
      };
    }
  }

  // Per-network daily limit
  if (adsToday[network] >= networkConfig.dailyLimit) {
    return { ok: false, error: 'daily_limit_reached' };
  }

  const reward = networkConfig.rewardTC;
  const updatedAdsToday = {
    ...adsToday,
    [network]: adsToday[network] + 1,
    lastClaimAt: new Date(),
  };

  await users.updateOne(
    { telegramId },
    {
      $inc: { balanceTC: reward },
      $set: { adsToday: updatedAdsToday, updatedAt: new Date() },
    }
  );

  return { ok: true, reward, newBalance: user.balanceTC + reward, remainingToday: networkConfig.dailyLimit - updatedAdsToday[network] };
}

/** Daily free spin — once per 24h, random reward within DAILY_SPIN range. */
export async function claimDailySpin(db, { telegramId }) {
  const users = db.collection('users');
  const user = await users.findOne({ telegramId });

  if (!user) return { ok: false, error: 'user_not_found' };
  if (user.banned) return { ok: false, error: 'banned' };
  if (!DAILY_SPIN.enabled) return { ok: false, error: 'spin_disabled' };

  const today = todayStr();
  if (user.spin?.lastClaimDate === today) {
    return { ok: false, error: 'already_claimed_today' };
  }

  const reward = Math.floor(Math.random() * (DAILY_SPIN.maxTC - DAILY_SPIN.minTC + 1)) + DAILY_SPIN.minTC;

  await users.updateOne(
    { telegramId },
    {
      $inc: { balanceTC: reward },
      $set: { spin: { lastClaimDate: today }, updatedAt: new Date() },
    }
  );

  return { ok: true, reward, newBalance: user.balanceTC + reward };
}

/** 7-day login streak claim. Continues if claimed yesterday, else resets to day 1. */
export async function claimLoginStreak(db, { telegramId }) {
  const users = db.collection('users');
  const user = await users.findOne({ telegramId });

  if (!user) return { ok: false, error: 'user_not_found' };
  if (user.banned) return { ok: false, error: 'banned' };

  const { newCount, rewardTC, alreadyClaimedToday } = computeStreakClaim(
    user.streak || { count: 0, lastClaimDate: null }
  );

  if (alreadyClaimedToday) {
    return { ok: false, error: 'already_claimed_today', currentDay: newCount };
  }

  const today = todayStr();
  await users.updateOne(
    { telegramId },
    {
      $inc: { balanceTC: rewardTC },
      $set: { streak: { count: newCount, lastClaimDate: today }, updatedAt: new Date() },
    }
  );

  return { ok: true, day: newCount, reward: rewardTC, newBalance: user.balanceTC + rewardTC };
}
