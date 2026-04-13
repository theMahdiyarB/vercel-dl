// api/telegram.js
import { put } from "@vercel/blob";
import { getRedis } from "./_redis.js";

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;
const BASE_URL = process.env.VERCEL_URL
  ? `https://${process.env.VERCEL_URL}`
  : process.env.BASE_URL;

// ─── Telegram helpers ────────────────────────────────────────────────────────

async function sendMessage(chatId, text, extra = {}) {
  await fetch(`${TELEGRAM_API}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML", ...extra }),
  });
}

async function sendMessageWithKeyboard(chatId, text, keyboard) {
  await fetch(`${TELEGRAM_API}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: keyboard },
    }),
  });
}

async function editMessage(chatId, messageId, text) {
  await fetch(`${TELEGRAM_API}/editMessageText`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, message_id: messageId, text, parse_mode: "HTML" }),
  });
}

async function answerCallback(callbackId) {
  await fetch(`${TELEGRAM_API}/answerCallbackQuery`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ callback_query_id: callbackId }),
  });
}

async function getFileUrl(fileId) {
  const res = await fetch(`${TELEGRAM_API}/getFile?file_id=${fileId}`);
  const data = await res.json();
  if (!data.ok) return null;
  return `https://api.telegram.org/file/bot${BOT_TOKEN}/${data.result.file_path}`;
}

// ─── Duration keyboard ───────────────────────────────────────────────────────

function durationKeyboard() {
  return [
    [
      { text: "⏱ 10 min", callback_data: "dur_600" },
      { text: "⏱ 30 min", callback_data: "dur_1800" },
      { text: "⏱ 1 hour", callback_data: "dur_3600" },
    ],
    [
      { text: "⏱ 3 hours", callback_data: "dur_10800" },
      { text: "⏱ 6 hours", callback_data: "dur_21600" },
      { text: "⏱ 12 hours", callback_data: "dur_43200" },
    ],
    [{ text: "⏱ 24 hours", callback_data: "dur_86400" }],
  ];
}

function formatDuration(seconds) {
  if (seconds < 3600) return `${seconds / 60} minutes`;
  if (seconds < 86400) return `${seconds / 3600} hour${seconds / 3600 > 1 ? "s" : ""}`;
  return "24 hours";
}

// ─── Redis helpers ───────────────────────────────────────────────────────────

async function setPendingUpload(r, chatId, data) {
  await r.set(`pending:${chatId}`, JSON.stringify(data), { EX: 600 });
}

async function getPendingUpload(r, chatId) {
  const val = await r.get(`pending:${chatId}`);
  if (!val) return null;
  return JSON.parse(val);
}

async function clearPendingUpload(r, chatId) {
  await r.del(`pending:${chatId}`);
}

async function storeFileMeta(r, fileKey, meta) {
  await r.set(`file:${fileKey}`, JSON.stringify(meta), { EX: meta.ttl + 3600 });
  await r.zAdd("files_by_expiry", { score: meta.expiresAt, value: fileKey });
}

// ─── Upload logic ─────────────────────────────────────────────────────────────

async function uploadFromUrl(sourceUrl, filename) {
  const res = await fetch(sourceUrl);
  if (!res.ok) throw new Error(`Failed to fetch: ${res.status}`);
  const contentType = res.headers.get("content-type") || "application/octet-stream";
  const buffer = Buffer.from(await res.arrayBuffer());
  const blob = await put(filename, buffer, { access: "public", contentType, addRandomSuffix: true });
  return { url: blob.url, size: buffer.length, contentType };
}

// ─── Main handler ─────────────────────────────────────────────────────────────

