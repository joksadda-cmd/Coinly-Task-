// api/cron-cleanup.js — Daily sweep that permanently deletes task documents
// whose post-completion retention window has passed (see FEED_RULES.
// removeCompletedAfterHours in lib/constants.js — currently 48h).
// Triggered automatically by Vercel Cron (see vercel.json `crons`).

import { connectToDatabase } from '../lib/mongodb.js';
import { FEED_RULES } from '../lib/constants.js';

export default async function handler(req, res) {
  // Vercel sends "Authorization: Bearer $CRON_SECRET" automatically when a
  // CRON_SECRET env var is set — verifying this stops randoms from hitting
  // this URL directly and forcing early deletions.
  const authHeader = req.headers['authorization'];
  if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }

  try {
    const { db } = await connectToDatabase();
    const cutoff = new Date(Date.now() - FEED_RULES.removeCompletedAfterHours * 60 * 60 * 1000);

    const result = await db.collection('tasks').deleteMany({
      status: 'completed',
      completedAt: { $lte: cutoff },
    });

    return res.status(200).json({ ok: true, deleted: result.deletedCount });
  } catch (err) {
    console.error('[cron-cleanup] error:', err);
    return res.status(500).json({ ok: false, error: 'server_error' });
  }
}
