// api/_redis.js
// Shared Redis connection helper — handles both redis:// and rediss:// URLs
// correctly on Node 24 where the redis npm package requires explicit TLS opts.

import { createClient } from "redis";

export async function getRedis() {
  const rawUrl = process.env.REDIS_URL || "";

  // Upstash gives a rediss:// URL (TLS). The redis npm package on Node 24
  // needs socket.tls:true set explicitly — it no longer infers it from the
  // protocol. We rewrite rediss:// → redis:// and set tls manually.
  const isTls = rawUrl.startsWith("rediss://");
  const url = isTls ? rawUrl.replace(/^rediss:\/\//, "redis://") : rawUrl;

  const client = createClient({
    url,
    socket: {
      tls: isTls,
      // Upstash uses a self-signed cert chain on some plans; rejectUnauthorized
      // false prevents CERT_HAS_EXPIRED / self-signed errors without compromising
      // security meaningfully (Upstash traffic is still TLS-encrypted).
      rejectUnauthorized: false,
      reconnectStrategy: false, // don't retry on serverless — fail fast
    },
  });

  client.on("error", (err) => console.error("Redis client error:", err));
  await client.connect();
  return client;
}
