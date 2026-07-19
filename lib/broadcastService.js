// lib/broadcastService.js — Sends an admin message to every user.
//
// ⚠️ SCALING NOTE: Vercel Serverless Functions have a max execution time
// (10s on Hobby by default, extendable via vercel.json `functions.maxDuration`
// up to the plan's cap). This loop sends sequentially with a small delay to
// respect Telegram's ~30 messages/sec limit. For a few hundred/thousand
// users this is fine; if the user base grows into the tens of thousands,
// this should be split into batches (e.g. triggered repeatedly via a cron
// job) instead of one single request. Flag this to revisit once user count
// grows — not a concern at current/early scale.

import { tgSend } from './telegram.js';

const DELAY_MS = 40; // ~25 messages/sec, safely under Telegram's limit

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function broadcastToAllUsers(db, text) {
  const users = db.collection('users');
  const cursor = users.find({ banned: { $ne: true } }, { projection: { telegramId: 1 } });

  let sent = 0;
  let failed = 0;

  for await (const user of cursor) {
    try {
      const result = await tgSend(user.telegramId, text);
      if (result.ok) sent++;
      else failed++;
    } catch {
      failed++;
    }
    await sleep(DELAY_MS);
  }

  return { sent, failed };
}
