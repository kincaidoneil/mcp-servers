// Session persistence. Sessions are keyed by owner and id, and an owner can
// only reach their own sessions. Production uses Upstash Redis over REST;
// tests and local dev without Redis fall back to a Map.

import { Redis } from "@upstash/redis";
import { getConfig } from "./config";
import { SessionSchema, summarize, type Session, type SessionSummary } from "./schema";

export interface SessionStore {
  get(owner: string, id: string): Promise<Session | null>;
  put(session: Session): Promise<void>;
  // Newest updated first.
  list(owner: string, limit: number): Promise<SessionSummary[]>;
}

// No 0/o, 1/l/i so an id read aloud or retyped survives.
const ID_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
const ID_LENGTH = 12;

export function newSessionId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(ID_LENGTH));
  let id = "";
  for (const byte of bytes) id += ID_ALPHABET[byte % ID_ALPHABET.length];
  return id;
}

const memoryKey = (owner: string, id: string) => `${owner}:${id}`;

export function createMemoryStore(): SessionStore {
  const sessions = new Map<string, Session>();
  return {
    async get(owner, id) {
      return sessions.get(memoryKey(owner, id)) ?? null;
    },
    async put(session) {
      sessions.set(memoryKey(session.owner, session.id), session);
    },
    async list(owner, limit) {
      return [...sessions.values()]
        .filter((session) => session.owner === owner)
        .toSorted((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at))
        .slice(0, limit)
        .map(summarize);
    },
  };
}

// The slice of the @upstash/redis client the store uses. Tests inject a fake.
export interface RedisClient {
  get(key: string): Promise<unknown>;
  set(key: string, value: string, opts: { ex: number }): Promise<unknown>;
  mget(keys: string[]): Promise<unknown[]>;
  zadd(key: string, member: { score: number; member: string }): Promise<unknown>;
  zrange(key: string, start: number, stop: number, opts: { rev: true }): Promise<unknown[]>;
  zrem(key: string, ...members: string[]): Promise<unknown>;
  expire(key: string, seconds: number): Promise<unknown>;
}

export interface RedisStoreOptions {
  url: string;
  token: string;
  ttlSeconds: number;
  client?: RedisClient;
}

// Layout: `pare:session:{owner}:{id}` holds the session JSON with a TTL.
// `pare:sessions:{owner}` is a sorted set of ids scored by updated_at (epoch
// ms), so listing is one ZRANGE plus one MGET. Both TTLs refresh on every put.
const sessionKey = (owner: string, id: string) => `pare:session:${owner}:${id}`;
const indexKey = (owner: string) => `pare:sessions:${owner}`;

export function createRedisStore(opts: RedisStoreOptions): SessionStore {
  const client: RedisClient = opts.client ?? new Redis({ url: opts.url, token: opts.token });

  return {
    async get(owner, id) {
      return parseSession(await client.get(sessionKey(owner, id)));
    },
    async put(session) {
      await client.set(sessionKey(session.owner, session.id), JSON.stringify(session), {
        ex: opts.ttlSeconds,
      });
      await client.zadd(indexKey(session.owner), {
        score: Date.parse(session.updated_at),
        member: session.id,
      });
      await client.expire(indexKey(session.owner), opts.ttlSeconds);
    },
    async list(owner, limit) {
      const ids = (await client.zrange(indexKey(owner), 0, limit - 1, { rev: true })).filter(
        (id): id is string => typeof id === "string",
      );
      if (ids.length === 0) return [];
      const raws = await client.mget(ids.map((id) => sessionKey(owner, id)));
      const summaries: SessionSummary[] = [];
      const stale: string[] = [];
      for (const [i, id] of ids.entries()) {
        const session = parseSession(raws[i]);
        if (session) summaries.push(summarize(session));
        else stale.push(id);
      }
      if (stale.length > 0) await client.zrem(indexKey(owner), ...stale);
      return summaries;
    },
  };
}

// The Upstash client deserializes JSON on read by default, so a value may
// arrive as a string or an object. Either way it is foreign data.
function parseSession(raw: unknown): Session | null {
  let value = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  const parsed = SessionSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

let store: SessionStore | null = null;

export function getStore(): SessionStore {
  if (store) return store;
  const config = getConfig();
  store =
    config.store.kind === "redis"
      ? createRedisStore({ ...config.store, ttlSeconds: config.sessionTtlSeconds })
      : createMemoryStore();
  return store;
}

export function resetStoreForTesting() {
  store = null;
}
