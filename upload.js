// api/upload.js
// Web UI upload endpoint — handles multipart file uploads and URL uploads

import { put } from "@vercel/blob";
import { kv } from "@vercel/kv";
import { IncomingForm } from "formidable";
import fs from "fs";

export const config = {
  api: {
    bodyParser: false, // We handle parsing manually for multipart
  },
};

function parseForm(req) {
  return new Promise((resolve, reject) => {
    const form = new IncomingForm({
      maxFileSize: 4.5 * 1024 * 1024, // 4.5MB — Vercel hobby function limit
      keepExtensions: true,
    });
    form.parse(req, (err, fields, files) => {
      if (err) reject(err);
      else resolve({ fields, files });
    });
  });
}

async function storeFileMeta(fileKey, meta) {
  await kv.set(`file:${fileKey}`, JSON.stringify(meta), { ex: meta.ttl + 3600 });
  await kv.zadd("files_by_expiry", { score: meta.expiresAt, member: fileKey });
}

export default async function handler(req, res) {
  // CORS headers for web UI
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const contentType = req.headers["content-type"] || "";

    // ── JSON body: URL upload ─────────────────────────────────────────────────
    if (contentType.includes("application/json")) {
      let body = "";
      for await (const chunk of req) body += chunk;
      const { url, ttl } = JSON.parse(body);

      if (!url) return res.status(400).json({ error: "URL is required" });
      if (!ttl || ttl < 600 || ttl > 86400)
        return res.status(400).json({ error: "TTL must be between 600 and 86400 seconds" });

      let urlObj;
      try {
        urlObj = new URL(url);
      } catch {
        return res.status(400).json({ error: "Invalid URL" });
      }

      const filename = urlObj.pathname.split("/").pop() || "download";

      // Fetch the remote file
      const fileRes = await fetch(url, { redirect: "follow" });
      if (!fileRes.ok) return res.status(400).json({ error: `Cannot fetch URL: ${fileRes.status}` });

      const contentTypeHeader = fileRes.headers.get("content-type") || "application/octet-stream";
      const arrayBuffer = await fileRes.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);

      if (buffer.length > 4.5 * 1024 * 1024) {
        return res.status(413).json({ error: "File too large. Web upload limit is 4.5MB." });
      }

      const blob = await put(filename, buffer, {
        access: "public",
        contentType: contentTypeHeader,
        addRandomSuffix: true,
      });

      const expiresAt = Date.now() + ttl * 1000;
      const fileKey = blob.url.split("/").pop().split("?")[0];

      await storeFileMeta(fileKey, {
        blobUrl: blob.url,
        filename,
        size: buffer.length,
        contentType: contentTypeHeader,
        ttl,
        expiresAt,
        uploadedAt: Date.now(),
        source: "web",
      });

      return res.status(200).json({
        success: true,
        url: blob.url,
        filename,
        size: buffer.length,
        expiresAt,
        ttl,
      });
    }

    // ── Multipart: file upload ────────────────────────────────────────────────
    if (contentType.includes("multipart/form-data")) {
      const { fields, files } = await parseForm(req);

      const ttl = parseInt(Array.isArray(fields.ttl) ? fields.ttl[0] : fields.ttl, 10);
      if (!ttl || ttl < 600 || ttl > 86400)
        return res.status(400).json({ error: "TTL must be between 600 and 86400 seconds" });

      const fileField = files.file;
      const uploadedFile = Array.isArray(fileField) ? fileField[0] : fileField;

      if (!uploadedFile) return res.status(400).json({ error: "No file provided" });

      const filename = uploadedFile.originalFilename || uploadedFile.newFilename || "upload";
      const mimeType = uploadedFile.mimetype || "application/octet-stream";
      const fileBuffer = fs.readFileSync(uploadedFile.filepath);

      const blob = await put(filename, fileBuffer, {
        access: "public",
        contentType: mimeType,
        addRandomSuffix: true,
      });

      // Cleanup temp file
      fs.unlinkSync(uploadedFile.filepath);

      const expiresAt = Date.now() + ttl * 1000;
      const fileKey = blob.url.split("/").pop().split("?")[0];

      await storeFileMeta(fileKey, {
        blobUrl: blob.url,
        filename,
        size: fileBuffer.length,
        contentType: mimeType,
        ttl,
        expiresAt,
        uploadedAt: Date.now(),
        source: "web",
      });

      return res.status(200).json({
        success: true,
        url: blob.url,
        filename,
        size: fileBuffer.length,
        expiresAt,
        ttl,
      });
    }

    return res.status(400).json({ error: "Unsupported content type" });
  } catch (err) {
    console.error("Upload error:", err);
    if (err.code === "LIMIT_FILE_SIZE" || err.message?.includes("maxFileSize")) {
      return res.status(413).json({ error: "File too large. Maximum size is 4.5MB via web upload." });
    }
    return res.status(500).json({ error: `Upload failed: ${err.message}` });
  }
}
