// api/cleanup.js
// Hourly cron job to delete expired files from Vercel Blob + KV
// Configured in vercel.json: "0 * * * *" (every hour)

import { del } from "@vercel/blob";
import { kv } from "@vercel/kv";

export default async function handler(req, res) {
  // Protect the endpoint — only allow Vercel cron or requests with secret
  const authHeader = req.headers.authorization;
  const cronSecret = process.env.CRON_SECRET;

  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    // Allow Vercel's internal cron calls (they come without auth on hobby plan)
    // but block random external hits if secret is configured
    const isVercelCron = req.headers["x-vercel-cron"] === "1";
    if (!isVercelCron) {
      return res.status(401).json({ error: "Unauthorized" });
    }
  }

  const now = Date.now();
  let deleted = 0;
  let errors = 0;

  try {
    // Get all files that have expired (score/expiresAt <= now)
    // zrangebyscore returns members with score between -inf and now
    const expiredKeys = await kv.zrangebyscore("files_by_expiry", 0, now);

    if (!expiredKeys || expiredKeys.length === 0) {
      return res.status(200).json({ message: "No expired files", deleted: 0 });
    }

    console.log(`Cleanup: found ${expiredKeys.length} expired files`);

    for (const fileKey of expiredKeys) {
      try {
        const metaRaw = await kv.get(`file:${fileKey}`);
        if (!metaRaw) {
          // Meta already gone, just remove from index
          await kv.zrem("files_by_expiry", fileKey);
          continue;
        }

        const meta = typeof metaRaw === "string" ? JSON.parse(metaRaw) : metaRaw;

        // Double-check expiry (safety net)
        if (meta.expiresAt > now) continue;

        // Delete from Vercel Blob
        try {
          await del(meta.blobUrl);
        } catch (blobErr) {
          // File might already be gone; log but continue cleanup
          console.warn(`Blob delete failed for ${meta.blobUrl}:`, blobErr.message);
        }

        // Remove KV metadata
        await kv.del(`file:${fileKey}`);
        await kv.zrem("files_by_expiry", fileKey);

        deleted++;
        console.log(`Deleted: ${meta.filename} (${fileKey})`);
      } catch (err) {
        console.error(`Error deleting file ${fileKey}:`, err);
        errors++;
      }
    }

    return res.status(200).json({
      message: `Cleanup complete`,
      deleted,
      errors,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    console.error("Cleanup job error:", err);
    return res.status(500).json({ error: err.message });
  }
}
