// api/_redis.js
// Redis helper using @upstash/redis (HTTP/REST based — no TCP sockets,
// works perfectly on Vercel serverless without connection issues).
// Exposes the same interface the rest of the code expects.

import { Redis } from "@upstash/redis";

// @upstash/redis reads UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN
// automatically — but our env var is called REDIS_URL (a full redis:// URI).
// We parse it here so the user only needs one env var.
function buildClient() {
  const raw = process.env.REDIS_URL || "";

  // If the user has set UPSTASH_REDIS_REST_URL directly, use that.
  if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
    return new Redis({
      url: process.env.UPSTASH_REDIS_REST_URL,
      token: process.env.UPSTASH_REDIS_REST_TOKEN,
    });
  }

  // Parse redis[s]://default:PASSWORD@HOST:PORT into REST URL + token.
  // Upstash REST URL is always https://HOST (same host, different port/protocol).
  try {
    const u = new URL(raw);
    const password = u.password;          // this is the Upstash token
    const host = u.hostname;              // e.g. gentle-goldfish-98196.upstash.io
    const restUrl = `https://${host}`;
    return new Redis({ url: restUrl, token: password });
  } catch {
    throw new Error("REDIS_URL is missing or malformed. Set it to your Upstash redis[s]:// URL.");
  }
}

// Wrap @upstash/redis to match the subset of redis-npm API we use:
//   r.set(key, val, { EX })
//   r.get(key)
//   r.del(key)
//   r.zAdd(key, { score, value })
//   r.zRange(key, min, max, { BY: "SCORE", LIMIT })
//   r.zRem(key, member)
//   r.quit()  ← no-op for HTTP client
export async function getRedis() {
  const client = buildClient();

  return {
    async set(key, value, opts) {
      if (opts?.EX) return client.set(key, value, { ex: opts.EX });
      return client.set(key, value);
    },
    async get(key) {
      const val = await client.get(key);
      // @upstash/redis auto-parses JSON — re-stringify objects so callers
      // can always JSON.parse() the result themselves consistently.
      if (val !== null && typeof val === "object") return JSON.stringify(val);
      return val;
    },
    async del(key) {
      return client.del(key);
    },
    async zAdd(key, member) {
      // @upstash/redis: zadd(key, { score, member })
      return client.zadd(key, { score: member.score, member: member.value });
    },
    async zRange(key, min, max, opts) {
      if (opts?.BY === "SCORE") {
        const limit = opts?.LIMIT;
        if (limit) {
          return client.zrange(key, min, max, {
            byScore: true,
            offset: limit.offset,
            count: limit.count,
          });
        }
        return client.zrange(key, min, max, { byScore: true });
      }
      return client.zrange(key, min, max);
    },
    async zRem(key, member) {
      return client.zrem(key, member);
    },
    async quit() {
      // HTTP client — nothing to close
    },
  };
}
