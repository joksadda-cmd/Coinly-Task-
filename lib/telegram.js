// lib/telegram.js — Telegram Bot API helpers
//
// Shared by api/bot.js (user + admin conversation flows) and api/verify.js
// (channel/group join verification for tasks).

const BOT_TOKEN = process.env.BOT_TOKEN;

if (!BOT_TOKEN) {
  throw new Error('❌ Missing BOT_TOKEN environment variable. Set it in Vercel → Project → Settings → Environment Variables.');
}

const TG_API = `https://api.telegram.org/bot${BOT_TOKEN}`;
const TG_FILE_BASE = `https://api.telegram.org/file/bot${BOT_TOKEN}`;

/**
 * Low-level call to any Telegram Bot API method.
 * All other helpers below are thin wrappers around this.
 *
 * @param {number|null} timeoutMs - optional hard timeout. Pass this for any
 *   call chain that's part of a request with a tight execution budget (e.g.
 *   api/image-proxy.js, which does 2-3 sequential network calls inside
 *   Vercel Hobby's 10-second serverless function limit — without a timeout
 *   here, one slow Telegram API response could eat the whole budget and the
 *   platform kills the function outright instead of us failing gracefully).
 */
export async function tgApi(method, payload = {}, timeoutMs = null) {
  const controller = timeoutMs ? new AbortController() : null;
  const timer = timeoutMs ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const res = await fetch(`${TG_API}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      ...(controller ? { signal: controller.signal } : {}),
    });
    const data = await res.json();
    if (!data.ok) {
      console.warn(`[tgApi:${method}] failed →`, data.description);
    }
    return data;
  } catch (err) {
    console.error(`[tgApi:${method}] network error →`, err.message);
    return { ok: false, description: err.message };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Send a plain/HTML text message. */
export async function tgSend(chatId, text, extra = {}) {
  return tgApi('sendMessage', {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    ...extra,
  });
}

/** Edit an existing message's text (used for inline-keyboard menu navigation). */
export async function tgEdit(chatId, messageId, text, extra = {}) {
  return tgApi('editMessageText', {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    ...extra,
  });
}

/** Send a photo with an optional caption (e.g. welcome banner, task preview). */
export async function tgSendPhoto(chatId, photo, caption = '', extra = {}) {
  return tgApi('sendPhoto', {
    chat_id: chatId,
    photo,
    caption,
    parse_mode: 'HTML',
    ...extra,
  });
}

/** Acknowledge a callback query (stops the loading spinner on the button). */
export async function tgAnswerCallback(callbackQueryId, text = '', showAlert = false) {
  return tgApi('answerCallbackQuery', {
    callback_query_id: callbackQueryId,
    text,
    show_alert: showAlert,
  });
}

/**
 * Returns the file_id of a user's current Telegram profile photo, or null
 * if they have none (or have hidden them via privacy settings — Telegram
 * just returns an empty list in that case, not an error).
 *
 * Requests a small/medium size (index 1 of the size array when available)
 * instead of the largest — profile avatars don't need full resolution and
 * this keeps bytes down.
 */
export async function getUserAvatarFileId(userId) {
  const data = await tgApi('getUserProfilePhotos', { user_id: userId, limit: 1 }, 3000);
  if (!data.ok || !data.result || data.result.total_count === 0) return null;

  const sizes = data.result.photos[0]; // array of PhotoSize, smallest → largest
  const pick = sizes[1] || sizes[sizes.length - 1];
  return pick.file_id;
}

/**
 * Resolves a file_id to a downloadable https://api.telegram.org/file/... URL.
 * That URL embeds the bot token, so it must only ever be fetched server-side
 * (see api/image-proxy.js) — never sent to the client directly.
 */
export async function getFileDownloadUrl(fileId) {
  const data = await tgApi('getFile', { file_id: fileId }, 3000);
  if (!data.ok || !data.result?.file_path) return null;
  return `${TG_FILE_BASE}/${data.result.file_path}`;
}

/**
 * Generic membership check for a channel/group join task.
 * Unlike a fixed "official channel" check, this is DYNAMIC — every task
 * carries its own chatId (the channel/group the task-poster wants people
 * to join), so this must accept that as a parameter.
 *
 * IMPORTANT: our bot must be an ADMIN in that channel/group, otherwise
 * Telegram will refuse getChatMember and this will always fail.
 *
 * @param {string} chatId - e.g. '@somechannel' or a numeric chat id
 * @param {string|number} userId - the Telegram user id to check
 * @returns {{ok: boolean, joined: boolean, status: string|null, error?: string}}
 */
export async function isMember(chatId, userId) {
  const data = await tgApi('getChatMember', { chat_id: chatId, user_id: userId });

  if (!data.ok) {
    // Common cause: bot isn't admin in that chat, or chat/user not found
    return { ok: false, joined: false, status: null, error: data.description };
  }

  const status = data.result.status; // 'creator' | 'administrator' | 'member' | 'restricted' | 'left' | 'kicked'
  const joined = ['creator', 'administrator', 'member'].includes(status);

  return { ok: true, joined, status };
}
