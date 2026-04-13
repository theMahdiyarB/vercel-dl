// api/upload.js
import { put } from "@vercel/blob";
import { getRedis } from "./_redis.js";
import busboy from "busboy";

export const config = {
  api: {
    bodyParser: false,
    sizeLimit: "5mb",
  },
};

function parseMultipart(req) {
  return new Promise((resolve, reject) => {
    const MAX = 4.5 * 1024 * 1024;
    const bb = busboy({ headers: req.headers, limits: { fileSize: MAX, files: 1 } });

    let filename = "upload";
    let mimeType = "application/octet-stream";
    let ttl = null;
    let fileTooLarge = false;
    const chunks = [];

    bb.on("file", (_field, stream, info) => {
      filename = info.filename || "upload";
      mimeType = info.mimeType || "application/octet-stream";
      stream.on("data", (chunk) => chunks.push(chunk));
      stream.on("limit", () => { fileTooLarge = true; stream.resume(); });
    });

    bb.on("field", (name, val) => {
      if (name === "ttl") ttl = parseInt(val, 10);
    });

    bb.on("finish", () => {
      if (fileTooLarge) return reject(new Error("FILE_TOO_LARGE"));
      resolve({ fileBuffer: Buffer.concat(chunks), filename, mimeType, ttl });
    });

    bb.on("error", reject);
    req.pipe(bb);
  });
}

async function storeFileMeta(r, fileKey, meta) {
  await r.set(`file:${fileKey}`, JSON.stringify(meta), { EX: meta.ttl + 3600 });
  await r.zAdd("files_by_expiry", { score: meta.expiresAt, value: fileKey });
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  let r = null;
  try {
    r = await getRedis();
    const contentType = req.headers["content-type"] || "";

    // ── JSON body: URL upload ─────────────────────────────────────────────
    if (contentType.includes("application/json")) {
      let body = "";
      for await (const chunk of req) body += chunk;
      const { url, ttl } = JSON.parse(body);

      if (!url) return res.status(400).json({ error: "URL is required" });
      if (!ttl || ttl < 600 || ttl > 86400)
        return res.status(400).json({ error: "TTL must be between 600 and 86400 seconds" });

      let urlObj;
      try { urlObj = new URL(url); } catch {
        return res.status(400).json({ error: "Invalid URL" });
      }

      const filename = urlObj.pathname.split("/").pop() || "download";
      const fileRes = await fetch(url, { redirect: "follow" });
      if (!fileRes.ok) return res.status(400).json({ error: `Cannot fetch URL: ${fileRes.status}` });

      const contentTypeHeader = fileRes.headers.get("content-type") || "application/octet-stream";
      const buffer = Buffer.from(await fileRes.arrayBuffer());

      if (buffer.length > 4.5 * 1024 * 1024)
        return res.status(413).json({ error: "File too large. Web upload limit is 4.5MB." });

      const blob = await put(filename, buffer, {
        access: "public",
        contentType: contentTypeHeader,
        addRandomSuffix: true,
      });

      const expiresAt = Date.now() + ttl * 1000;
      const fileKey = blob.url.split("/").pop().split("?")[0];
      await storeFileMeta(r, fileKey, {
        blobUrl: blob.url, filename, size: buffer.length,
        contentType: contentTypeHeader, ttl, expiresAt,
        uploadedAt: Date.now(), source: "web",
      });

      return res.status(200).json({ success: true, url: blob.url, filename, size: buffer.length, expiresAt, ttl });
    }

    // ── Multipart: file upload ────────────────────────────────────────────
    if (contentType.includes("multipart/form-data")) {
      let parsed;
      try {
        parsed = await parseMultipart(req);
      } catch (e) {
        if (e.message === "FILE_TOO_LARGE")
          return res.status(413).json({ error: "File too large. Maximum is 4.5MB via web upload." });
        throw e;
      }

      const { fileBuffer, filename, mimeType, ttl } = parsed;
      if (!fileBuffer || fileBuffer.length === 0)
        return res.status(400).json({ error: "No file provided" });
      if (!ttl || ttl < 600 || ttl > 86400)
        return res.status(400).json({ error: "TTL must be between 600 and 86400 seconds" });

      const blob = await put(filename, fileBuffer, {
        access: "public",
        contentType: mimeType,
        addRandomSuffix: true,
      });

      const expiresAt = Date.now() + ttl * 1000;
      const fileKey = blob.url.split("/").pop().split("?")[0];
      await storeFileMeta(r, fileKey, {
        blobUrl: blob.url, filename, size: fileBuffer.length,
        contentType: mimeType, ttl, expiresAt,
        uploadedAt: Date.now(), source: "web",
      });

      return res.status(200).json({ success: true, url: blob.url, filename, size: fileBuffer.length, expiresAt, ttl });
    }

    return res.status(400).json({ error: "Unsupported content type" });

  } catch (err) {
    console.error("Upload error:", err);
    return res.status(500).json({ error: `Upload failed: ${err.message}` });
  } finally {
    if (r) await r.quit().catch(() => {});
  }
}
