// api/image-proxy.js — Fetches an externally-hosted task photo server-side
// and streams it back from our own domain.
//
// WHY THIS EXISTS: task photoUrl is a raw link the poster pastes in
// (free image hosts — imgbb, postimg, etc.). Many of those hosts block
// "hotlinking": they check the Referer header on the request and refuse
// to serve the image if it wasn't requested by their own site. When the
// browser loads <img src="that-url">, it sends our app's domain as the
// Referer → blocked → the "Image unavailable" fallback in index.html
// kicks in. Telegram doesn't have this problem because Telegram's own
// servers fetch the photo (via tgSendPhoto) before showing it in the bot
// — no browser, no Referer, no block. This function does the same thing:
// fetch server-side, then serve the bytes from our own domain so the
// browser's <img> never talks to the original host directly.
//
// SECURITY: a public "fetch any URL" endpoint is an SSRF risk if left
// unrestricted (e.g. someone pointing it at internal infra or a cloud
// metadata endpoint). Restrictions below:
//   1. http/https only
//   2. blocks private/loopback/link-local hostnames
//   3. response must actually be an image (Content-Type check)
//   4. response size capped
//   5. fetch has a timeout
//   6. aggressively cached at the edge, so the same photo isn't re-fetched
//      (and re-billed as a function invocation) on every feed view

const MAX_BYTES = 5 * 1024 * 1024; // 5MB
const FETCH_TIMEOUT_MS = 8000;

function isBlockedHost(hostname) {
  const h = hostname.toLowerCase();
  if (h === 'localhost') return true;
  const patterns = [
    /^127\./, /^10\./, /^192\.168\./, /^169\.254\./, /^0\./,
    /^172\.(1[6-9]|2\d|3[01])\./,
    /^::1$/, /^\[::1\]$/,
  ];
  return patterns.some((re) => re.test(h));
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  }

  const raw = req.query.url;
  if (!raw || typeof raw !== 'string') {
    return res.status(400).json({ ok: false, error: 'missing_url' });
  }

  let target;
  try {
    target = new URL(raw);
  } catch {
    return res.status(400).json({ ok: false, error: 'invalid_url' });
  }

  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    return res.status(400).json({ ok: false, error: 'invalid_protocol' });
  }
  if (isBlockedHost(target.hostname)) {
    return res.status(400).json({ ok: false, error: 'blocked_host' });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const upstream = await fetch(target.toString(), {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        // Deliberately NOT forwarding our app's Referer — that's the
        // whole point of this proxy.
        'User-Agent': 'Mozilla/5.0 (compatible; CoinlyTaskImageProxy/1.0)',
      },
    });
    clearTimeout(timeout);

    if (!upstream.ok) {
      return res.status(502).json({ ok: false, error: 'upstream_error', status: upstream.status });
    }

    const contentType = upstream.headers.get('content-type') || '';
    if (!contentType.startsWith('image/')) {
      return res.status(415).json({ ok: false, error: 'not_an_image' });
    }

    const declaredLength = Number(upstream.headers.get('content-length') || 0);
    if (declaredLength && declaredLength > MAX_BYTES) {
      return res.status(413).json({ ok: false, error: 'too_large' });
    }

    const buf = Buffer.from(await upstream.arrayBuffer());
    if (buf.length > MAX_BYTES) {
      return res.status(413).json({ ok: false, error: 'too_large' });
    }

    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'public, max-age=86400, s-maxage=604800, stale-while-revalidate=86400');
    return res.status(200).send(buf);
  } catch (err) {
    clearTimeout(timeout);
    if (err.name === 'AbortError') {
      return res.status(504).json({ ok: false, error: 'timeout' });
    }
    return res.status(502).json({ ok: false, error: 'fetch_failed' });
  }
}
