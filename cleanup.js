// api/cleanup.js
// Hourly cron job to delete expired files from Vercel Blob + Redis
// Configured in vercel.json: "0 0 * * *" (every day)

import { del } from "@vercel/blob";
import { createClient } from "redis";

let redis;
async function getRedis() {
  if (!redis) redis = await createClient({ url: process.env.REDIS_URL }).connect();
  return redis;
}

export default async function handler(req, res) {
  const authHeader = req.headers.authorization;
  const cronSecret = process.env.CRON_SECRET;

  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    const isVercelCron = req.headers["x-vercel-cron"] === "1";
    if (!isVercelCron) {
      return res.status(401).json({ error: "Unauthorized" });
    }
  }

  const now = Date.now();
  let deleted = 0;
  let errors = 0;

  try {
    const r = await getRedis();

    // zRangeByScore returns members with score between 0 and now
    const expiredKeys = await r.zRangeByScore("files_by_expiry", 0, now);

    if (!expiredKeys || expiredKeys.length === 0) {
      return res.status(200).json({ message: "No expired files", deleted: 0 });
    }

    console.log(`Cleanup: found ${expiredKeys.length} expired files`);

    for (const fileKey of expiredKeys) {
      try {
        const metaRaw = await r.get(`file:${fileKey}`);
        if (!metaRaw) {
          await r.zRem("files_by_expiry", fileKey);
          continue;
        }

        const meta = typeof metaRaw === "string" ? JSON.parse(metaRaw) : metaRaw;

        if (meta.expiresAt > now) continue;

        try {
          await del(meta.blobUrl);
        } catch (blobErr) {
          console.warn(`Blob delete failed for ${meta.blobUrl}:`, blobErr.message);
        }

        await r.del(`file:${fileKey}`);
        await r.zRem("files_by_expiry", fileKey);

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
