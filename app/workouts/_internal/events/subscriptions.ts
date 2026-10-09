// events/subscribe and events/unsubscribe.

import { createHash } from "node:crypto";
import type { Principal } from "../credentials";
import { getDeps } from "../deps";
import { checkCredentials, ensureHevyWebhook, releaseHevyWebhook } from "../sources";
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
  const locked = await store.withAccountLock(principal.id, () =>
    activate(principal, params, { id, url: url.url, args: args.data }),
  );
  return locked ? locked.value : busy();
}

function busy(): RpcFailure {
  return {
    ok: false,
    code: SERVER_ERROR,
    message: "Another subscription change for this account is in progress; retry shortly.",
  };
}

// Runs under the account lock, so what it reads stays true until it writes.
async function activate(
  principal: Principal,
  params: SubscribeParams,
  ctx: { id: string; url: string; args: SubscriptionRecord["arguments"] },
): Promise<SubscribeOutcome> {
  const { store, callbackFetch, now } = getDeps();
  const { id, args } = ctx;
  const secret = params.delivery.secret;

  // A late refresh of an expired subscription starts over, createdAt
  // included: this event has no replay, so workouts from the lapse are not
  // delivered.
  const existing = await store.getSubscription(id);
  const others = (
    await store.listSubscriptions({ kind: "principal", principalId: principal.id })
  ).filter((s) => s.id !== id);
  if (!existing && others.length >= MAX_SUBSCRIPTIONS_PER_ACCOUNT) {
    return {
      ok: false,
      code: SERVER_ERROR,
      message: `This account already has ${MAX_SUBSCRIPTIONS_PER_ACCOUNT} subscriptions; unsubscribe one first.`,
    };
  }

  // Keyed by the secret too: a refresh that rotates the secret must prove the
  // receiver has the new one before the old one retires.
  const verifiedKey = digest([principal.id, params.delivery.url, secret]);
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

  const credentialsOk = await checkCredentials(principal);
  if (!credentialsOk.ok) return { ok: false, code: SERVER_ERROR, message: credentialsOk.reason };

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
  const credentialsUntil = Math.max(expiresAt, ...others.map((s) => s.expiresAt));
  // Sealed to outlast the record this refresh replaces too, so a rollback
  // that restores it can't outlive the ciphertext. Redis still drops them at
  // `credentialsUntil`.
  const sealedUntil = Math.max(credentialsUntil, existing?.expiresAt ?? 0);
  await store.putCredentials(
    principal.id,
    await sealCredentials(principal.credentials, sealedUntil, at),
    credentialsUntil,
  );
  await store.putSubscription(record);

  // The webhook goes on only once the subscription is stored, so a workout
  // saved the moment it's enabled finds someone to deliver to. Every
  // subscribe and refresh re-checks it, so a webhook removed on Hevy's side
  // comes back within one refresh.
  if (wantsHevy({ arguments: args })) {
    // Marked before the webhook exists, so the tick can find and release it
    // even if this invocation dies right after Hevy creates it.
    await store.markWebhookOwner(principal.id);
    const webhook = await ensureHevyWebhook(principal);
    if (!webhook.ok) {
      // Leave things as they were: a new subscription is withdrawn, a refresh
      // keeps its previous record, and the credentials live only as long as
      // what remains.
      if (existing) await store.putSubscription(existing);
      else await store.deleteSubscription(record);
      const remaining = [...others, ...(existing ? [existing] : [])];
      if (remaining.length === 0) await store.deleteCredentials(principal.id);
      else {
        await store.expireCredentials(principal.id, Math.max(...remaining.map((s) => s.expiresAt)));
      }
      return { ok: false, code: SERVER_ERROR, message: webhook.reason };
    }
  }

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

function wantsHevy(s: Pick<SubscriptionRecord, "arguments">): boolean {
  return !s.arguments.sources || s.arguments.sources.includes("hevy");
}

export async function unsubscribe(
  principal: Principal,
  params: UnsubscribeParams,
): Promise<{ ok: true } | RpcFailure> {
  const { store, now } = getDeps();
  const id = subscriptionId(principal, params.delivery.url, params.name, params.arguments);
  const locked = await store.withAccountLock(principal.id, async () => {
    const existing = await store.getSubscription(id);
    // A subscription id only matches when it was created by this principal,
    // so there is nothing else to authorize.
    if (!existing) return;
    await store.deleteSubscription(existing);

    // Clean up what only subscriptions need: the account's credentials, and
    // the Hevy account's single webhook slot.
    const remaining = await store.listSubscriptions({
      kind: "principal",
      principalId: principal.id,
    });
    let releasePending = false;
    if (wantsHevy(existing)) {
      const hevySubs = await store.listSubscriptions({
        kind: "hevy",
        hevyUserId: principal.identity.hevyUserId,
      });
      // The lock is per account; two allowlisted accounts sharing one Hevy
      // user could race here. The allowlist pairs each Hevy user with one
      // athlete in practice, so this does not serialize across accounts.
      if (!hevySubs.some(wantsHevy)) {
        if (await releaseHevyWebhook(principal.credentials.hevy.apiKey)) {
          await store.unmarkWebhookOwner(principal.id);
        } else {
          releasePending = true;
        }
      }
    }
    // Credentials live only as long as the longest remaining subscription.
    // If Hevy couldn't be reached, they and the owner mark stay through the
    // cleanup grace so the tick can retry the release.
    if (remaining.length > 0) {
      await store.expireCredentials(principal.id, Math.max(...remaining.map((s) => s.expiresAt)));
    } else if (releasePending) {
      await store.expireCredentials(principal.id, now());
    } else {
      await store.deleteCredentials(principal.id);
    }
  });
  return locked ? { ok: true } : busy();
}
