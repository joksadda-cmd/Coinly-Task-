// lib/verifyInitData.js — Verifies Telegram Mini App `initData` signature.
//
// Docs: https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
//
// WHY THIS MATTERS: without this check, anyone could open browser dev
// tools, fake a request body like { telegramId: <someone else's id> },
// and drain their balance / post tasks as them. `initData` is
// cryptographically signed by Telegram using our BOT_TOKEN, so we can
// verify it server-side and trust the user id inside it — and ONLY that.
// Never trust a telegramId sent directly in a request payload.

import crypto from 'crypto';

const BOT_TOKEN = process.env.BOT_TOKEN;

/**
 * @param {string} initData - raw string from window.Telegram.WebApp.initData
 * @returns {object|null} the trusted Telegram user object ({id, first_name, username, ...})
 *                          or null if missing/invalid/tampered/stale
 */
export function verifyInitData(initData) {
  if (!initData || typeof initData !== 'string') return null;

  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return null;
  params.delete('hash');

  const dataCheckArr = [];
  for (const [key, value] of params.entries()) {
    dataCheckArr.push(`${key}=${value}`);
  }
  dataCheckArr.sort();
  const dataCheckString = dataCheckArr.join('\n');

  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const computedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

  if (computedHash !== hash) return null; // signature mismatch → tampered or fake

  // Reject stale initData (older than 24h) as an extra precaution
  const authDate = Number(params.get('auth_date'));
  if (authDate && Date.now() / 1000 - authDate > 86400) return null;

  const userStr = params.get('user');
  if (!userStr) return null;

  try {
    return JSON.parse(userStr); // { id, first_name, last_name, username, ... }
  } catch {
    return null;
  }
}