export const config = { api: { bodyParser: { sizeLimit: "10mb" } } };

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end("Method Not Allowed");

  const update = req.body;
  let r = null;

  try {
    r = await getRedis();

    // ── Callback query (duration button tapped) ───────────────────────────
    if (update.callback_query) {
      const cb = update.callback_query;
      const chatId = cb.message.chat.id;
      const msgId = cb.message.message_id;

      await answerCallback(cb.id);

      if (cb.data.startsWith("dur_")) {
        const ttl = parseInt(cb.data.replace("dur_", ""), 10);
        const pending = await getPendingUpload(r, chatId);

        if (!pending) {
          await editMessage(chatId, msgId, "⚠️ Session expired. Please send your file again.");
          return res.status(200).end();
        }

        await editMessage(chatId, msgId, "⏳ Uploading… please wait.");

        try {
          let uploadResult;
          let originalName = pending.filename || "file";

          if (pending.type === "link") {
            const urlObj = new URL(pending.url);
            originalName = urlObj.pathname.split("/").pop() || "download";
            uploadResult = await uploadFromUrl(pending.url, originalName);
          } else {
            const telegramUrl = await getFileUrl(pending.fileId);
            if (!telegramUrl) throw new Error("Could not get file from Telegram");
            uploadResult = await uploadFromUrl(telegramUrl, originalName);
          }

          const expiresAt = Date.now() + ttl * 1000;
          const fileKey = uploadResult.url.split("/").pop().split("?")[0];

          await storeFileMeta(r, fileKey, {
            blobUrl: uploadResult.url,
            filename: originalName,
            size: uploadResult.size,
            contentType: uploadResult.contentType,
            chatId, ttl, expiresAt,
            uploadedAt: Date.now(),
          });

          await clearPendingUpload(r, chatId);

          const sizeStr =
            uploadResult.size < 1024 ? `${uploadResult.size} B`
            : uploadResult.size < 1048576 ? `${(uploadResult.size / 1024).toFixed(1)} KB`
            : `${(uploadResult.size / 1048576).toFixed(1)} MB`;

          await editMessage(
            chatId, msgId,
            `✅ <b>File uploaded successfully!</b>\n\n` +
            `📁 <b>File:</b> ${originalName}\n` +
            `📦 <b>Size:</b> ${sizeStr}\n` +
            `🔗 <b>Link:</b> <a href="${uploadResult.url}">${uploadResult.url}</a>\n\n` +
            `⏳ <b>Expires in:</b> ${formatDuration(ttl)}\n` +
            `🗓 <b>Expires at:</b> ${new Date(expiresAt).toUTCString()}\n\n` +
            `<i>The file will be automatically deleted after this time.</i>`
          );
        } catch (err) {
          console.error("Upload error:", err);
          await editMessage(chatId, msgId, `❌ <b>Upload failed:</b> ${err.message}\n\nPlease try again.`);
        }
      }

      return res.status(200).end();
    }

    // ── Regular message ───────────────────────────────────────────────────
    if (!update.message) return res.status(200).end();

    const msg = update.message;
    const chatId = msg.chat.id;
    const text = msg.text || "";

    if (text === "/start" || text.startsWith("/start ")) {
      await sendMessage(chatId,
        `👋 <b>Welcome to FileHost Bot!</b>\n\n` +
        `I can host your files temporarily on a secure server.\n\n` +
        `<b>How to use:</b>\n` +
        `• Send me any file (document, photo, video, audio)\n` +
        `• Or send me a direct link to a file\n` +
        `• Choose how long to keep it (10 min → 24 hours)\n` +
        `• Get your shareable link instantly!\n\n` +
        `<b>Limits:</b>\n` +
        `• Max file size: 50 MB (Telegram bot limit)\n` +
        `• Files are auto-deleted after your chosen time\n\n` +
        `Send me a file or link to get started! 🚀`
      );
      return res.status(200).end();
    }

    if (text === "/help") {
      await sendMessage(chatId,
        `<b>FileHost Bot Help</b>\n\n` +
        `<b>Commands:</b>\n` +
        `/start — Welcome message\n` +
        `/help — This help message\n` +
        `/web — Get the web upload link\n\n` +
        `<b>Usage:</b>\n` +
        `1. Send a file or a direct URL\n` +
        `2. Choose expiry duration\n` +
        `3. Share the link!\n\n` +
        `<b>Supported:</b> Any file type up to 50MB`
      );
      return res.status(200).end();
    }

    if (text === "/web") {
      await sendMessage(chatId,
        `🌐 <b>Web Upload Interface</b>\n\n` +
        `You can also upload files via the web:\n` +
        `<a href="${BASE_URL}">${BASE_URL}</a>\n\n` +
        `The web interface supports files up to 4.5MB via browser upload.`
      );
      return res.status(200).end();
    }

    if (text && !text.startsWith("/")) {
      let isUrl = false;
      try {
        const u = new URL(text.trim());
        isUrl = u.protocol === "http:" || u.protocol === "https:";
      } catch {}

      if (isUrl) {
        await setPendingUpload(r, chatId, { type: "link", url: text.trim() });
        await sendMessageWithKeyboard(chatId,
          `🔗 <b>Link detected!</b>\n\n<code>${text.trim()}</code>\n\nHow long should I keep this file?`,
          durationKeyboard()
        );
        return res.status(200).end();
      }

      await sendMessage(chatId, `ℹ️ Please send me a file or a direct download link.\n\nUse /help for more info.`);
      return res.status(200).end();
    }

    let fileId = null;
    let filename = "file";

    if (msg.document) {
      fileId = msg.document.file_id;
      filename = msg.document.file_name || "document";
    } else if (msg.photo) {
      const photo = msg.photo[msg.photo.length - 1];
      fileId = photo.file_id;
      filename = `photo_${Date.now()}.jpg`;
    } else if (msg.video) {
      fileId = msg.video.file_id;
      filename = msg.video.file_name || `video_${Date.now()}.mp4`;
    } else if (msg.audio) {
      fileId = msg.audio.file_id;
      filename = msg.audio.file_name || `audio_${Date.now()}.mp3`;
    } else if (msg.voice) {
      fileId = msg.voice.file_id;
      filename = `voice_${Date.now()}.ogg`;
    } else if (msg.video_note) {
      fileId = msg.video_note.file_id;
      filename = `videonote_${Date.now()}.mp4`;
    } else if (msg.sticker) {
      fileId = msg.sticker.file_id;
      filename = `sticker_${Date.now()}.webp`;
    }

    if (fileId) {
      await setPendingUpload(r, chatId, { type: "file", fileId, filename });
      await sendMessageWithKeyboard(chatId,
        `📁 <b>File received!</b>\n\n<code>${filename}</code>\n\nHow long should I keep this file?`,
        durationKeyboard()
      );
      return res.status(200).end();
    }

    await sendMessage(chatId, `ℹ️ Send me a file or a direct URL to upload it. Use /help for info.`);

  } catch (err) {
    console.error("Handler error:", err);
  } finally {
    if (r) await r.quit().catch(() => {});
  }

  return res.status(200).end();
}
