// Turning upstream signals (a Hevy webhook, an Intervals webhook, a poll) into
// workout.completed events for the matching subscriptions.

import { createHmac, timingSafeEqual } from "node:crypto";
import { createHevyClient } from "@/app/hevy/_internal/client";
import { renderWorkout } from "@/app/hevy/_internal/render";
import { getConfig } from "./config";
import { isAllowed, type Credentials, type Principal } from "./credentials";
import { getDeps } from "./deps";
import { emit } from "./events/dispatch";
import { WORKOUT_COMPLETED, type McpEvent } from "./events/schema";
import { openCredentials, type SubscriptionRecord } from "./events/store";
import {
  activityUrl,
  createIntervalsClient,
  type Activity,
  type IntervalsClient,
  type Streams,
} from "./intervals";
import { renderActivity } from "./render-activity";

// ---- Hevy webhook registration ----

const HEVY_WEBHOOK_PATH = "/webhooks/hevy";

// The URL carries a fingerprint of the signing key, so a webhook whose URL
// matches was registered with the current token. Hevy may mask the token on
// reads, so the URL is the only thing worth comparing; after a key rotation
// the URL differs and the webhook is replaced.
export function hevyWebhookUrl(hevyUserId: string): string {
  const url = new URL(`${getConfig().oauth.baseUrl}${HEVY_WEBHOOK_PATH}`);
  url.searchParams.set("user", hevyUserId);
  url.searchParams.set(
    "k",
    createHmac("sha256", getConfig().oauth.signingKey)
      .update("hevy-webhook-url")
      .digest("base64url")
      .slice(0, 12),
  );
  return url.toString();
}

function isOurs(url: string): boolean {
  return url.startsWith(`${getConfig().oauth.baseUrl}${HEVY_WEBHOOK_PATH}`);
}

// Hevy's payload names only the workout, so the URL names the user and this
// token proves the URL came from us. Derived, never stored.
export function hevyWebhookToken(hevyUserId: string): string {
  const mac = createHmac("sha256", getConfig().oauth.signingKey)
    .update(`hevy-webhook:${hevyUserId}`)
    .digest("base64url");
  return `Bearer ${mac}`;
}

// Hevy documents sending authToken verbatim as the Authorization header; also
// accept it with a second "Bearer " in case Hevy adds its own prefix.
export function checkHevyWebhookAuth(hevyUserId: string, header: string | null): boolean {
  if (!header) return false;
  const token = hevyWebhookToken(hevyUserId);
  return [token, `Bearer ${token}`].some((expected) => {
    const a = Buffer.from(expected);
    const b = Buffer.from(header);
    return a.length === b.length && timingSafeEqual(a, b);
  });
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
    if (current.value.url === url) return { ok: true };
    if (!isOurs(current.value.url)) {
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

  // One retry: after a delete, a failed create would leave no webhook at all.
  let created = await client.createWebhookSubscription({ url, authToken });
  if (!created.ok) created = await client.createWebhookSubscription({ url, authToken });
  return created.ok
    ? { ok: true }
    : {
        ok: false,
        reason: `Could not register the Hevy webhook (${created.code}); no Hevy webhook is set now.`,
      };
}

// Give the account's only webhook slot back once nothing here needs it. Leaves
// a webhook that belongs to another service alone. Best effort: a failure
// only means the next subscribe finds it still in place.
export async function releaseHevyWebhook(principal: Principal): Promise<void> {
  const client = createHevyClient(principal.credentials.hevy.apiKey);
  const current = await client.getWebhookSubscription();
  if (current.ok && isOurs(current.value.url)) await client.deleteWebhookSubscription();
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
  // When the workout reached Hevy, which decides which subscriptions it is
  // news to.
  const createdAt = Date.parse(w.created_at ?? "") || (end ?? start).getTime();
  return { ok: true as const, value: { event, createdAt } };
}

// When the activity reached Intervals, which decides which subscriptions it
// is news to.
export function activityCreatedAt(a: Activity, fallback: number): number {
  return Date.parse(a.created ?? a.analyzed ?? "") || fallback;
}

export function intervalsEvent(a: Activity, streams: Streams | null): McpEvent {
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
      summary: renderActivity(a, getConfig().display, streams),
    },
    cursor: null,
  };
}

// ---- Ingest ----

export interface IngestResult {
  queued: string[];
  // The upstream should redeliver (answer it with a 5xx). Accounts that did
  // succeed are claimed, so a redelivery only redoes the rest.
  retry: boolean;
}

// Run `fn` once per account among the subscriptions, with that account's
// current credentials. Subscriptions whose account left the allowlist, or
// whose upstream key is rejected, are deleted.
async function perAccount(
  subs: SubscriptionRecord[],
  fn: (
    credentials: Credentials,
    subs: SubscriptionRecord[],
    principalId: string,
  ) => Promise<{ queued: string[]; retry: boolean; revoke?: boolean }>,
): Promise<IngestResult> {
  const { store } = getDeps();
  const revoked = subs.filter((s) => !isAllowed(s));
  await Promise.all(revoked.map((s) => store.deleteSubscription(s)));

  const accounts = new Map<string, SubscriptionRecord[]>();
  for (const sub of subs.filter((s) => isAllowed(s))) {
    accounts.set(sub.principalId, [...(accounts.get(sub.principalId) ?? []), sub]);
  }
  const results = await Promise.allSettled(
    [...accounts].map(async ([principalId, group]) => {
      const sealed = await store.getCredentials(principalId);
      const credentials = await openCredentials(sealed);
      // Unreadable credentials (expired, or JWT_SIGNING_KEY rotated) cannot
      // recover; the client's next refresh writes fresh ones.
      if (!sealed || !credentials) return { queued: [], retry: false };
      const result = await fn(credentials, group, principalId);
      // Only if these are still the stored credentials: a reconnect may have
      // replaced them while the upstream call was in flight.
      if (result.revoke) await store.revokeAccount(principalId, sealed);
      return result;
    }),
  );
  return {
    queued: results.flatMap((r) => (r.status === "fulfilled" ? r.value.queued : [])),
    retry: results.some((r) => r.status === "rejected" || r.value.retry),
  };
}

