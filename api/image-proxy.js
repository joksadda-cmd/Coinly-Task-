// api/image-proxy.js — Serves a user's real Telegram profile photo from our
// own domain, so the frontend can just do <img src="/api/image-proxy?tgUserId=123">.
//
// WHY THIS EXISTS (and why it's safe, unlike the old task-photo version):
// Telegram profile photos live on Telegram's file servers behind a URL that
// embeds our bot token (https://api.telegram.org/file/bot<TOKEN>/<path>) —
// that URL can NEVER be sent to the client directly, or anyone could use it
// to call our bot's API. So we fetch the bytes here, server-side, using the
// token privately, and stream them back from our own domain instead.
//
// There's no SSRF risk here (unlike the old arbitrary-URL proxy this file
// used to be): the only host we ever fetch from is api.telegram.org, never
// a user-supplied URL.
//
// No binary data is ever written to MongoDB — this endpoint doesn't touch
// the database at all. The image bytes are cached at the edge/browser via
// Cache-Control below, so the same avatar isn't re-fetched from Telegram
// (and re-invoked as a function call) on every feed scroll.

import { getUserAvatarFileId, getFileDownloadUrl, tgApi } from '../lib/telegram.js';

const FETCH_TIMEOUT_MS = 3500; // kept tight — combined with the 3s+3s budget in
// getUserAvatarFileId/getFileDownloadUrl, worst case stays under Vercel Hobby's
// 10s hard function timeout instead of getting silently killed by the platform.

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  }

  const tgUserId = Number(req.query.tgUserId);
  if (!Number.isFinite(tgUserId)) {
    return res.status(400).json({ ok: false, error: 'missing_or_invalid_tgUserId' });
  }

  // ── Debug mode ─────────────────────────────────────────────
  // Visit /api/image-proxy?tgUserId=123&debug=1 directly in a normal phone
  // browser (outside Telegram) to see EXACTLY what Telegram's API says for
  // that user — no Vercel log access needed. Temporary diagnostic aid;
  // safe to leave in (read-only, no token/secret is ever exposed by it).
  if (req.query.debug === '1') {
    const photosRes = await tgApi('getUserProfilePhotos', { user_id: tgUserId, limit: 1 }, 5000);
    return res.status(200).json({
      ok: true,
      tgUserId,
      telegramApiResponse: photosRes,
      interpretation: !photosRes.ok
        ? 'Telegram API call itself failed — check "description" above (often means BOT_TOKEN is wrong/missing).'
        : photosRes.result?.total_count > 0
        ? 'User HAS a visible profile photo — avatar should load. If it still doesn\'t, the problem is in the getFile/download step, not here.'
        : 'Telegram says this user has NO visible profile photo for this bot (either they have none set, or their privacy settings hide it from bots).',
    });
  }

  try {
    const fileId = await getUserAvatarFileId(tgUserId);
    if (!fileId) {
      // No profile photo (or hidden by privacy settings) — 404 so the
      // frontend's <img onerror> falls back to the initials avatar.
      console.warn(`[image-proxy] no avatar file_id for tgUserId=${tgUserId}`);
      return res.status(404).json({ ok: false, error: 'no_avatar' });
    }

    const fileUrl = await getFileDownloadUrl(fileId);
    if (!fileUrl) {
      console.warn(`[image-proxy] getFile failed for tgUserId=${tgUserId}, fileId=${fileId}`);
      return res.status(404).json({ ok: false, error: 'no_avatar' });
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    const upstream = await fetch(fileUrl, { signal: controller.signal });
    clearTimeout(timeout);

    if (!upstream.ok) {
      return res.status(404).json({ ok: false, error: 'no_avatar' });
    }

    const buf = Buffer.from(await upstream.arrayBuffer());

    res.setHeader('Content-Type', upstream.headers.get('content-type') || 'image/jpeg');
    // 1h browser cache, 1 day edge cache — avatars change rarely, and this
    // keeps us from hammering Telegram's API on every feed load.
    res.setHeader('Cache-Control', 'public, max-age=3600, s-maxage=86400, stale-while-revalidate=43200');
    return res.status(200).send(buf);
  } catch (err) {
    if (err.name === 'AbortError') {
      return res.status(504).json({ ok: false, error: 'timeout' });
    }
    console.error('[image-proxy] error:', err.message);
    return res.status(502).json({ ok: false, error: 'fetch_failed' });
  }
}
