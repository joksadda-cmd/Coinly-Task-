// lib/promoService.js — Admin generates promo codes worth TC; users redeem
// them once each from the Mini App (frontend gates this behind watching an
// ad first — see note in api/app.js redeemPromo action).

import crypto from 'crypto';

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no confusing 0/O/1/I

function generateCode(length = 8) {
  const bytes = crypto.randomBytes(length);
  let code = '';
  for (let i = 0; i < length; i++) code += CODE_CHARS[bytes[i] % CODE_CHARS.length];
  return code;
}

/** Admin creates a new promo code. maxClaims = null means unlimited. */
export async function createPromoCode(db, { amountTC, maxClaims, createdBy }) {
  const code = generateCode();
  const doc = {
    code,
    amountTC,
    maxClaims: maxClaims || null,
    claimedBy: [],
    active: true,
    createdAt: new Date(),
    createdBy,
  };
  await db.collection('promoCodes').insertOne(doc);
  return doc;
}

/** Lists currently active promo codes (most recent first). */
export async function listActivePromoCodes(db, limit = 10) {
  return db.collection('promoCodes').find({ active: true }).sort({ createdAt: -1 }).limit(limit).toArray();
}

/** User redeems a code — one claim per user per code, enforced server-side. */
export async function redeemPromoCode(db, { telegramId, code }) {
  const users = db.collection('users');
  const promoCodes = db.collection('promoCodes');

  const user = await users.findOne({ telegramId });
  if (!user) return { ok: false, error: 'user_not_found' };
  if (user.banned) return { ok: false, error: 'banned' };

  const normalizedCode = (code || '').trim().toUpperCase();
  if (!normalizedCode) return { ok: false, error: 'invalid_code' };

  const promo = await promoCodes.findOne({ code: normalizedCode });
  if (!promo) return { ok: false, error: 'invalid_code' };
  if (!promo.active) return { ok: false, error: 'inactive_code' };
  if (promo.claimedBy.some((id) => id === telegramId)) return { ok: false, error: 'already_claimed' };
  if (promo.maxClaims && promo.claimedBy.length >= promo.maxClaims) return { ok: false, error: 'limit_reached' };

  await promoCodes.updateOne({ _id: promo._id }, { $push: { claimedBy: telegramId } });
  await users.updateOne(
    { telegramId },
    { $inc: { balanceTC: promo.amountTC }, $set: { updatedAt: new Date() } }
  );

  return { ok: true, reward: promo.amountTC, newBalance: user.balanceTC + promo.amountTC };
}
