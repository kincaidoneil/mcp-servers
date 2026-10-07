// Durable event state in Redis: subscriptions and their indexes, emitted-event
// dedupe, the delivery outbox, and Intervals polling baselines.

import { z } from "zod";
import { decryptJwe, encryptJwe } from "@/lib/oauth-as";
import { getConfig } from "../config";
import { CredentialsSchema, type Credentials } from "../credentials";
import type { Kv } from "../kv";
import { SubscriptionArgumentsSchema, type McpEvent } from "./schema";

const DAY_MS = 24 * 60 * 60 * 1000;

const SubscriptionRecordSchema = z.object({
  id: z.string(),
  principalId: z.string(),
  hevyUserId: z.string(),
  intervalsAthleteId: z.string(),
  // Credentials stay in their own encrypted envelope, so a Redis dump alone
  // reveals no API keys.
  sealedCredentials: z.string(),
  arguments: SubscriptionArgumentsSchema,
  url: z.string(),
  // Newest first. A replaced secret keeps signing until retiresAt.
  secrets: z.array(z.object({ secret: z.string(), retiresAt: z.number().nullable() })).min(1),
  createdAt: z.number(),
  expiresAt: z.number(),
});
export type SubscriptionRecord = z.infer<typeof SubscriptionRecordSchema>;

export type SubscriptionIndex =
  | { kind: "hevy"; hevyUserId: string }
  | { kind: "intervals"; athleteId: string }
  | { kind: "all" };

const OutboxItemSchema = z.object({
  event: z.custom<McpEvent>((v) => typeof v === "object" && v !== null),
  attempts: z.number(),
});
export type OutboxItem = z.infer<typeof OutboxItemSchema>;

const key = {
  sub: (id: string) => `wk:sub:${id}`,
  index: (index: SubscriptionIndex) =>
    index.kind === "all"
      ? "wk:subs:all"
      : index.kind === "hevy"
        ? `wk:subs:hevy:${index.hevyUserId}`
        : `wk:subs:intervals:${index.athleteId}`,
  verified: (digest: string) => `wk:verified:${digest}`,
  emitted: (eventId: string) => `wk:emitted:${eventId}`,
  outbox: "wk:outbox",
  outboxItem: (member: string) => `wk:outbox:item:${member}`,
  lease: (member: string) => `wk:lease:${member}`,
  known: (athleteId: string) => `wk:intervals:known:${athleteId}`,
};

function indexesOf(record: SubscriptionRecord): SubscriptionIndex[] {
  return [
    { kind: "all" },
    { kind: "hevy", hevyUserId: record.hevyUserId },
    { kind: "intervals", athleteId: record.intervalsAthleteId },
  ];
}

export function createStore(kv: Kv, now: () => number) {
  async function getSubscription(id: string): Promise<SubscriptionRecord | null> {
    const raw = await kv.get(key.sub(id));
    if (!raw) return null;
    const parsed = SubscriptionRecordSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) return null;
    if (parsed.data.expiresAt <= now()) {
      await deleteSubscription(parsed.data);
      return null;
    }
    return parsed.data;
  }

  async function deleteSubscription(record: SubscriptionRecord) {
    await kv.del(key.sub(record.id));
    await Promise.all(indexesOf(record).map((index) => kv.srem(key.index(index), record.id)));
  }

  return {
    getSubscription,
    deleteSubscription,

    async putSubscription(record: SubscriptionRecord) {
      // Keep the record a day past expiry so a late refresh still finds it.
      await kv.set(key.sub(record.id), JSON.stringify(record), {
        px: record.expiresAt - now() + DAY_MS,
      });
      await Promise.all(indexesOf(record).map((index) => kv.sadd(key.index(index), record.id)));
    },

    // Live subscriptions in an index. Ids whose record is gone are pruned.
    async listSubscriptions(index: SubscriptionIndex): Promise<SubscriptionRecord[]> {
      const ids = await kv.smembers(key.index(index));
      const records = await Promise.all(ids.map(getSubscription));
      await Promise.all(ids.map((id, i) => (records[i] ? null : kv.srem(key.index(index), id))));
      return records.filter((r): r is SubscriptionRecord => r !== null);
    },

    async isCallbackVerified(digest: string) {
      return (await kv.get(key.verified(digest))) !== null;
    },
    async markCallbackVerified(digest: string) {
      await kv.set(key.verified(digest), "1", { px: DAY_MS });
    },

    // True the first time an event id is seen, false on every repeat. Makes
    // upstream retries and re-analysis harmless.
    async claimEmission(eventId: string) {
      return kv.set(key.emitted(eventId), "1", { px: 30 * DAY_MS, nx: true });
    },
    async releaseEmission(eventId: string) {
      await kv.del(key.emitted(eventId));
    },

    async enqueue(subscriptionId: string, event: McpEvent): Promise<string> {
      const member = `${subscriptionId} ${event.eventId}`;
      const item: OutboxItem = { event, attempts: 0 };
      await kv.set(key.outboxItem(member), JSON.stringify(item), { px: 3 * DAY_MS });
      await kv.zadd(key.outbox, now(), member);
      return member;
    },
    async dueOutbox(limit: number) {
      return kv.zrangeByScore(key.outbox, now(), limit);
    },
    async getOutboxItem(member: string): Promise<OutboxItem | null> {
      const raw = await kv.get(key.outboxItem(member));
      if (!raw) return null;
      const parsed = OutboxItemSchema.safeParse(JSON.parse(raw));
      return parsed.success ? parsed.data : null;
    },
    async rescheduleOutbox(member: string, item: OutboxItem, at: number) {
      await kv.set(key.outboxItem(member), JSON.stringify(item), { px: 3 * DAY_MS });
      await kv.zadd(key.outbox, at, member);
    },
    async removeOutbox(member: string) {
      await kv.zrem(key.outbox, member);
      await kv.del(key.outboxItem(member));
    },
    // Short exclusive claim so a webhook-triggered attempt and a tick never
    // post the same item at once.
    async lease(member: string) {
      return kv.set(key.lease(member), "1", { px: 30_000, nx: true });
    },
    async unlease(member: string) {
      await kv.del(key.lease(member));
    },

    async getKnownActivities(athleteId: string): Promise<string[] | null> {
      const raw = await kv.get(key.known(athleteId));
      return raw ? (JSON.parse(raw) as string[]) : null;
    },
    async setKnownActivities(athleteId: string, ids: string[]) {
      await kv.set(key.known(athleteId), JSON.stringify(ids), { px: 14 * DAY_MS });
    },
  };
}

export type Store = ReturnType<typeof createStore>;

export async function sealCredentials(credentials: Credentials, expiresAt: number, now: number) {
  const ttlSeconds = Math.ceil((expiresAt - now + DAY_MS) / 1000);
  return encryptJwe(
    { typ: "subscription-credentials", credentials },
    getConfig().oauth.signingKey,
    ttlSeconds,
  );
}

export async function openCredentials(sealed: string): Promise<Credentials | null> {
  const result = await decryptJwe<{ typ: "subscription-credentials"; credentials: unknown }>(
    sealed,
    getConfig().oauth.signingKey,
    "subscription-credentials",
  );
  if (!result.ok) return null;
  const parsed = CredentialsSchema.safeParse(result.payload.credentials);
  return parsed.success ? parsed.data : null;
}
