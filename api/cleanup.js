// api/cleanup.js
// Hourly cron job to delete expired files from Vercel Blob + Redis

import { del } from "@vercel/blob";
import { createClient } from "redis";

async function getRedis() {
  const client = createClient({ url: process.env.REDIS_URL });
  client.on("error", (err) => console.error("Redis error:", err));
  await client.connect();
  return client;
}

export default async function handler(req, res) {
  const authHeader = req.headers.authorization;
  const cronSecret = process.env.CRON_SECRET;
  const isVercelCron = req.headers["x-vercel-cron"] === "1";

  if (cronSecret && authHeader !== `Bearer ${cronSecret}` && !isVercelCron) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const now = Date.now();
  let deleted = 0;
  let errors = 0;
  let r = null;

  try {
    r = await getRedis();

    // zRange with BYSCORE — gets all members with expiresAt score <= now
    const expiredKeys = await r.zRange("files_by_expiry", 0, now, {
      BY: "SCORE",
      LIMIT: { offset: 0, count: 100 },
    });

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

        const meta = JSON.parse(metaRaw);
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

    return res.status(200).json({ message: "Cleanup complete", deleted, errors, timestamp: new Date().toISOString() });

  } catch (err) {
    console.error("Cleanup job error:", err);
    return res.status(500).json({ error: err.message });
  } finally {
    if (r) await r.quit().catch(() => {});
  }
}
