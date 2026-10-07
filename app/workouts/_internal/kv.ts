// The handful of Redis operations the event layer needs, behind an interface so
// tests run against an in-memory map instead of Upstash.

import { Redis } from "@upstash/redis";

export interface Kv {
  get(key: string): Promise<string | null>;
  // Returns false when `nx` is set and the key already existed.
  set(key: string, value: string, opts?: { px?: number; nx?: boolean }): Promise<boolean>;
  del(key: string): Promise<void>;
  sadd(key: string, member: string): Promise<void>;
  srem(key: string, member: string): Promise<void>;
  smembers(key: string): Promise<string[]>;
  zadd(key: string, score: number, member: string): Promise<void>;
  zrem(key: string, member: string): Promise<void>;
  // Members with score <= max, lowest score first.
  zrangeByScore(key: string, max: number, limit: number): Promise<string[]>;
}

export function upstashKv(): Kv {
  // The Vercel Marketplace integration injects KV_REST_API_*; a direct Upstash
  // setup uses UPSTASH_REDIS_REST_*.
  const url = process.env["KV_REST_API_URL"] ?? process.env["UPSTASH_REDIS_REST_URL"];
  const token = process.env["KV_REST_API_TOKEN"] ?? process.env["UPSTASH_REDIS_REST_TOKEN"];
  if (!url || !token) {
    throw new Error(
      "Missing Redis env: set KV_REST_API_URL/TOKEN or UPSTASH_REDIS_REST_URL/TOKEN.",
    );
  }
  // Values are JSON strings we parse ourselves; automatic deserialization would
  // hand back objects for some keys and strings for others.
  const redis = new Redis({ url, token, automaticDeserialization: false });
  return {
    get: (key) => redis.get<string>(key),
    async set(key, value, opts = {}) {
      const result =
        opts.px !== undefined
          ? opts.nx
            ? await redis.set(key, value, { px: opts.px, nx: true })
            : await redis.set(key, value, { px: opts.px })
          : opts.nx
            ? await redis.set(key, value, { nx: true })
            : await redis.set(key, value);
      return result !== null;
    },
    async del(key) {
      await redis.del(key);
    },
    async sadd(key, member) {
      await redis.sadd(key, member);
    },
    async srem(key, member) {
      await redis.srem(key, member);
    },
    smembers: (key) => redis.smembers(key),
    async zadd(key, score, member) {
      await redis.zadd(key, { score, member });
    },
    async zrem(key, member) {
      await redis.zrem(key, member);
    },
    zrangeByScore: (key, max, limit) =>
      redis.zrange<string[]>(key, "-inf", max, { byScore: true, offset: 0, count: limit }),
  };
}

export function memoryKv(now: () => number = Date.now): Kv {
  const strings = new Map<string, { value: string; expiresAt: number | null }>();
  const sets = new Map<string, Set<string>>();
  const zsets = new Map<string, Map<string, number>>();

  function live(key: string) {
    const entry = strings.get(key);
    if (!entry) return null;
    if (entry.expiresAt !== null && entry.expiresAt <= now()) {
      strings.delete(key);
      return null;
    }
    return entry;
  }

  return {
    async get(key) {
      return live(key)?.value ?? null;
    },
    async set(key, value, opts = {}) {
      if (opts.nx && live(key)) return false;
      strings.set(key, { value, expiresAt: opts.px !== undefined ? now() + opts.px : null });
      return true;
    },
    async del(key) {
      strings.delete(key);
    },
    async sadd(key, member) {
      const set = sets.get(key) ?? new Set();
      set.add(member);
      sets.set(key, set);
    },
    async srem(key, member) {
      sets.get(key)?.delete(member);
    },
    async smembers(key) {
      return [...(sets.get(key) ?? [])];
    },
    async zadd(key, score, member) {
      const zset = zsets.get(key) ?? new Map();
      zset.set(member, score);
      zsets.set(key, zset);
    },
    async zrem(key, member) {
      zsets.get(key)?.delete(member);
    },
    async zrangeByScore(key, max, limit) {
      return [...(zsets.get(key) ?? [])]
        .filter(([, score]) => score <= max)
        .toSorted((a, b) => a[1] - b[1])
        .slice(0, limit)
        .map(([member]) => member);
    },
  };
}
