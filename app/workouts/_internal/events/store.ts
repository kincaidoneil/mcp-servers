// Durable event state in Redis: subscriptions and their indexes, each
// account's sealed upstream credentials, the delivery outbox with its
// per-subscription dedupe claims, and which Intervals activities polling has
// already handled.

import { createHash, randomUUID } from "node:crypto";
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
// The lock outlives the slowest subscribe (verification 10 s, the credential
// check 10 s, four Hevy webhook calls at 10 s each); waiters give up after
// LOCK_WAIT_MS.
const LOCK_MS = 120_000;
// Credentials outlive the last subscription by this much, so the tick can
// still release the account's Hevy webhook after subscriptions just expire.
const CLEANUP_GRACE_MS = DAY_MS;
const LOCK_WAIT_MS = 60_000;

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
  // createdAt of the subscription it was queued for. A subscription id is
  // reused when a client resubscribes, so delivery checks this to drop items
  // left over from an earlier lifetime.
  subscriptionCreatedAt: z.number(),
});
export type OutboxItem = z.infer<typeof OutboxItemSchema>;

const key = {
  sub: (id: string) => `wk:sub:${id}`,
  lock: (principalId: string) => `wk:lock:${principalId}`,
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
  webhookOwners: "wk:hevy:webhook-owners",
  verified: (digest: string) => `wk:verified:${digest}`,
  // Includes the subscription's createdAt: a resubscribe reuses the id, and
  // the new lifetime must not inherit the old one's claims.
  claim: (sub: SubscriptionRecord, eventId: string) =>
    `wk:claim:${sub.id}:${sub.createdAt}:${eventId}`,
  outbox: "wk:outbox",
  outboxItem: (member: string) => `wk:outbox:item:${member}`,
  lease: (member: string) => `wk:lease:${member}`,
  handled: (principalId: string, subscriptions: string) =>
    `wk:intervals:handled:${principalId}:${subscriptions}`,
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

function digestIds(ids: string[]): string {
  return createHash("sha256").update(ids.toSorted().join(",")).digest("base64url").slice(0, 16);
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

  // Live subscriptions in an index. Ids whose record is gone from Redis are
  // pruned; expired-but-present ones are skipped.
  async function listSubscriptions(index: SubscriptionIndex): Promise<SubscriptionRecord[]> {
    const ids = await kv.smembers(key.index(index));
    const raws = await Promise.all(ids.map((id) => kv.get(key.sub(id))));
    await Promise.all(
      ids.map((id, i) =>
        raws[i] === null ? kv.sremIfMissing(key.index(index), id, key.sub(id)) : null,
      ),
    );
    return raws
      .map((raw) => parse(SubscriptionRecordSchema, raw))
      .filter((r): r is SubscriptionRecord => r !== null && r.expiresAt > now());
  }

  async function deleteSubscription(record: SubscriptionRecord) {
    await kv.del(key.sub(record.id));
    await Promise.all(indexesOf(record).map((index) => kv.srem(key.index(index), record.id)));
  }

  // Run fn while holding the account's lock. Subscribe and unsubscribe take
  // it, so their check-then-write steps (the cap, credential lifetime,
  // cleanup) never interleave. They are rare, so waiting costs nothing.
  // Returns null if the lock stays busy past LOCK_WAIT_MS.
  async function withAccountLock<T>(
    principalId: string,
    fn: () => Promise<T>,
  ): Promise<{ value: T } | null> {
    const token = randomUUID();
    // Real time, not the injectable clock: this is a wait, not a timestamp.
    const deadline = Date.now() + LOCK_WAIT_MS;
    // oxlint-disable-next-line no-await-in-loop -- polling for the lock
    while (!(await kv.set(key.lock(principalId), token, { px: LOCK_MS, nx: true }))) {
      if (Date.now() > deadline) return null;
      // oxlint-disable-next-line no-await-in-loop -- polling for the lock
      await new Promise((resolve) => setTimeout(resolve, 25 + Math.random() * 50));
    }
    try {
      return { value: await fn() };
    } finally {
      await kv.delIfEquals(key.lock(principalId), token);
    }
  }

  return {
    getSubscription,

    // Record and indexes in one write: ingestion must never see a new
    // subscription in one place but not the other.
    async putSubscription(record: SubscriptionRecord) {
      await kv.setIndexed({
        key: key.sub(record.id),
        value: JSON.stringify(record),
        px: Math.max(record.expiresAt - now(), 1),
        member: record.id,
        sets: indexesOf(record).map((index) => key.index(index)),
      });
    },

    deleteSubscription,

    listSubscriptions,

    withAccountLock,

    // One credential record per account, replaced on every subscribe and
    // refresh so the newest key is the one used, living as long as `until`.
    async putCredentials(principalId: string, sealed: string, until: number) {
      await kv.set(key.credentials(principalId), sealed, {
        px: Math.max(until - now(), 0) + CLEANUP_GRACE_MS,
      });
    },
    // Delete the account's subscriptions and credentials after an upstream
    // rejected `sealed`, unless a refresh has stored different credentials
    // since. Under the account lock, so it can't interleave with a refresh.
    async revokeAccount(principalId: string, sealed: string) {
      await withAccountLock(principalId, async () => {
        if ((await kv.get(key.credentials(principalId))) !== sealed) return;
        const subs = await listSubscriptions({ kind: "principal", principalId });
        await Promise.all(subs.map((s) => deleteSubscription(s)));
        await kv.del(key.credentials(principalId));
      });
    },
    async expireCredentials(principalId: string, until: number) {
      const sealed = await kv.get(key.credentials(principalId));
      if (sealed) {
        await kv.set(key.credentials(principalId), sealed, {
          px: Math.max(until - now(), 0) + CLEANUP_GRACE_MS,
        });
      }
    },
    // Accounts whose Hevy webhook points here, for the tick's cleanup.
    async markWebhookOwner(principalId: string) {
      await kv.sadd(key.webhookOwners, principalId);
    },
    async unmarkWebhookOwner(principalId: string) {
      await kv.srem(key.webhookOwners, principalId);
    },
    async listWebhookOwners() {
      return kv.smembers(key.webhookOwners);
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
    async enqueueOnce(sub: SubscriptionRecord, event: McpEvent): Promise<string | null> {
      const member = outboxMember(sub.id, event.eventId);
      const item: OutboxItem = { event, attempts: 0, subscriptionCreatedAt: sub.createdAt };
      const taken = await kv.enqueueOnce({
        claimKey: key.claim(sub, event.eventId),
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
    // for new ones. Keyed by the exact set of subscriptions polled, so a
    // subscription added since starts from a clean slate (claims keep the
    // existing ones from receiving anything twice).
    async getHandledActivities(
      principalId: string,
      subscriptionIds: string[],
    ): Promise<Set<string>> {
      const raw = await kv.get(key.handled(principalId, digestIds(subscriptionIds)));
      return new Set(parse(z.array(z.string()), raw) ?? []);
    },
    async setHandledActivities(principalId: string, subscriptionIds: string[], ids: string[]) {
      await kv.set(key.handled(principalId, digestIds(subscriptionIds)), JSON.stringify(ids), {
        px: 14 * DAY_MS,
      });
    },
  };
}

export type Store = ReturnType<typeof createStore>;

export async function sealCredentials(credentials: Credentials, until: number, now: number) {
  // Valid as long as the stored copy, cleanup grace included.
  const ttlSeconds = Math.ceil((Math.max(until - now, 0) + CLEANUP_GRACE_MS) / 1000);
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
