// Turning upstream signals (a Hevy webhook, an Intervals webhook, a poll) into
// workout.completed events for the matching subscriptions.

import { createHmac, timingSafeEqual } from "node:crypto";
import { createHevyClient } from "@/app/hevy/_internal/client";
import { renderWorkout } from "@/app/hevy/_internal/render";
import { getConfig } from "./config";
import type { Credentials, Principal } from "./credentials";
import { getDeps } from "./deps";
import { emit } from "./events/dispatch";
import { WORKOUT_COMPLETED, type McpEvent } from "./events/schema";
import { openCredentials, type SubscriptionRecord } from "./events/store";
import { activityUrl, createIntervalsClient, renderActivity, type Activity } from "./intervals";

// ---- Hevy webhook registration ----

const HEVY_WEBHOOK_PATH = "/webhooks/hevy";

export function hevyWebhookUrl(hevyUserId: string): string {
  const url = new URL(`${getConfig().oauth.baseUrl}${HEVY_WEBHOOK_PATH}`);
  url.searchParams.set("user", hevyUserId);
  return url.toString();
}

// Hevy's payload names only the workout, so the URL names the user and this
// token proves the URL came from us. Derived, never stored.
export function hevyWebhookToken(hevyUserId: string): string {
  const mac = createHmac("sha256", getConfig().oauth.signingKey)
    .update(`hevy-webhook:${hevyUserId}`)
    .digest("base64url");
  return `Bearer ${mac}`;
}

export function checkHevyWebhookAuth(hevyUserId: string, header: string | null): boolean {
  if (!header) return false;
  const expected = Buffer.from(hevyWebhookToken(hevyUserId));
  const actual = Buffer.from(header);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export type EnsureWebhookResult = { ok: true } | { ok: false; reason: string };

// Point the account's single Hevy webhook at this server. Never replaces a
// webhook that belongs to someone else.
export async function ensureHevyWebhook(principal: Principal): Promise<EnsureWebhookResult> {
  const client = createHevyClient(principal.credentials.hevy.apiKey);
  const url = hevyWebhookUrl(principal.identity.hevyUserId);
  const authToken = hevyWebhookToken(principal.identity.hevyUserId);

  const current = await client.getWebhookSubscription();
  if (current.ok) {
    if (current.value.url === url && current.value.auth_token === authToken) return { ok: true };
    const ours = current.value.url.startsWith(`${getConfig().oauth.baseUrl}${HEVY_WEBHOOK_PATH}`);
    if (!ours) {
      return {
        ok: false,
        reason:
          `This Hevy account already sends its webhook to ${safeHost(current.value.url)}, and Hevy ` +
          "allows only one. Remove that webhook in the other service first.",
      };
    }
    const removed = await client.deleteWebhookSubscription();
    if (!removed.ok)
      return { ok: false, reason: `Could not replace the Hevy webhook (${removed.code}).` };
  } else if (current.code !== "not_found") {
    return { ok: false, reason: `Could not read the Hevy webhook (${current.code}).` };
  }

  const created = await client.createWebhookSubscription({ url, authToken });
  return created.ok
    ? { ok: true }
    : { ok: false, reason: `Could not register the Hevy webhook (${created.code}).` };
}

function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "another URL";
  }
}

// ---- Event construction ----

export async function hevyEvent(credentials: Credentials, workoutId: string) {
  const result = await createHevyClient(credentials.hevy.apiKey).getWorkout(workoutId);
  if (!result.ok) return result;
  const w = result.value;
  const end = w.end_time ? new Date(w.end_time) : null;
  // Hevy always sets start_time on logged workouts; the schema is lenient.
  const start = w.start_time
    ? new Date(w.start_time)
    : (end ?? new Date(w.created_at ?? Date.now()));
  const event: McpEvent = {
    eventId: `hevy_${w.id}`,
    name: WORKOUT_COMPLETED,
    timestamp: (end ?? start).toISOString(),
    data: {
      source: "hevy",
      workout_id: w.id,
      title: w.title,
      sport: "Strength",
      start_time: start.toISOString(),
      duration_seconds: end ? Math.round((end.getTime() - start.getTime()) / 1000) : null,
      url: `https://hevy.com/workout/${encodeURIComponent(w.id)}`,
      summary: renderWorkout(w, getConfig().display),
    },
    cursor: null,
  };
  return { ok: true as const, value: event };
}

export function intervalsEvent(a: Activity): McpEvent {
  const start = a.start_date ? new Date(a.start_date) : null;
  const elapsed = a.elapsed_time ?? a.moving_time ?? null;
  const end = start && elapsed ? new Date(start.getTime() + elapsed * 1000) : null;
  return {
    eventId: `intervals_${a.id}`,
    name: WORKOUT_COMPLETED,
    timestamp: (end ?? start ?? new Date(a.analyzed ?? a.created ?? Date.now())).toISOString(),
    data: {
      source: "intervals",
      workout_id: a.id,
      title: a.name ?? a.type ?? "Activity",
      sport: a.type ?? "Unknown",
      start_time: (start ?? new Date(a.created ?? Date.now())).toISOString(),
      duration_seconds: elapsed,
      url: activityUrl(a.id),
      summary: renderActivity(a, getConfig().display, true),
    },
    cursor: null,
  };
}

// ---- Ingest ----

export type IngestResult =
  | { ok: true; queued: string[] }
  // retry: the upstream should redeliver (answer it with a 5xx).
  | { ok: false; retry: boolean; reason: string };

// Any live subscription's sealed credentials will do: they all belong to the
// same account.
async function credentialsFrom(subs: SubscriptionRecord[]): Promise<Credentials | null> {
  for (const sub of subs) {
    // oxlint-disable-next-line no-await-in-loop -- stop at the first that opens
    const credentials = await openCredentials(sub.sealedCredentials);
    if (credentials) return credentials;
  }
  return null;
}

