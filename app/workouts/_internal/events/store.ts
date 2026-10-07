// Durable event state in Redis: subscriptions and their indexes, each
// account's sealed upstream credentials, the delivery outbox with its
// per-subscription dedupe claims, and which Intervals activities polling has
// already handled.

import { z } from "zod";
import { decryptJwe, encryptJwe } from "@/lib/oauth-as";
import { getConfig } from "../config";
import { CredentialsSchema, type Credentials } from "../credentials";
import type { Kv } from "../kv";
import { SubscriptionArgumentsSchema, type McpEvent } from "./schema";

const DAY_MS = 24 * 60 * 60 * 1000;
// How long a delivered (or queued) event stays claimed for a subscription.
// Longer than any window in which the same workout could be seen again.
const CLAIM_MS = 30 * DAY_MS;
const ITEM_MS = 3 * DAY_MS;

const SubscriptionRecordSchema = z.object({
  id: z.string(),
  principalId: z.string(),
  hevyUserId: z.string(),
  intervalsAthleteId: z.string(),
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
  | { kind: "principal"; principalId: string }
  | { kind: "all" };

const OutboxItemSchema = z.object({
  event: z.custom<McpEvent>((v) => typeof v === "object" && v !== null),
  attempts: z.number(),
});
export type OutboxItem = z.infer<typeof OutboxItemSchema>;

const key = {
  sub: (id: string) => `wk:sub:${id}`,
  reserved: (id: string) => `wk:reserved:${id}`,
  index: (index: SubscriptionIndex) => {
    switch (index.kind) {
      case "all":
        return "wk:subs:all";
      case "hevy":
        return `wk:subs:hevy:${index.hevyUserId}`;
      case "intervals":
        return `wk:subs:intervals:${index.athleteId}`;
      case "principal":
        return `wk:subs:principal:${index.principalId}`;
    }
  },
  credentials: (principalId: string) => `wk:credentials:${principalId}`,
  verified: (digest: string) => `wk:verified:${digest}`,
  claim: (subscriptionId: string, eventId: string) => `wk:claim:${subscriptionId}:${eventId}`,
  outbox: "wk:outbox",
  outboxItem: (member: string) => `wk:outbox:item:${member}`,
  lease: (member: string) => `wk:lease:${member}`,
  handled: (principalId: string) => `wk:intervals:handled:${principalId}`,
};

function indexesOf(record: SubscriptionRecord): SubscriptionIndex[] {
  return [
    { kind: "all" },
    { kind: "hevy", hevyUserId: record.hevyUserId },
    { kind: "intervals", athleteId: record.intervalsAthleteId },
    { kind: "principal", principalId: record.principalId },
  ];
}

function parse<T>(schema: z.ZodType<T>, raw: string | null): T | null {
  if (raw === null) return null;
  try {
    const parsed = schema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function outboxMember(subscriptionId: string, eventId: string): string {
  return `${subscriptionId} ${eventId}`;
}

export function createStore(kv: Kv, now: () => number) {
  // Expired records are skipped, not deleted: deleting here could race a
  // refresh that rewrites the same key. Redis expiry removes them.
  async function getSubscription(id: string): Promise<SubscriptionRecord | null> {
    const record = parse(SubscriptionRecordSchema, await kv.get(key.sub(id)));
    return record && record.expiresAt > now() ? record : null;
  }

  return {
    getSubscription,

    async putSubscription(record: SubscriptionRecord) {
      await kv.set(key.sub(record.id), JSON.stringify(record), {
        px: Math.max(record.expiresAt - now(), 1),
      });
      await Promise.all(indexesOf(record).map((index) => kv.sadd(key.index(index), record.id)));
    },

    async deleteSubscription(record: SubscriptionRecord) {
      await kv.del(key.sub(record.id));
      await Promise.all(indexesOf(record).map((index) => kv.srem(key.index(index), record.id)));
    },

    // Live subscriptions in an index. Ids whose record is gone from Redis are
    // pruned, except in the per-account index: there an id may be reserved by
    // a subscribe still in flight, and reserveSubscription prunes atomically.
    async listSubscriptions(index: SubscriptionIndex): Promise<SubscriptionRecord[]> {
      const ids = await kv.smembers(key.index(index));
      const raws = await Promise.all(ids.map((id) => kv.get(key.sub(id))));
      if (index.kind !== "principal") {
        await Promise.all(
          ids.map((id, i) => (raws[i] === null ? kv.srem(key.index(index), id) : null)),
        );
      }
      return raws
        .map((raw) => parse(SubscriptionRecordSchema, raw))
        .filter((r): r is SubscriptionRecord => r !== null && r.expiresAt > now());
    },

    // Reserve a place in the account's index before the slow parts of
    // subscribing (verification, the Hevy webhook), so concurrent requests
    // cannot overshoot the cap. Unreserve if subscribing then fails.
    async reserveSubscription(principalId: string, id: string, max: number) {
      return kv.reserve({
        setKey: key.index({ kind: "principal", principalId }),
        member: id,
        max,
        recordPrefix: key.sub(""),
        markerPrefix: key.reserved(""),
        // Longer than verification (10 s) plus the Hevy calls.
        markerPx: 60_000,
      });
    },
    async unreserveSubscription(principalId: string, id: string) {
      await kv.srem(key.index({ kind: "principal", principalId }), id);
    },

    // One credential record per account, replaced on every subscribe and
    // refresh, so the newest key is the one used. It lives exactly as long as
    // the account's longest-lived subscription.
    async putCredentials(principalId: string, sealed: string, until: number) {
      await kv.set(key.credentials(principalId), sealed, { px: Math.max(until - now(), 1) });
    },
    async deleteCredentials(principalId: string) {
      await kv.del(key.credentials(principalId));
    },
    async getCredentials(principalId: string): Promise<string | null> {
      return kv.get(key.credentials(principalId));
    },

    async isCallbackVerified(digest: string) {
      return (await kv.get(key.verified(digest))) !== null;
    },
    async markCallbackVerified(digest: string) {
      await kv.set(key.verified(digest), "1", { px: DAY_MS });
    },

    // Queue an event for one subscription unless it was queued before.
    // Returns the outbox member when newly queued.
    async enqueueOnce(subscriptionId: string, event: McpEvent): Promise<string | null> {
      const member = outboxMember(subscriptionId, event.eventId);
      const item: OutboxItem = { event, attempts: 0 };
      const taken = await kv.enqueueOnce({
        claimKey: key.claim(subscriptionId, event.eventId),
        claimPx: CLAIM_MS,
        itemKey: key.outboxItem(member),
        item: JSON.stringify(item),
        itemPx: ITEM_MS,
        zsetKey: key.outbox,
        score: now(),
        member,
      });
      return taken ? member : null;
    },
    async dueOutbox(limit: number) {
      return kv.zrangeByScore(key.outbox, now(), limit);
    },
    async isDue(member: string) {
      const score = await kv.zscore(key.outbox, member);
      return score !== null && score <= now();
    },
    async getOutboxItem(member: string): Promise<OutboxItem | null> {
      return parse(OutboxItemSchema, await kv.get(key.outboxItem(member)));
    },
    async rescheduleOutbox(member: string, item: OutboxItem, at: number) {
      await kv.set(key.outboxItem(member), JSON.stringify(item), { px: ITEM_MS });
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

    // Activities polling has finished with, so each tick fetches details only
    // for new ones. Correctness does not depend on it: claims dedupe.
    // Per account, not per athlete: two accounts sharing an athlete must not
    // mark each other's activities done.
    async getHandledActivities(principalId: string): Promise<Set<string>> {
      return new Set(parse(z.array(z.string()), await kv.get(key.handled(principalId))) ?? []);
    },
    async setHandledActivities(principalId: string, ids: string[]) {
      await kv.set(key.handled(principalId), JSON.stringify(ids), { px: 14 * DAY_MS });
    },
  };
}

export type Store = ReturnType<typeof createStore>;

export async function sealCredentials(credentials: Credentials, until: number, now: number) {
  const ttlSeconds = Math.max(Math.ceil((until - now) / 1000), 1);
  return encryptJwe(
    { typ: "subscription-credentials", credentials },
    getConfig().oauth.signingKey,
    ttlSeconds,
  );
}

export async function openCredentials(sealed: string | null): Promise<Credentials | null> {
  if (!sealed) return null;
  const result = await decryptJwe<{ typ: "subscription-credentials"; credentials: unknown }>(
    sealed,
    getConfig().oauth.signingKey,
    "subscription-credentials",
  );
  if (!result.ok) return null;
  const parsed = CredentialsSchema.safeParse(result.payload.credentials);
  return parsed.success ? parsed.data : null;
}
