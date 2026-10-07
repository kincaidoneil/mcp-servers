// From "a workout exists" to signed POSTs: claim the event once, queue one
// outbox item per matching subscription, and deliver with bounded retries.

import { getDeps } from "../deps";
import { MAX_EVENT_BYTES, postSigned } from "./callback";
import type { McpEvent } from "./schema";
import type { SubscriptionRecord } from "./store";

const MINUTE_MS = 60_000;
// Delay before attempt n+1 after n failures. The tick runs every few minutes,
// so shorter steps would only round up to the next tick anyway.
const BACKOFF_MS = [1, 5, 15, 60, 180, 360].map((m) => m * MINUTE_MS);
const MAX_ATTEMPTS = BACKOFF_MS.length + 1;

export function wantsEvent(sub: SubscriptionRecord, event: McpEvent): boolean {
  return !sub.arguments.sources || sub.arguments.sources.includes(event.data.source);
}

// Queue an event for every matching subscription, once per event id. Returns
// the outbox members to attempt right away.
export async function emit(event: McpEvent, subs: SubscriptionRecord[]): Promise<string[]> {
  const { store } = getDeps();
  const matching = subs.filter((s) => wantsEvent(s, event));
  if (matching.length === 0) return [];
  if (!(await store.claimEmission(event.eventId))) return [];
  try {
    return await Promise.all(matching.map((s) => store.enqueue(s.id, event)));
  } catch (err) {
    // Nothing durable was queued, so let the upstream retry emit it again.
    await store.releaseEmission(event.eventId);
    throw err;
  }
}

export type DeliveryResult = "delivered" | "retrying" | "dropped" | "subscription_gone" | "busy";

export async function deliver(member: string): Promise<DeliveryResult> {
  const { store, callbackFetch, now } = getDeps();
  if (!(await store.lease(member))) return "busy";
  try {
    const item = await store.getOutboxItem(member);
    const subscriptionId = member.split(" ")[0] ?? "";
    const sub = item ? await store.getSubscription(subscriptionId) : null;
    if (!item || !sub) {
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
    if (outcome.kind === "rejected" && outcome.status === 410) {
      // The receiver says this subscription no longer exists.
      await store.removeOutbox(member);
      await store.deleteSubscription(sub);
      return "subscription_gone";
    }
    const attempts = item.attempts + 1;
    if ((outcome.kind === "rejected" && outcome.status === 413) || attempts >= MAX_ATTEMPTS) {
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

export async function deliverAll(members: string[]): Promise<DeliveryResult[]> {
  return Promise.all(members.map(deliver));
}

export async function drainOutbox(limit = 50): Promise<DeliveryResult[]> {
  const { store } = getDeps();
  return deliverAll(await store.dueOutbox(limit));
}