function allowed(sub: SubscriptionRecord): boolean {
  const { allowlist } = getConfig();
  return (
    allowlist.hevyUserIds.includes(sub.hevyUserId) &&
    allowlist.intervalsAthleteIds.includes(sub.intervalsAthleteId)
  );
}

// Subscriptions whose account left the allowlist, or whose upstream key was
// rejected, are deleted rather than skipped forever.
async function liveSubscriptions(
  index: { kind: "hevy"; hevyUserId: string } | { kind: "intervals"; athleteId: string },
  source: "hevy" | "intervals",
): Promise<SubscriptionRecord[]> {
  const { store } = getDeps();
  const subs = await store.listSubscriptions(index);
  const revoked = subs.filter((s) => !allowed(s));
  await Promise.all(revoked.map((s) => store.deleteSubscription(s)));
  return subs.filter(
    (s) => allowed(s) && (!s.arguments.sources || s.arguments.sources.includes(source)),
  );
}

async function revokeAll(subs: SubscriptionRecord[]) {
  const { store } = getDeps();
  await Promise.all(subs.map((s) => store.deleteSubscription(s)));
}

export async function ingestHevyWorkout(
  hevyUserId: string,
  workoutId: string,
): Promise<IngestResult> {
  const subs = await liveSubscriptions({ kind: "hevy", hevyUserId }, "hevy");
  if (subs.length === 0) return { ok: true, queued: [] };
  const credentials = await credentialsFrom(subs);
  if (!credentials) return { ok: false, retry: false, reason: "no usable credentials" };

  const built = await hevyEvent(credentials, workoutId);
  if (!built.ok) {
    if (built.code === "unauthorized") {
      await revokeAll(subs);
      return { ok: false, retry: false, reason: "Hevy rejected the stored API key" };
    }
    if (built.code === "not_found") return { ok: true, queued: [] };
    return { ok: false, retry: true, reason: `Hevy fetch failed (${built.code})` };
  }
  return { ok: true, queued: await emit(built.value, subs) };
}

export async function ingestIntervalsActivity(
  athleteId: string,
  activityId: string,
): Promise<IngestResult> {
  const subs = await liveSubscriptions({ kind: "intervals", athleteId }, "intervals");
  if (subs.length === 0) return { ok: true, queued: [] };
  const credentials = await credentialsFrom(subs);
  if (!credentials) return { ok: false, retry: false, reason: "no usable credentials" };

  const result = await createIntervalsClient(credentials.intervals).getActivity(activityId);
  if (!result.ok) {
    if (result.code === "unauthorized") {
      await revokeAll(subs);
      return { ok: false, retry: false, reason: "Intervals rejected the stored credential" };
    }
    if (result.code === "not_found") return { ok: true, queued: [] };
    return { ok: false, retry: true, reason: `Intervals fetch failed (${result.code})` };
  }
  return { ok: true, queued: await emit(intervalsEvent(result.value), subs) };
}

// ---- Intervals polling ----

const DAY_MS = 24 * 60 * 60 * 1000;
// An activity counts once Intervals has analyzed it, or after this long
// regardless, so one that never gets analyzed still arrives.
const ANALYSIS_GRACE_MS = 10 * 60 * 1000;

function shouldPoll(credentials: Credentials): boolean {
  return credentials.intervals.kind === "api_key" || getConfig().intervalsWebhookSecret === null;
}

// Find activities that appeared since the last poll for every athlete with a
// polling-mode subscription. Returns the outbox members queued.
export async function pollIntervals(): Promise<string[]> {
  const { store } = getDeps();
  const all = await store.listSubscriptions({ kind: "all" });
  const athletes = [...new Set(all.map((s) => s.intervalsAthleteId))];
  return (await Promise.all(athletes.map(pollAthlete))).flat();
}

async function pollAthlete(athleteId: string): Promise<string[]> {
  const { store, now } = getDeps();
  const subs = await liveSubscriptions({ kind: "intervals", athleteId }, "intervals");
  if (subs.length === 0) return [];
  const credentials = await credentialsFrom(subs);
  if (!credentials || !shouldPoll(credentials)) return [];

  const client = createIntervalsClient(credentials.intervals);
  const listed = await client.listActivities(isoDate(now() - 7 * DAY_MS), isoDate(now() + DAY_MS));
  if (!listed.ok) {
    if (listed.code === "unauthorized") await revokeAll(subs);
    return [];
  }

  const ready = listed.value.filter(
    (a) => a.analyzed || (a.created && Date.parse(a.created) < now() - ANALYSIS_GRACE_MS),
  );
  // First poll for this athlete: everything created before the oldest
  // subscription is history, not news.
  const firstSubscribed = Math.min(...subs.map((s) => s.createdAt));
  const known = new Set(
    (await store.getKnownActivities(athleteId)) ??
      ready.filter((a) => a.created && Date.parse(a.created) < firstSubscribed).map((a) => a.id),
  );

  const fresh = ready.filter((a) => !known.has(a.id));
  const queued = await Promise.all(
    fresh.map(async (activity) => {
      // The list omits per-interval detail; fall back to the list row.
      const full = await client.getActivity(activity.id);
      return emit(intervalsEvent(full.ok ? full.value : activity), subs);
    }),
  );
  for (const activity of fresh) known.add(activity.id);
  // Only ids still inside the window can come back, so drop the rest.
  await store.setKnownActivities(
    athleteId,
    listed.value.map((a) => a.id).filter((id) => known.has(id)),
  );
  return queued.flat();
}

function isoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}
