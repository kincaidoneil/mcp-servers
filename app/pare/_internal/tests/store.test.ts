// The Redis store against a fake of the client surface it uses. Checks the
// key layout, TTL plumbing, list ordering, and that stale index entries are
// dropped rather than surfaced.

import { describe, expect, test } from "vitest";
import { createRedisStore, type RedisClient } from "../store";
import type { Session } from "../schema";

interface Call {
  op: string;
  args: unknown[];
}

function fakeRedis() {
  const strings = new Map<string, string>();
  const sets = new Map<string, Map<string, number>>();
  const calls: Call[] = [];
  const client: RedisClient = {
    async get(key) {
      calls.push({ op: "get", args: [key] });
      const value = strings.get(key);
      return value === undefined ? null : JSON.parse(value);
    },
    async set(key, value, opts) {
      calls.push({ op: "set", args: [key, opts] });
      strings.set(key, value);
      return "OK";
    },
    async mget(keys) {
      calls.push({ op: "mget", args: [keys] });
      return keys.map((key) => {
        const value = strings.get(key);
        return value === undefined ? null : JSON.parse(value);
      });
    },
    async zadd(key, member) {
      calls.push({ op: "zadd", args: [key, member] });
      const set = sets.get(key) ?? new Map<string, number>();
      set.set(member.member, member.score);
      sets.set(key, set);
      return 1;
    },
    async zrange(key, start, stop, opts) {
      calls.push({ op: "zrange", args: [key, start, stop, opts] });
      const entries = [...(sets.get(key) ?? new Map<string, number>()).entries()];
      entries.sort((a, b) => (opts.rev ? b[1] - a[1] : a[1] - b[1]));
      return entries.slice(start, stop + 1).map(([member]) => member);
    },
    async zrem(key, ...members) {
      calls.push({ op: "zrem", args: [key, members] });
      const set = sets.get(key);
      for (const member of members) set?.delete(member);
      return members.length;
    },
    async expire(key, seconds) {
      calls.push({ op: "expire", args: [key, seconds] });
      return 1;
    },
  };
  return { client, calls, strings, sets };
}

function session(id: string, updatedAt: string, owner = "kincaid"): Session {
  return {
    id,
    owner,
    created_at: "2026-09-01T00:00:00.000Z",
    updated_at: updatedAt,
    version: 0,
    status: "open",
    config: {
      title: `Session ${id}`,
      keep: { label: "Keep" },
      dispose: { label: "Dispose" },
      extra_actions: [],
      notes: true,
      skip: true,
      items: [{ id: "a", title: "A" }],
    },
    decisions: {},
    queue: ["a"],
  };
}

describe("createRedisStore", () => {
  test("puts with TTLs, gets by owner, and lists newest first", async () => {
    const redis = fakeRedis();
    const store = createRedisStore({ url: "u", token: "t", ttlSeconds: 60, client: redis.client });

    await store.put(session("old1", "2026-09-01T10:00:00.000Z"));
    await store.put(session("new2", "2026-09-02T10:00:00.000Z"));
    await store.put(session("mid3", "2026-09-01T20:00:00.000Z"));
    await store.put(session("other", "2026-09-03T10:00:00.000Z", "guest"));

    expect(redis.calls.slice(0, 3)).toEqual([
      { op: "set", args: ["pare:session:kincaid:old1", { ex: 60 }] },
      {
        op: "zadd",
        args: [
          "pare:sessions:kincaid",
          { score: Date.parse("2026-09-01T10:00:00.000Z"), member: "old1" },
        ],
      },
      { op: "expire", args: ["pare:sessions:kincaid", 60] },
    ]);

    expect(await store.get("kincaid", "new2")).toEqual(session("new2", "2026-09-02T10:00:00.000Z"));
    expect(await store.get("guest", "new2")).toBeNull();

    const listed = await store.list("kincaid", 2);
    expect(listed.map((s) => s.id)).toEqual(["new2", "mid3"]);
    expect(listed[0]).toMatchObject({ title: "Session new2", total: 1, decided: 0 });
    expect(redis.calls.at(-2)).toEqual({
      op: "zrange",
      args: ["pare:sessions:kincaid", 0, 1, { rev: true }],
    });
    expect(redis.calls.at(-1)).toEqual({
      op: "mget",
      args: [["pare:session:kincaid:new2", "pare:session:kincaid:mid3"]],
    });
  });

  test("drops index entries whose session expired or fails to parse", async () => {
    const redis = fakeRedis();
    const store = createRedisStore({ url: "u", token: "t", ttlSeconds: 60, client: redis.client });

    await store.put(session("live", "2026-09-02T10:00:00.000Z"));
    await store.put(session("gone", "2026-09-03T10:00:00.000Z"));
    await store.put(session("junk", "2026-09-04T10:00:00.000Z"));
    redis.strings.delete("pare:session:kincaid:gone");
    redis.strings.set("pare:session:kincaid:junk", JSON.stringify({ id: "junk" }));

    expect((await store.list("kincaid", 10)).map((s) => s.id)).toEqual(["live"]);
    expect(redis.calls.at(-1)).toEqual({
      op: "zrem",
      args: ["pare:sessions:kincaid", ["junk", "gone"]],
    });
    expect([...redis.sets.get("pare:sessions:kincaid")!.keys()]).toEqual(["live"]);
    expect(await store.get("kincaid", "junk")).toBeNull();
  });

  test("lists nothing for an owner with no index", async () => {
    const redis = fakeRedis();
    const store = createRedisStore({ url: "u", token: "t", ttlSeconds: 60, client: redis.client });
    expect(await store.list("nobody", 5)).toEqual([]);
    expect(redis.calls.map((c) => c.op)).toEqual(["zrange"]);
  });
});