function wantsSource(source: "hevy" | "intervals") {
  return (s: SubscriptionRecord) => !s.arguments.sources || s.arguments.sources.includes(source);
}

export async function ingestHevyWorkout(
  hevyUserId: string,
  workoutId: string,
): Promise<IngestResult> {
  const { store } = getDeps();
  const subs = (await store.listSubscriptions({ kind: "hevy", hevyUserId })).filter(
    wantsSource("hevy"),
  );
  return perAccount(subs, async (credentials, group) => {
    const built = await hevyEvent(credentials, workoutId);
    if (built.ok) {
      return { queued: await emit(built.value.event, built.value.createdAt, group), retry: false };
    }
    // not_found can mean the webhook beat the workout to Hevy's read path.
    return {
      queued: [],
      retry: built.code !== "unauthorized",
      revoke: built.code === "unauthorized",
    };
  });
}

export async function ingestIntervalsActivity(
  athleteId: string,
  activityId: string,
): Promise<IngestResult> {
  const { store, now } = getDeps();
  const subs = (await store.listSubscriptions({ kind: "intervals", athleteId })).filter(
    wantsSource("intervals"),
  );
  return perAccount(subs, async (credentials, group) => {
    const result = await fetchActivity(createIntervalsClient(credentials.intervals), activityId);
    if (result.ok) {
      const { activity, streams } = result.value;
      return {
        queued: await emit(
          intervalsEvent(activity, streams),
          activityCreatedAt(activity, now()),
          group,
        ),
        retry: false,
      };
    }
    // A deleted activity has nothing to send.
    if (result.code === "not_found") return { queued: [], retry: false };
    return {
      queued: [],
      retry: result.code !== "unauthorized",
      revoke: result.code === "unauthorized",
    };
  });
}

// The activity with interval detail, plus its streams for splits. Splits are
// a nice-to-have, so a streams failure only drops them.
export async function fetchActivity(client: IntervalsClient, activityId: string) {
  const [activity, streams] = await Promise.all([
    client.getActivity(activityId),
    client.getStreams(activityId),
  ]);
  if (!activity.ok) return activity;
  return {
    ok: true as const,
    value: { activity: activity.value, streams: streams.ok ? streams.value : null },
  };
}

// ---- Intervals polling ----

const DAY_MS = 24 * 60 * 60 * 1000;
// An activity counts once Intervals has analyzed it, or after this long
// regardless, so one that never gets analyzed still arrives.
const ANALYSIS_GRACE_MS = 10 * 60 * 1000;

// Look for new activities for every athlete with an Intervals subscription.
// Runs even when Intervals webhooks are on, as a backstop for missed or
// never-sent webhooks; claims keep the two paths from double-delivering.
export async function pollIntervals(): Promise<string[]> {
  const { store } = getDeps();
  const all = await store.listSubscriptions({ kind: "all" });
  const athletes = [...new Set(all.map((s) => s.intervalsAthleteId))];
  const results = await Promise.all(athletes.map(pollAthlete));
  return results.flatMap((r) => r.queued);
}

async function pollAthlete(athleteId: string): Promise<IngestResult> {
  const { store, now } = getDeps();
  const subs = (await store.listSubscriptions({ kind: "intervals", athleteId })).filter(
    wantsSource("intervals"),
  );
  return perAccount(subs, async (credentials, group, principalId) => {
    const client = createIntervalsClient(credentials.intervals);
    const listed = await client.listActivities(
      isoDate(now() - 7 * DAY_MS),
      isoDate(now() + DAY_MS),
    );
    if (!listed.ok) {
      return { queued: [], retry: false, revoke: listed.code === "unauthorized" };
    }
    const polledIds = group.map((s) => s.id);
    const handled = await store.getHandledActivities(principalId, polledIds);
    const oldestSubscription = Math.min(...group.map((s) => s.createdAt));
    const ready = listed.value.filter(
      (a) => a.analyzed || activityCreatedAt(a, now()) < now() - ANALYSIS_GRACE_MS,
    );
    // Only activities newer than some subscription can be news; skip fetching
    // details for the rest.
    const fresh = ready.filter(
      (a) => !handled.has(a.id) && activityCreatedAt(a, now()) >= oldestSubscription,
    );
    const queued = await Promise.all(
      fresh.map(async (activity) => {
        // The list omits intervals and streams; fall back to the list row.
        const full = await fetchActivity(client, activity.id);
        const event = full.ok
          ? intervalsEvent(full.value.activity, full.value.streams)
          : intervalsEvent(activity, null);
        return emit(event, activityCreatedAt(activity, now()), group);
      }),
    );
    for (const activity of ready) handled.add(activity.id);
    // Only ids still inside the window can come back, so drop the rest.
    await store.setHandledActivities(
      principalId,
      polledIds,
      listed.value.map((a) => a.id).filter((id) => handled.has(id)),
    );
    return { queued: queued.flat(), retry: false };
  });
}

function isoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}
