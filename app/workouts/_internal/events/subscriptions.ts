// events/subscribe and events/unsubscribe.

import { createHash } from "node:crypto";
import type { Principal } from "../credentials";
import { getDeps } from "../deps";
import { ensureHevyWebhook, releaseHevyWebhook } from "../sources";
import { checkCallbackUrl, checkSigningSecret, verifyCallback } from "./callback";
import {
  CALLBACK_ENDPOINT_ERROR,
  SubscriptionArgumentsSchema,
  WORKOUT_COMPLETED,
  type SubscribeParams,
  type UnsubscribeParams,
} from "./schema";
import { sealCredentials, type SubscriptionRecord } from "./store";

const HOUR_MS = 60 * 60 * 1000;
const DEFAULT_TTL_MS = 7 * 24 * HOUR_MS;
const MIN_TTL_MS = HOUR_MS;
const MAX_TTL_MS = 30 * 24 * HOUR_MS;
// How long a replaced signing secret keeps signing alongside the new one.
const ROTATION_WINDOW_MS = 10 * 60 * 1000;

// Each subscription is one callback URL and filter; nobody needs more, and a
// cap bounds the fan-out of every workout.
const MAX_SUBSCRIPTIONS_PER_ACCOUNT = 10;

const INVALID_PARAMS = -32602;
const NOT_FOUND = -32011;
const SERVER_ERROR = -32603;

export type RpcFailure = { ok: false; code: number; message: string; data?: unknown };

export type SubscribeOutcome =
  | {
      ok: true;
      result: { id: string; refreshBefore: string; cursor: null; truncated: false };
    }
  | RpcFailure;

// JSON with object keys sorted at every depth, so key order never makes two
// requests look like different subscriptions.
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function digest(parts: unknown[]): string {
  return createHash("sha256").update(canonicalJson(parts)).digest("base64url");
}

export function subscriptionId(principal: Principal, url: string, name: string, args: unknown) {
  return `sub_${digest([principal.id, url, name, args ?? {}]).slice(0, 32)}`;
}

function grantTtl(requested: number | null | undefined): number {
  if (requested === undefined) return DEFAULT_TTL_MS;
  // null asks for no expiry. Grant the maximum instead: an expiry is what
  // eventually cleans up after a client that disappears without unsubscribing.
  if (requested === null) return MAX_TTL_MS;
  return Math.min(Math.max(requested, MIN_TTL_MS), MAX_TTL_MS);
}

export async function subscribe(
  principal: Principal,
  params: SubscribeParams,
): Promise<SubscribeOutcome> {
  const { store } = getDeps();

  if (params.name !== WORKOUT_COMPLETED) {
    return { ok: false, code: NOT_FOUND, message: `Unknown event: ${params.name}` };
  }
  const args = SubscriptionArgumentsSchema.safeParse(params.arguments ?? {});
  if (!args.success) {
    return { ok: false, code: INVALID_PARAMS, message: `Invalid arguments: ${args.error.message}` };
  }
  const url = checkCallbackUrl(params.delivery.url);
  if (!url.ok) return { ok: false, code: INVALID_PARAMS, message: url.reason };
  const secret = params.delivery.secret;
  const secretCheck = checkSigningSecret(secret);
  if (!secretCheck.ok) return { ok: false, code: INVALID_PARAMS, message: secretCheck.reason };

  // Identity uses the URL exactly as sent, so unsubscribe finds it again.
  const id = subscriptionId(principal, params.delivery.url, params.name, params.arguments);
  // A late refresh of an expired subscription starts over, createdAt
  // included: this event has no replay, so workouts from the lapse are not
  // delivered.
  const existing = await store.getSubscription(id);
  const live = await store.listSubscriptions({ kind: "principal", principalId: principal.id });
  if (!existing) {
    const reserved = await store.reserveSubscription(
      principal.id,
      id,
      MAX_SUBSCRIPTIONS_PER_ACCOUNT,
    );
    if (!reserved) {
      return {
        ok: false,
        code: SERVER_ERROR,
        message: `This account already has ${MAX_SUBSCRIPTIONS_PER_ACCOUNT} subscriptions; unsubscribe one first.`,
      };
    }
  }
  const outcome = await activate(principal, params, {
    id,
    url: url.url,
    args: args.data,
    existing,
    live,
  });
  if (!outcome.ok && !existing) await store.unreserveSubscription(principal.id, id);
  return outcome;
}

