// From "a workout exists" to signed POSTs: queue one outbox item per matching
// subscription (at most once each), then deliver with bounded retries.

import { getDeps } from "../deps";
import { MAX_EVENT_BYTES, postSigned } from "./callback";
import type { McpEvent } from "./schema";
import type { SubscriptionRecord } from "./store";

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;
// Delay before attempt n+1 after n failures. The tick runs every few minutes,
// so shorter steps would only round up to the next tick anyway.
const BACKOFF_MS = [1, 5, 15, 60, 180, 360].map((m) => m * MINUTE_MS);
const MAX_ATTEMPTS = BACKOFF_MS.length + 1;
// Re-analysis or a late upload can surface old workouts; they are not news.
const MAX_WORKOUT_AGE_MS = 7 * DAY_MS;

// Whether a subscription should hear about a workout created at `createdAt`
// (when it reached Hevy or Intervals). Workouts from before the subscription
// existed are history, whatever path brings them in.
export function wantsEvent(sub: SubscriptionRecord, event: McpEvent, createdAt: number): boolean {
  return (
    createdAt >= sub.createdAt &&
    (!sub.arguments.sources || sub.arguments.sources.includes(event.data.source))
  );
}

// Queue an event for every subscription that wants it and has not had it yet.
// Returns the outbox members to attempt right away.
export async function emit(
  event: McpEvent,
  createdAt: number,
  subs: SubscriptionRecord[],
): Promise<string[]> {
  const { store, now } = getDeps();
  if (createdAt < now() - MAX_WORKOUT_AGE_MS) return [];
  const queued = await Promise.all(
    subs.filter((s) => wantsEvent(s, event, createdAt)).map((s) => store.enqueueOnce(s, event)),
  );
  return queued.filter((m): m is string => m !== null);
}

export type DeliveryResult =
  | "delivered"
  | "retrying"
  | "dropped"
  | "subscription_gone"
  | "busy"
  | "error";

export async function deliver(member: string): Promise<DeliveryResult> {
  const { store, callbackFetch, now } = getDeps();
  if (!(await store.lease(member))) return "busy";
  try {
    // Another attempt may have just failed and rescheduled this item.
    if (!(await store.isDue(member))) return "busy";
    const item = await store.getOutboxItem(member);
    const subscriptionId = member.split(" ")[0] ?? "";
    const sub = item ? await store.getSubscription(subscriptionId) : null;
    // An item from before the subscription last restarted (unsubscribe, then
    // resubscribe with the same id) belongs to the old lifetime: drop it.
    if (!item || !sub || sub.createdAt !== item.subscriptionCreatedAt) {
      await store.removeOutbox(member);
      return "subscription_gone";
    }
    const body = JSON.stringify(item.event);
    if (Buffer.byteLength(body, "utf8") > MAX_EVENT_BYTES) {
      await store.removeOutbox(member);
      return "dropped";
    }
    const outcome = await postSigned(callbackFetch, {
      url: sub.url,
      secrets: sub.secrets
        .filter((s) => s.retiresAt === null || s.retiresAt > now())
        .map((s) => s.secret),
      subscriptionId: sub.id,
      messageId: item.event.eventId,
      body,
    });
    if (outcome.kind === "accepted") {
      await store.removeOutbox(member);
      return "delivered";
    }
    const attempts = item.attempts + 1;
    // 410: the receiver does not want this delivery (stale, already handled).
    // 413: too large. Neither is retried; the subscription carries on.
    const final =
      (outcome.kind === "rejected" && (outcome.status === 410 || outcome.status === 413)) ||
      attempts >= MAX_ATTEMPTS;
    if (final) {
      await store.removeOutbox(member);
      return "dropped";
    }
    await store.rescheduleOutbox(
      member,
      { ...item, attempts },
      now() + (BACKOFF_MS[attempts - 1] ?? BACKOFF_MS.at(-1)!),
    );
    return "retrying";
  } finally {
    await store.unlease(member);
  }
}

// Attempt every member; one failure (a Redis hiccup, a bad record) never
// stops the rest.
export async function deliverAll(members: string[]): Promise<DeliveryResult[]> {
  const settled = await Promise.allSettled(members.map(deliver));
  return settled.map((r) => (r.status === "fulfilled" ? r.value : "error"));
}

export async function drainOutbox(limit = 50): Promise<DeliveryResult[]> {
  const { store } = getDeps();
  return deliverAll(await store.dueOutbox(limit));
}