async function activate(
  principal: Principal,
  params: SubscribeParams,
  ctx: {
    id: string;
    url: string;
    args: SubscriptionRecord["arguments"];
    existing: SubscriptionRecord | null;
    live: SubscriptionRecord[];
  },
): Promise<SubscribeOutcome> {
  const { store, callbackFetch, now } = getDeps();
  const { id, args, existing } = ctx;
  const secret = params.delivery.secret;

  const verifiedKey = digest([principal.id, params.delivery.url]);
  if (!(await store.isCallbackVerified(verifiedKey))) {
    const verified = await verifyCallback(callbackFetch, {
      url: ctx.url,
      secret,
      subscriptionId: id,
    });
    if (!verified.ok) {
      return {
        ok: false,
        code: CALLBACK_ENDPOINT_ERROR,
        message: "Callback verification failed",
        data: { reason: verified.reason },
      };
    }
    await store.markCallbackVerified(verifiedKey);
  }

  if (!args.sources || args.sources.includes("hevy")) {
    // Every subscribe and refresh re-checks the registration, so a webhook
    // removed on Hevy's side comes back within one refresh.
    const webhook = await ensureHevyWebhook(principal);
    if (!webhook.ok) return { ok: false, code: SERVER_ERROR, message: webhook.reason };
  }

  const at = now();
  const expiresAt = at + grantTtl(params.ttlMs);
  const record: SubscriptionRecord = {
    id,
    principalId: principal.id,
    hevyUserId: principal.identity.hevyUserId,
    intervalsAthleteId: principal.identity.intervalsAthleteId,
    arguments: args,
    url: ctx.url,
    secrets: nextSecrets(existing, secret, at),
    createdAt: existing?.createdAt ?? at,
    expiresAt,
  };
  // The newest credentials serve every subscription on the account, for as
  // long as the longest-lived one.
  const credentialsUntil = Math.max(
    expiresAt,
    ...ctx.live.filter((s) => s.id !== id).map((s) => s.expiresAt),
  );
  await store.putCredentials(
    principal.id,
    await sealCredentials(principal.credentials, credentialsUntil, at),
    credentialsUntil,
  );
  await store.putSubscription(record);

  return {
    ok: true,
    result: {
      id,
      refreshBefore: new Date(expiresAt).toISOString(),
      cursor: null,
      truncated: false,
    },
  };
}

function nextSecrets(
  existing: SubscriptionRecord | null,
  secret: string,
  at: number,
): SubscriptionRecord["secrets"] {
  const current = { secret, retiresAt: null };
  if (!existing) return [current];
  const live = existing.secrets.filter(
    (s) => s.secret !== secret && (s.retiresAt === null || s.retiresAt > at),
  );
  return [
    current,
    ...live.map((s) => ({ secret: s.secret, retiresAt: s.retiresAt ?? at + ROTATION_WINDOW_MS })),
  ];
}

function wantsHevy(s: SubscriptionRecord): boolean {
  return !s.arguments.sources || s.arguments.sources.includes("hevy");
}

export async function unsubscribe(principal: Principal, params: UnsubscribeParams) {
  const { store } = getDeps();
  const id = subscriptionId(principal, params.delivery.url, params.name, params.arguments);
  const existing = await store.getSubscription(id);
  // A subscription id only matches when it was created by this principal, so
  // there is nothing else to authorize.
  if (!existing) return {};
  await store.deleteSubscription(existing);

  // Clean up what only live subscriptions need: the account's credentials,
  // and the Hevy account's single webhook slot.
  const remaining = await store.listSubscriptions({ kind: "principal", principalId: principal.id });
  if (remaining.length === 0) await store.deleteCredentials(principal.id);
  if (wantsHevy(existing)) {
    const hevySubs = await store.listSubscriptions({
      kind: "hevy",
      hevyUserId: principal.identity.hevyUserId,
    });
    if (!hevySubs.some(wantsHevy)) await releaseHevyWebhook(principal).catch(() => undefined);
  }
  return {};
}
