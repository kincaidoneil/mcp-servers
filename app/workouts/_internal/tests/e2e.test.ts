// The whole path a ChatGPT subscription takes, through the real route
// handlers: OAuth connect, MCP 2.0 discovery, events/subscribe with callback
// verification, upstream signals, signed delivery, retries, and teardown.
// Hevy and Intervals are mocked at the HTTP layer; the ChatGPT receiver is an
// in-process function that checks every signature.

import { randomBytes } from "node:crypto";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { Webhook } from "standardwebhooks";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { validateAuthorize } from "@/lib/oauth-as";
import { resetConfigCacheForTesting } from "../config";
import { setDepsForTesting } from "../deps";
import { deliverAll } from "../events/dispatch";
import { WorkoutCompletedSchema, type McpEvent } from "../events/schema";
import { createStore, openCredentials } from "../events/store";
import { memoryKv, type Kv } from "../kv";
import { receiveHevyWebhook, receiveIntervalsWebhook } from "../receivers";
import { hevyWebhookToken, hevyWebhookUrl } from "../sources";
import {
  checkCallbackUrl,
  checkSigningSecret,
  createSafeCallbackFetch,
  isPublicAddress,
  type CallbackFetch,
} from "../events/callback";
import { canonicalJson } from "../events/subscriptions";

const BASE = "https://mcp.example.com";
const HEVY_USER = "hevy-user-1";
const ATHLETE = "i651018";
const HEVY_KEY = "11111111-2222-3333-4444-555555555555";
const INTERVALS_KEY = "intervals-key";
const CLIENT_REDIRECT = "https://chatgpt.com/connector/oauth/callback";
const RECEIVER = "https://receiver.example.com/mcp-events/cb_1";
const secret = () => `whsec_${randomBytes(32).toString("base64")}`;

// ---- Upstream fakes ----

let hevyWebhook: { url: string; auth_token: string } | null = null;
let hevyWebhookDeletes = 0;
let activities: Record<string, unknown>[] = [];

function activity(id: string, created: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    name: "New York Running",
    type: "Run",
    start_date: created,
    start_date_local: created.replace("Z", ""),
    created,
    analyzed: created,
    distance: 9154.81,
    moving_time: 2636,
    elapsed_time: 2694,
    average_heartrate: 163,
    max_heartrate: 178,
    icu_training_load: 44,
    icu_intensity: 76.7,
    average_speed: 3.468,
    interval_summary: ["1x 44m55s 162bpm"],
    ...extra,
  };
}

const upstream = setupServer(
  http.get("https://api.hevyapp.com/v1/user/info", ({ request }) =>
    request.headers.get("api-key") === HEVY_KEY
      ? HttpResponse.json({ data: { id: HEVY_USER, name: "Kincaid" } })
      : new HttpResponse(null, { status: 401 }),
  ),
  http.get("https://api.hevyapp.com/v1/webhook-subscription", () =>
    hevyWebhook ? HttpResponse.json(hevyWebhook) : new HttpResponse(null, { status: 404 }),
  ),
  http.post("https://api.hevyapp.com/v1/webhook-subscription", async ({ request }) => {
    const body = (await request.json()) as { url: string; authToken: string };
    hevyWebhook = { url: body.url, auth_token: body.authToken };
    return new HttpResponse(null, { status: 201 });
  }),
  http.delete("https://api.hevyapp.com/v1/webhook-subscription", () => {
    hevyWebhook = null;
    hevyWebhookDeletes += 1;
    return new HttpResponse(null, { status: 200 });
  }),
  http.get("https://api.hevyapp.com/v1/workouts/:id", ({ params }) =>
    HttpResponse.json({
      id: params["id"],
      title: "Upper Body",
      description: null,
      start_time: "2026-10-07T12:00:00Z",
      end_time: "2026-10-07T13:05:00Z",
      // Hevy fires its webhook as the workout is saved.
      created_at: new Date(clock).toISOString(),
      updated_at: "2026-10-07T13:05:05Z",
      exercises: [
        {
          index: 0,
          title: "Bench Press (Barbell)",
          notes: null,
          exercise_template_id: "05293BCA",
          supersets_id: null,
          sets: [{ index: 0, type: "normal", weight_kg: 100, reps: 5, rpe: 8 }],
        },
      ],
    }),
  ),
  http.get("https://intervals.icu/api/v1/athlete/0", ({ request }) =>
    request.headers.get("authorization") ===
    `Basic ${Buffer.from(`API_KEY:${INTERVALS_KEY}`).toString("base64")}`
      ? HttpResponse.json({ id: ATHLETE, name: "Kincaid" })
      : new HttpResponse(null, { status: 401 }),
  ),
  http.get("https://intervals.icu/api/v1/athlete/0/activities", () =>
    HttpResponse.json(activities),
  ),
  // Two miles at a steady 8:00/mi, HR climbing from 140 to 160.
  http.get("https://intervals.icu/api/v1/activity/:id/streams", () => {
    const seconds = 960;
    const time = Array.from({ length: seconds + 1 }, (_, i) => i);
    return HttpResponse.json([
      { type: "time", data: time },
      { type: "distance", data: time.map((t) => (t * 2 * 1609.344) / seconds) },
      { type: "heartrate", data: time.map((t) => 140 + Math.round((20 * t) / seconds)) },
      { type: "cadence", data: time.map(() => 85) },
      { type: "fixed_altitude", data: time.map((t) => (t < 480 ? t / 48 : 10)) },
    ]);
  }),
  http.get("https://intervals.icu/api/v1/activity/:id", ({ params }) => {
    const found = activities.find((a) => a["id"] === params["id"]);
    return found
      ? HttpResponse.json({
          ...found,
          icu_intervals: [
            {
              type: "WORK",
              start_time: 0,
              elapsed_time: 1200,
              distance: 4000,
              average_speed: 3.33,
              gap: 3.4,
              average_gradient: 0.01,
              average_heartrate: 150,
              max_heartrate: 160,
              average_cadence: 84,
              zone: 2,
            },
            {
              type: "WORK",
              start_time: 1200,
              elapsed_time: 300,
              distance: 1200,
              average_speed: 4,
              gap: 4.2,
              average_gradient: 0.03,
              average_heartrate: 178,
              max_heartrate: 186,
              average_cadence: 88,
              zone: 4,
            },
          ],
        })
      : new HttpResponse(null, { status: 404 });
  }),
);

// ---- ChatGPT receiver fake ----

interface Received {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
  raw: string;
}
let received: Received[] = [];
let receiverStatus = 200;
// Secrets the receiver trusts per URL; every delivery must verify against all.
const receiverSecrets = new Map<string, string[]>();

const callbackFetch: CallbackFetch = async (url, init) => {
  // Like a real Standard Webhooks receiver: accept when any signature checks
  // out against a secret it holds.
  const trusted = receiverSecrets.get(url) ?? [];
  const valid = trusted.some((s) => {
    try {
      new Webhook(s).verify(init.body, init.headers);
      return true;
    } catch {
      return false;
    }
  });
  if (trusted.length > 0 && !valid) return { status: 401, text: async () => "" };
  const body = JSON.parse(init.body) as Record<string, unknown>;
  received.push({ url, headers: init.headers, body, raw: init.body });
  if (body["type"] === "verification") {
    return { status: 200, text: async () => JSON.stringify({ challenge: body["challenge"] }) };
  }
  return { status: receiverStatus, text: async () => "" };
};

const events = () => received.filter((r) => r.body["type"] !== "verification");

// ---- Clock and wiring ----

let clock = Date.parse("2026-10-07T14:00:00Z");
let store: ReturnType<typeof createStore>;
const now = () => clock;

beforeAll(() => upstream.listen({ onUnhandledRequest: "error" }));
afterAll(() => upstream.close());
afterEach(() => upstream.resetHandlers());

beforeEach(() => {
  process.env["PUBLIC_BASE_URL"] = BASE;
  process.env["JWT_SIGNING_KEY"] = randomBytes(32).toString("base64");
  process.env["ALLOWED_WORKOUT_ACCOUNTS"] = `${HEVY_USER}:651018`;
  process.env["WORKOUTS_TICK_SECRET"] = "tick-secret";
  delete process.env["INTERVALS_OAUTH_CLIENT_ID"];
  delete process.env["INTERVALS_WEBHOOK_SECRET"];
  resetConfigCacheForTesting();
  store = createStore(memoryKv(now), now);
  setDepsForTesting({ store, callbackFetch, now });
  hevyWebhook = null;
  hevyWebhookDeletes = 0;
  activities = [activity("i100", "2026-10-06T03:10:47Z")];
  received = [];
  receiverStatus = 200;
  receiverSecrets.clear();
});

// ---- Helpers ----

async function connect(): Promise<string> {
  const { POST: register } = await import("../../oauth/register/route");
  const reg = await register(
    new Request(`${BASE}/workouts/oauth/register`, {
      method: "POST",
      body: JSON.stringify({ client_name: "ChatGPT", redirect_uris: [CLIENT_REDIRECT] }),
    }),
  );
  const { client_id } = (await reg.json()) as { client_id: string };

  const verifier = randomBytes(32).toString("base64url");
  const challenge = (await import("node:crypto"))
    .createHash("sha256")
    .update(verifier)
    .digest("base64url");
  const { getConfig } = await import("../config");
  const authorized = await validateAuthorize(
    {
      client_id,
      redirect_uri: CLIENT_REDIRECT,
      response_type: "code",
      code_challenge: challenge,
      code_challenge_method: "S256",
      state: "xyz",
      scope: null,
    },
    getConfig().oauth,
  );
  if (!authorized.ok) throw new Error("authorize failed");

  const { POST: submit } = await import("../../oauth/submit/route");
  const form = new FormData();
  form.set("as_state", authorized.asState);
  form.set("hevy_api_key", HEVY_KEY);
  form.set("intervals_api_key", INTERVALS_KEY);
  const consent = await submit(
    new Request(`${BASE}/workouts/oauth/submit`, {
      method: "POST",
      body: form,
      headers: { origin: BASE },
    }),
  );
  expect(consent.status).toBe(303);
  const code = new URL(consent.headers.get("location")!).searchParams.get("code")!;

  const { POST: token } = await import("../../oauth/token/route");
  const tokenRes = await token(
    new Request(`${BASE}/workouts/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        code_verifier: verifier,
        redirect_uri: CLIENT_REDIRECT,
      }),
    }),
  );
  const { access_token } = (await tokenRes.json()) as { access_token: string };
  return access_token;
}

interface RpcBody {
  result?: Record<string, unknown> & {
    id?: string;
    refreshBefore?: string;
    events?: { name: string; payloadSchema: { required: string[] } }[];
    tools?: { name: string }[];
    content?: { text: string }[];
  };
  error?: { code: number; message: string; data?: unknown };
}

async function rpc(token: string | null, method: string, params: Record<string, unknown> = {}) {
  const { POST } = await import("../../route");
  const res = await POST(
    new Request(`${BASE}/workouts`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2026-07-28",
        "mcp-method": method,
        ...(method === "tools/call" ? { "mcp-name": String(params["name"]) } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method,
        params: {
          ...params,
          _meta: {
            "io.modelcontextprotocol/protocolVersion": "2026-07-28",
            "io.modelcontextprotocol/clientCapabilities": {},
            "io.modelcontextprotocol/clientInfo": { name: "chatgpt", version: "1" },
          },
        },
      }),
    }),
  );
  return {
    status: res.status,
    headers: res.headers,
    json: (await res.json().catch(() => ({}))) as RpcBody,
  };
}

function subscribeParams(url: string, signing: string, args: Record<string, unknown> = {}) {
  return {
    name: "workout.completed",
    arguments: args,
    delivery: { mode: "webhook", url, secret: signing },
    cursor: null,
  };
}

async function hevyWebhookCall(workoutId: string, auth = hevyWebhookToken(HEVY_USER)) {
  const result = await receiveHevyWebhook(
    new Request(hevyWebhookUrl(HEVY_USER), {
      method: "POST",
      headers: { authorization: auth, "content-type": "application/json" },
      body: JSON.stringify({ id: "00000000-0000-0000-0000-000000000001", payload: { workoutId } }),
    }),
  );
  await deliverAll(result.followUp);
  return result.response.status;
}

async function tick(secretValue = "tick-secret") {
  const { GET } = await import("../../tick/route");
  const res = await GET(
    new Request(`${BASE}/workouts/tick`, { headers: { authorization: `Bearer ${secretValue}` } }),
  );
  return { status: res.status, json: (await res.json()) as Record<string, number> };
}

// Intervals sends UPLOADED, then ANALYZED a minute later.
function analyzed(id: string) {
  return {
    secret: "hook-secret",
    events: [
      { athlete_id: "651018", type: "ACTIVITY_UPLOADED", activity: { id } },
      { athlete_id: "651018", type: "ACTIVITY_ANALYZED", activity: { id } },
    ],
  };
}

// ---- The test ----

describe("/workouts MCP events, end to end", () => {
  it("connects, subscribes, delivers from both sources, retries, and tears down", async () => {
    const token = await connect();

    // Unauthenticated requests get a discoverable 401.
    const anon = await rpc(null, "server/discover");
    expect(anon.status).toBe(401);
    expect(anon.headers.get("www-authenticate")).toContain(
      `${BASE}/workouts/.well-known/oauth-protected-resource`,
    );

    // MCP 2.0 discovery advertises events next to tools.
    const discover = await rpc(token, "server/discover");
    expect(discover.json.result?.supportedVersions).toContain("2026-07-28");
    expect(discover.json.result?.capabilities).toMatchObject({ tools: {}, events: {} });

    const list = await rpc(token, "events/list");
    const [definition] = list.json.result?.events ?? [];
    expect(definition).toMatchObject({ name: "workout.completed", delivery: ["webhook"] });
    expect(definition?.payloadSchema.required).toEqual(
      expect.arrayContaining(["source", "workout_id", "summary"]),
    );

    const tools = await rpc(token, "tools/list");
    expect((tools.json.result?.tools ?? []).map((t) => t.name).toSorted()).toEqual([
      "get-hevy-workout",
      "get-intervals-activity",
      "list-recent-workouts",
    ]);

    // Subscribe: verification handshake first, Hevy webhook registered.
    const signing = secret();
    receiverSecrets.set(RECEIVER, [signing]);
    const sub = await rpc(token, "events/subscribe", subscribeParams(RECEIVER, signing));
    expect(sub.json.result).toMatchObject({ cursor: null, truncated: false });
    const subId = sub.json.result?.id ?? "";
    expect(subId).toMatch(/^sub_/);
    expect(Date.parse(sub.json.result?.refreshBefore ?? "")).toBe(clock + 7 * 24 * 3600 * 1000);
    expect(received).toHaveLength(1);
    expect(received[0]!.body["type"]).toBe("verification");
    expect(received[0]!.headers["x-mcp-subscription-id"]).toBe(subId);
    expect(hevyWebhook).toEqual({
      url: hevyWebhookUrl(HEVY_USER),
      auth_token: hevyWebhookToken(HEVY_USER),
    });
    expect(hevyWebhookUrl(HEVY_USER)).toMatch(
      new RegExp(`^${BASE}/workouts/webhooks/hevy\\?user=${HEVY_USER}&k=[\\w-]{12}$`),
    );

    // Re-subscribing with reordered keys is the same subscription, and the
    // verified callback is not challenged again.
    const again = await rpc(token, "events/subscribe", {
      cursor: null,
      delivery: { secret: signing, url: RECEIVER, mode: "webhook" },
      arguments: {},
      name: "workout.completed",
      ttlMs: 60_000,
    });
    expect(again.json.result?.id).toBe(subId);
    // ttlMs below the minimum is raised to one hour.
    expect(Date.parse(again.json.result?.refreshBefore ?? "")).toBe(clock + 3600 * 1000);
    expect(received).toHaveLength(1);

    // A second, filtered subscription that only wants Intervals.
    const RUNS = "https://receiver.example.com/mcp-events/cb_runs";
    const runsSecret = secret();
    receiverSecrets.set(RUNS, [runsSecret]);
    const runsSub = await rpc(
      token,
      "events/subscribe",
      subscribeParams(RUNS, runsSecret, { sources: ["intervals"] }),
    );
    expect(runsSub.json.result?.id).not.toBe(subId);

    // Hevy webhook: bad token refused; good token delivers one signed event.
    expect(await hevyWebhookCall("b1085cdb-32b2-4003-967d-53a3af8eaecb", "Bearer nope")).toBe(401);
    received = [];
    expect(await hevyWebhookCall("b1085cdb-32b2-4003-967d-53a3af8eaecb")).toBe(200);
    expect(events()).toHaveLength(1);
    const hevyDelivery = events()[0]!;
    expect(hevyDelivery.url).toBe(RECEIVER);
    const hevyEvent = hevyDelivery.body as unknown as McpEvent;
    expect(hevyDelivery.headers["webhook-id"]).toBe(hevyEvent.eventId);
    expect(hevyDelivery.headers["x-mcp-subscription-id"]).toBe(subId);
    expect(hevyEvent).toMatchObject({
      eventId: "hevy_b1085cdb-32b2-4003-967d-53a3af8eaecb",
      name: "workout.completed",
      timestamp: "2026-10-07T13:05:00.000Z",
      cursor: null,
    });
    expect(WorkoutCompletedSchema.parse(hevyEvent.data)).toMatchObject({
      source: "hevy",
      sport: "Strength",
      duration_seconds: 3900,
    });
    expect(hevyEvent.data.summary).toContain("Bench Press");

    // Hevy retries the same webhook: nothing new is sent.
    expect(await hevyWebhookCall("b1085cdb-32b2-4003-967d-53a3af8eaecb")).toBe(200);
    expect(events()).toHaveLength(1);

    // Intervals polling: the first tick treats existing activities as history.
    expect((await tick("wrong")).status).toBe(401);
    received = [];
    expect((await tick()).json).toMatchObject({ queuedFromPolling: 0 });
    expect(events()).toHaveLength(0);

    // A new activity arrives, and the receiver is down for the first attempt.
    clock += 20 * 60 * 1000;
    activities.push(activity("i200", new Date(clock - 60_000).toISOString()));
    receiverStatus = 503;
    const failed = await tick();
    expect(failed.json).toMatchObject({ queuedFromPolling: 2, retrying: 2 });
    receiverStatus = 200;
    received = [];
    // Not due yet: the next attempt waits a minute.
    expect((await tick()).json).toMatchObject({ delivered: 0 });
    clock += 61_000;
    expect((await tick()).json).toMatchObject({ delivered: 2 });
    expect(
      events()
        .map((e) => e.url)
        .toSorted(),
    ).toEqual([RECEIVER, RUNS].toSorted());
    const runEvent = events()[0]!.body as unknown as McpEvent;
    expect(runEvent.eventId).toBe("intervals_i200");
    expect(WorkoutCompletedSchema.parse(runEvent.data)).toMatchObject({
      source: "intervals",
      sport: "Run",
      url: "https://intervals.icu/activities/i200",
    });
    expect(runEvent.data.summary).toContain("Intervals (detected by Intervals.icu");
    expect(runEvent.data.summary).toMatch(/Splits per mi.*\n1 \| 8:00 \| 8:00 \| 145 \| 170 spm/);
    // Both attempts carried the same event id.
    expect(events().every((e) => e.headers["webhook-id"] === "intervals_i200")).toBe(true);

    // A rotation to a secret the receiver doesn't hold fails verification,
    // rather than being accepted on the strength of the old one.
    const unknown = secret();
    const refused = await rpc(token, "events/subscribe", subscribeParams(RECEIVER, unknown));
    expect(refused.json.error).toMatchObject({ code: -32015, data: { reason: "http_4xx" } });

    // Secret rotation on refresh: deliveries are signed with old and new keys.
    const rotated = secret();
    receiverSecrets.set(RECEIVER, [signing, rotated]);
    const rotation = await rpc(token, "events/subscribe", subscribeParams(RECEIVER, rotated));
    expect(rotation.json.result?.id).toBe(subId);
    received = [];
    expect(await hevyWebhookCall("c1085cdb-32b2-4003-967d-53a3af8eaecb")).toBe(200);
    expect(events()).toHaveLength(1);
    const rotating = events()[0]!;
    expect(rotating.headers["webhook-signature"]!.split(" ")).toHaveLength(2);
    // Each key alone verifies it, so a receiver on either key accepts.
    for (const key of [signing, rotated]) new Webhook(key).verify(rotating.raw, rotating.headers);
    // After the rotation window only the new key signs.
    clock += 11 * 60 * 1000;
    receiverSecrets.set(RECEIVER, [rotated]);
    received = [];
    expect(await hevyWebhookCall("d1085cdb-32b2-4003-967d-53a3af8eaecb")).toBe(200);
    expect(events()[0]!.headers["webhook-signature"]!.split(" ")).toHaveLength(1);

    // Unsubscribe (idempotent) stops delivery to that callback.
    expect(
      (
        await rpc(token, "events/unsubscribe", {
          name: "workout.completed",
          arguments: {},
          delivery: { mode: "webhook", url: RECEIVER },
        })
      ).json.result,
    ).toMatchObject({ resultType: "complete" });
    expect(
      (
        await rpc(token, "events/unsubscribe", {
          name: "workout.completed",
          arguments: {},
          delivery: { mode: "webhook", url: RECEIVER },
        })
      ).json.result,
    ).toMatchObject({ resultType: "complete" });
    // That was the last subscription wanting Hevy, so the account's one Hevy
    // webhook slot is released; the Intervals-only one keeps the credentials.
    expect(hevyWebhook).toBeNull();
    expect(await store.getCredentials(`${HEVY_USER}:i651018`)).not.toBeNull();
    received = [];
    clock += 20 * 60 * 1000;
    activities.push(activity("i300", new Date(clock - 60_000).toISOString()));
    await tick();
    expect(events().map((e) => e.url)).toEqual([RUNS]);

    // A 410 drops that one delivery without retrying it; the subscription
    // carries on.
    receiverStatus = 410;
    clock += 20 * 60 * 1000;
    activities.push(activity("i400", new Date(clock - 60_000).toISOString()));
    expect((await tick()).json).toMatchObject({ dropped: 1 });
    receiverStatus = 200;
    received = [];
    clock += 20 * 60 * 1000;
    activities.push(activity("i500", new Date(clock - 60_000).toISOString()));
    await tick();
    expect(events().map((e) => (e.body as unknown as McpEvent).eventId)).toEqual([
      "intervals_i500",
    ]);
  });

  it("rejects unsafe callbacks, bad secrets, failed verification, and a foreign Hevy webhook", async () => {
    const token = await connect();
    const signing = secret();

    const plainHttp = await rpc(
      token,
      "events/subscribe",
      subscribeParams("http://receiver.example.com/cb", signing),
    );
    expect(plainHttp.json.error?.code).toBe(-32602);
    const privateIp = await rpc(
      token,
      "events/subscribe",
      subscribeParams("https://10.0.0.8/cb", signing),
    );
    expect(privateIp.json.error?.code).toBe(-32602);
    const local = await rpc(
      token,
      "events/subscribe",
      subscribeParams("https://localhost/cb", signing),
    );
    expect(local.json.error?.code).toBe(-32602);
    const shortSecret = await rpc(
      token,
      "events/subscribe",
      subscribeParams(RECEIVER, `whsec_${randomBytes(8).toString("base64")}`),
    );
    expect(shortSecret.json.error?.code).toBe(-32602);
    const badArgs = await rpc(
      token,
      "events/subscribe",
      subscribeParams(RECEIVER, signing, { sources: ["strava"] }),
    );
    expect(badArgs.json.error?.code).toBe(-32602);

    // The receiver answers the challenge wrongly.
    setDepsForTesting({
      store: createStore(memoryKv(now), now),
      callbackFetch: async () => ({
        status: 200,
        text: async () => JSON.stringify({ challenge: "nope" }),
      }),
      now,
    });
    const failed = await rpc(token, "events/subscribe", subscribeParams(RECEIVER, signing));
    expect(failed.json.error).toMatchObject({ code: -32015, data: { reason: "challenge_failed" } });

    // Another service owns the Hevy webhook: refuse rather than take it.
    setDepsForTesting({ store: createStore(memoryKv(now), now), callbackFetch, now });
    hevyWebhook = { url: "https://other.example.com/hook", auth_token: "Bearer theirs" };
    const foreign = await rpc(token, "events/subscribe", subscribeParams(RECEIVER, signing));
    expect(foreign.json.error?.message).toContain("other.example.com");
    expect(hevyWebhook.url).toBe("https://other.example.com/hook");
    // An Intervals-only subscription does not need the Hevy webhook.
    const intervalsOnly = await rpc(
      token,
      "events/subscribe",
      subscribeParams(RECEIVER, signing, { sources: ["intervals"] }),
    );
    expect(intervalsOnly.json.result?.id).toMatch(/^sub_/);
  });

  it("does not replay workouts from a gap between subscriptions", async () => {
    const token = await connect();
    const signing = secret();
    receiverSecrets.set(RECEIVER, [signing]);
    const params = subscribeParams(RECEIVER, signing, { sources: ["intervals"] });
    await rpc(token, "events/subscribe", params);
    await tick();
    await rpc(token, "events/unsubscribe", {
      name: "workout.completed",
      arguments: { sources: ["intervals"] },
      delivery: { mode: "webhook", url: RECEIVER },
    });
    // A run lands while nobody is subscribed.
    clock += 60 * 60 * 1000;
    activities.push(activity("i700", new Date(clock).toISOString()));
    clock += 24 * 60 * 60 * 1000;
    await rpc(token, "events/subscribe", params);
    received = [];
    await tick();
    expect(events()).toHaveLength(0);
    // The next run after resubscribing does arrive.
    clock += 60 * 60 * 1000;
    activities.push(activity("i701", new Date(clock).toISOString()));
    await tick();
    expect(events().map((e) => (e.body as unknown as McpEvent).eventId)).toEqual([
      "intervals_i701",
    ]);
  });

  it("treats a refresh after expiry as a new subscription", async () => {
    const token = await connect();
    const signing = secret();
    receiverSecrets.set(RECEIVER, [signing]);
    const params = {
      ...subscribeParams(RECEIVER, signing, { sources: ["intervals"] }),
      ttlMs: 3600_000,
    };
    await rpc(token, "events/subscribe", params);
    await tick();
    // The subscription lapses; a run lands; the refresh comes late but within
    // the record's grace day.
    clock += 3600_000 + 60_000;
    activities.push(activity("i800", new Date(clock).toISOString()));
    clock += 60_000;
    await rpc(token, "events/subscribe", params);
    received = [];
    await tick();
    expect(events()).toHaveLength(0);
  });

  it("asks Hevy to redeliver when the workout is not readable yet", async () => {
    const token = await connect();
    const signing = secret();
    receiverSecrets.set(RECEIVER, [signing]);
    await rpc(token, "events/subscribe", subscribeParams(RECEIVER, signing));
    received = [];
    upstream.use(
      http.get(
        "https://api.hevyapp.com/v1/workouts/:id",
        () => new HttpResponse(null, { status: 404 }),
      ),
    );
    expect(await hevyWebhookCall("e1085cdb-32b2-4003-967d-53a3af8eaecb")).toBe(503);
    upstream.resetHandlers();
    expect(await hevyWebhookCall("e1085cdb-32b2-4003-967d-53a3af8eaecb")).toBe(200);
    expect(events()).toHaveLength(1);

    // A stalled read gives up inside Hevy's 5 s acknowledgement deadline.
    upstream.use(
      http.get("https://api.hevyapp.com/v1/workouts/:id", async () => {
        await new Promise((resolve) => setTimeout(resolve, 6_000));
        return new HttpResponse(null, { status: 500 });
      }),
    );
    const started = Date.now();
    expect(await hevyWebhookCall("e2085cdb-32b2-4003-967d-53a3af8eaecb")).toBe(503);
    expect(Date.now() - started).toBeLessThan(5_000);
  }, 10_000);

  it("caps subscriptions per account and reports verification failures by category", async () => {
    const token = await connect();
    // Twelve at once: the cap holds even when requests race.
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) => {
        const url = `https://receiver.example.com/cb_${i}`;
        const s = secret();
        receiverSecrets.set(url, [s]);
        return rpc(token, "events/subscribe", subscribeParams(url, s));
      }),
    );
    expect(results.filter((r) => r.json.result?.id).length).toBe(10);
    const refused = results.filter((r) => r.json.error);
    expect(refused).toHaveLength(2);
    expect(refused[0]!.json.error?.message).toContain("10 subscriptions");
    // The cap never blocks cleanup: unsubscribing something absent still succeeds.
    const absent = await rpc(token, "events/unsubscribe", {
      name: "workout.completed",
      arguments: {},
      delivery: { mode: "webhook", url: "https://receiver.example.com/never" },
    });
    expect(absent.json.result).toMatchObject({ resultType: "complete" });

    setDepsForTesting({
      store: createStore(memoryKv(now), now),
      callbackFetch: async () => ({ status: 502, text: async () => "" }),
      now,
    });
    const down = await rpc(token, "events/subscribe", subscribeParams(RECEIVER, secret()));
    expect(down.json.error).toMatchObject({ code: -32015, data: { reason: "http_5xx" } });
    const unknown = await rpc(token, "events/subscribe", {
      ...subscribeParams(RECEIVER, secret()),
      name: "workout.started",
    });
    expect(unknown.json.error?.code).toBe(-32011);
  });

  it("connects Intervals by OAuth only from the browser that started it", async () => {
    process.env["INTERVALS_OAUTH_CLIENT_ID"] = "client-123";
    process.env["INTERVALS_OAUTH_CLIENT_SECRET"] = "secret-456";
    resetConfigCacheForTesting();
    upstream.use(
      http.post("https://intervals.icu/api/oauth/token", async ({ request }) => {
        const form = new URLSearchParams(await request.text());
        return form.get("code") === "good-code" && form.get("client_secret") === "secret-456"
          ? HttpResponse.json({
              token_type: "Bearer",
              access_token: "oauth-token",
              scope: "ACTIVITY:READ",
              athlete: { id: "651018", name: "Kincaid" },
            })
          : new HttpResponse(null, { status: 400 });
      }),
    );

    const { POST: register } = await import("../../oauth/register/route");
    const reg = await register(
      new Request(`${BASE}/workouts/oauth/register`, {
        method: "POST",
        body: JSON.stringify({ redirect_uris: [CLIENT_REDIRECT] }),
      }),
    );
    const { client_id } = (await reg.json()) as { client_id: string };
    const { getConfig } = await import("../config");
    const authorized = await validateAuthorize(
      {
        client_id,
        redirect_uri: CLIENT_REDIRECT,
        response_type: "code",
        code_challenge: "x".repeat(43),
        code_challenge_method: "S256",
        state: null,
        scope: null,
      },
      getConfig().oauth,
    );
    if (!authorized.ok) throw new Error("authorize failed");
    const { POST: submit } = await import("../../oauth/submit/route");
    const form = new FormData();
    form.set("as_state", authorized.asState);
    form.set("hevy_api_key", HEVY_KEY);
    const toIntervals = await submit(
      new Request(`${BASE}/workouts/oauth/submit`, {
        method: "POST",
        body: form,
        headers: { origin: BASE },
      }),
    );
    expect(toIntervals.status).toBe(303);
    // A cross-site page posting the same form is refused before anything runs.
    const crossSite = await submit(
      new Request(`${BASE}/workouts/oauth/submit`, {
        method: "POST",
        body: form,
        headers: { origin: "https://attacker.example" },
      }),
    );
    expect(crossSite.status).toBe(403);
    expect(crossSite.headers.get("set-cookie")).toBeNull();
    const location = new URL(toIntervals.headers.get("location")!);
    expect(location.origin + location.pathname).toBe("https://intervals.icu/oauth/authorize");
    expect(location.searchParams.get("redirect_uri")).toBe(
      `${BASE}/workouts/oauth/intervals-callback`,
    );
    const cookie = toIntervals.headers.get("set-cookie")!.split(";")[0]!;

    const { GET: callback } = await import("../../oauth/intervals-callback/route");
    const back = (headers: Record<string, string>) =>
      callback(
        new Request(
          `${BASE}/workouts/oauth/intervals-callback?code=good-code&state=${location.searchParams.get("state")}`,
          { headers },
        ),
      );
    // Someone else's browser (no cookie) cannot finish this flow.
    expect((await back({})).status).toBe(400);
    const done = await back({ cookie });
    expect(done.status).toBe(302);
    expect(done.headers.get("location")).toMatch(
      /^https:\/\/chatgpt\.com\/connector\/oauth\/callback\?code=/,
    );
  });

  it("keeps a current Hevy webhook even when Hevy masks its token", async () => {
    const token = await connect();
    const signing = secret();
    receiverSecrets.set(RECEIVER, [signing]);
    hevyWebhook = { url: hevyWebhookUrl(HEVY_USER), auth_token: "Bearer ****" };
    await rpc(token, "events/subscribe", subscribeParams(RECEIVER, signing));
    await rpc(token, "events/subscribe", subscribeParams(RECEIVER, signing));
    expect(hevyWebhookDeletes).toBe(0);
    // A webhook from before a signing-key rotation has a different URL and is replaced.
    hevyWebhook = {
      url: `${BASE}/workouts/webhooks/hevy?user=${HEVY_USER}&k=oldkeyprint0`,
      auth_token: "Bearer ****",
    };
    await rpc(token, "events/subscribe", subscribeParams(RECEIVER, signing));
    expect(hevyWebhookDeletes).toBe(1);
    expect(hevyWebhook?.url).toBe(hevyWebhookUrl(HEVY_USER));

    // The last unsubscribe deletes the account's stored credentials.
    await rpc(token, "events/unsubscribe", {
      name: "workout.completed",
      arguments: {},
      delivery: { mode: "webhook", url: RECEIVER },
    });
    expect(await store.getCredentials(`${HEVY_USER}:i651018`)).toBeNull();
  });

  it("serializes subscription changes on one account", async () => {
    const token = await connect();
    const principalId = `${HEVY_USER}:i651018`;
    const params = (url: string, extra: Record<string, unknown> = {}) => {
      const s = secret();
      receiverSecrets.set(url, [s]);
      return { ...subscribeParams(url, s), ...extra };
    };
    // The same subscription three times at once is one subscription.
    const same = params(RECEIVER);
    const triple = await Promise.all([1, 2, 3].map(() => rpc(token, "events/subscribe", same)));
    expect(new Set(triple.map((r) => r.json.result?.id)).size).toBe(1);
    expect(await store.listSubscriptions({ kind: "principal", principalId })).toHaveLength(1);

    // A short subscription written alongside a long one never shortens the
    // account's credentials.
    await Promise.all([
      rpc(token, "events/subscribe", params("https://receiver.example.com/long")),
      rpc(
        token,
        "events/subscribe",
        params("https://receiver.example.com/short", { ttlMs: 3600_000 }),
      ),
    ]);
    clock += 2 * 3600_000;
    expect(await store.getCredentials(principalId)).not.toBeNull();

    // Unsubscribing the last subscription while a replacement subscribes
    // leaves the replacement with credentials and the Hevy webhook.
    for (const url of [RECEIVER, "https://receiver.example.com/long"]) {
      // oxlint-disable-next-line no-await-in-loop -- clearing down to none
      await rpc(token, "events/unsubscribe", {
        name: "workout.completed",
        arguments: {},
        delivery: { mode: "webhook", url },
      });
    }
    expect(await store.listSubscriptions({ kind: "principal", principalId })).toHaveLength(0);
    await Promise.all([
      rpc(token, "events/subscribe", params("https://receiver.example.com/replacement")),
      rpc(token, "events/unsubscribe", {
        name: "workout.completed",
        arguments: {},
        delivery: { mode: "webhook", url: RECEIVER },
      }),
    ]);
    expect(await store.getCredentials(principalId)).not.toBeNull();
    expect(hevyWebhook).not.toBeNull();
  });

  it("drops queued retries from an earlier subscription lifetime", async () => {
    const token = await connect();
    const signing = secret();
    receiverSecrets.set(RECEIVER, [signing]);
    const params = subscribeParams(RECEIVER, signing);
    await rpc(token, "events/subscribe", params);
    receiverStatus = 503;
    expect(await hevyWebhookCall("f1085cdb-32b2-4003-967d-53a3af8eaecb")).toBe(200);
    receiverStatus = 200;
    // Unsubscribe and resubscribe with the same identity before the retry.
    await rpc(token, "events/unsubscribe", {
      name: "workout.completed",
      arguments: {},
      delivery: { mode: "webhook", url: RECEIVER },
    });
    clock += 1000;
    await rpc(token, "events/subscribe", params);
    received = [];
    clock += 5 * 60_000;
    await tick();
    expect(events()).toHaveLength(0);
  });

  it("re-evaluates handled activities when the set of subscriptions changes", async () => {
    const token = await connect();
    const signing = secret();
    receiverSecrets.set(RECEIVER, [signing]);
    await rpc(
      token,
      "events/subscribe",
      subscribeParams(RECEIVER, signing, { sources: ["intervals"] }),
    );
    const subscribedAt = clock;
    clock += 60 * 60_000;
    activities.push(activity("i900", new Date(clock).toISOString()));
    clock += 20 * 60_000;
    await tick();
    // A subscription that existed before i900 but was missing from that poll's
    // snapshot (it finished subscribing mid-poll) must still receive it.
    const RUNS = "https://receiver.example.com/mcp-events/cb_runs";
    const runsSecret = secret();
    receiverSecrets.set(RUNS, [runsSecret]);
    await store.putSubscription({
      id: "sub_mid_poll",
      principalId: `${HEVY_USER}:i651018`,
      hevyUserId: HEVY_USER,
      intervalsAthleteId: "i651018",
      arguments: { sources: ["intervals"] },
      url: RUNS,
      secrets: [{ secret: runsSecret, retiresAt: null }],
      createdAt: subscribedAt + 1,
      expiresAt: clock + 24 * 3600_000,
    });
    received = [];
    await tick();
    expect(events().map((e) => [e.url, (e.body as unknown as McpEvent).eventId])).toEqual([
      [RUNS, "intervals_i900"],
    ]);
  });

  it("never prunes a subscription that a refresh just recreated", async () => {
    // The first read of the record misses (it had expired), and the refresh
    // recreates it before the prune runs.
    const inner = memoryKv(now);
    let missOnce = true;
    const kv: Kv = {
      ...inner,
      get: async (k) => {
        if (k === "wk:sub:sub_refreshed" && missOnce) {
          missOnce = false;
          return null;
        }
        return inner.get(k);
      },
    };
    const racing = createStore(kv, now);
    await racing.putSubscription({
      id: "sub_refreshed",
      principalId: `${HEVY_USER}:i651018`,
      hevyUserId: HEVY_USER,
      intervalsAthleteId: "i651018",
      arguments: {},
      url: RECEIVER,
      secrets: [{ secret: secret(), retiresAt: null }],
      createdAt: clock,
      expiresAt: clock + 3600_000,
    });
    expect(await racing.listSubscriptions({ kind: "all" })).toHaveLength(0);
    expect(await racing.listSubscriptions({ kind: "all" })).toHaveLength(1);
  });

  it("revokes on a 401 only if the credentials are still the ones that failed", async () => {
    const token = await connect();
    const signing = secret();
    receiverSecrets.set(RECEIVER, [signing]);
    await rpc(token, "events/subscribe", subscribeParams(RECEIVER, signing));
    const principalId = `${HEVY_USER}:i651018`;
    // Hevy rejects the old key while a reconnect stores new credentials.
    upstream.use(
      http.get("https://api.hevyapp.com/v1/workouts/:id", async () => {
        await store.putCredentials(principalId, "sealed-after-reconnect", clock + 3600_000);
        return new HttpResponse(null, { status: 401 });
      }),
    );
    await hevyWebhookCall("a2085cdb-32b2-4003-967d-53a3af8eaecb");
    expect(await store.listSubscriptions({ kind: "principal", principalId })).toHaveLength(1);

    // With no reconnect, a 401 revokes the account.
    upstream.use(
      http.get(
        "https://api.hevyapp.com/v1/workouts/:id",
        () => new HttpResponse(null, { status: 401 }),
      ),
    );
    await rpc(token, "events/subscribe", subscribeParams(RECEIVER, signing));
    await hevyWebhookCall("a3085cdb-32b2-4003-967d-53a3af8eaecb");
    expect(await store.listSubscriptions({ kind: "principal", principalId })).toHaveLength(0);
    // The credentials outlive the revocation just long enough for the tick to
    // give back the webhook slot, which the Hevy key can still do.
    expect(hevyWebhook).not.toBeNull();
    await tick();
    expect(hevyWebhook).toBeNull();
    expect(await store.getCredentials(principalId)).toBeNull();
  });

  it("refuses to roll the account back to a rotated key", async () => {
    const token = await connect();
    const signing = secret();
    receiverSecrets.set(RECEIVER, [signing]);
    const params = subscribeParams(RECEIVER, signing, { sources: ["intervals"] });
    await rpc(token, "events/subscribe", params);
    const principalId = `${HEVY_USER}:i651018`;
    const stored = await store.getCredentials(principalId);
    // The Hevy key in this token has since been rotated away.
    upstream.use(
      http.get(
        "https://api.hevyapp.com/v1/user/info",
        () => new HttpResponse(null, { status: 401 }),
      ),
    );
    const stale = await rpc(token, "events/subscribe", params);
    expect(stale.json.error?.message).toContain("reconnect");
    expect(await store.getCredentials(principalId)).toBe(stored);
  });

  it("keeps credentials only as long as the longest remaining subscription", async () => {
    const token = await connect();
    const sub = (url: string, ttlMs?: number) => {
      const s = secret();
      receiverSecrets.set(url, [s]);
      return rpc(token, "events/subscribe", {
        ...subscribeParams(url, s),
        ...(ttlMs ? { ttlMs } : {}),
      });
    };
    await sub("https://receiver.example.com/long");
    await sub("https://receiver.example.com/short", 3600_000);
    await rpc(token, "events/unsubscribe", {
      name: "workout.completed",
      arguments: {},
      delivery: { mode: "webhook", url: "https://receiver.example.com/long" },
    });
    const principalId = `${HEVY_USER}:i651018`;
    // Kept past the last subscription only for the one-day cleanup grace.
    clock += 2 * 3600_000;
    expect(await store.getCredentials(principalId)).not.toBeNull();
    clock += 24 * 3600_000;
    expect(await store.getCredentials(principalId)).toBeNull();
  });

  it("enables the Hevy webhook only after the subscription is stored", async () => {
    const token = await connect();
    const signing = secret();
    receiverSecrets.set(RECEIVER, [signing]);
    const principalId = `${HEVY_USER}:i651018`;
    let visibleWhenEnabled: number | null = null;
    let ownersWhenEnabled: string[] = [];
    upstream.use(
      http.post("https://api.hevyapp.com/v1/webhook-subscription", async ({ request }) => {
        visibleWhenEnabled = (
          await store.listSubscriptions({ kind: "hevy", hevyUserId: HEVY_USER })
        ).length;
        ownersWhenEnabled = await store.listWebhookOwners();
        const body = (await request.json()) as { url: string; authToken: string };
        hevyWebhook = { url: body.url, auth_token: body.authToken };
        return new HttpResponse(null, { status: 201 });
      }),
    );
    await rpc(token, "events/subscribe", subscribeParams(RECEIVER, signing));
    expect(visibleWhenEnabled).toBe(1);
    // Already findable by the tick's cleanup if this invocation dies now.
    expect(ownersWhenEnabled).toEqual([principalId]);

    // If enabling fails, a new subscription is withdrawn.
    upstream.use(
      http.post(
        "https://api.hevyapp.com/v1/webhook-subscription",
        () => new HttpResponse(null, { status: 500 }),
      ),
    );
    hevyWebhook = null;
    const other = "https://receiver.example.com/other";
    const otherSecret = secret();
    receiverSecrets.set(other, [otherSecret]);
    const failed = await rpc(token, "events/subscribe", subscribeParams(other, otherSecret));
    expect(failed.json.error?.message).toContain("Hevy webhook");
    const ids = (await store.listSubscriptions({ kind: "principal", principalId })).map(
      (s) => s.url,
    );
    expect(ids).toEqual([RECEIVER]);

    // ...and the credentials go back to living only as long as RECEIVER.
    await rpc(token, "events/unsubscribe", {
      name: "workout.completed",
      arguments: {},
      delivery: { mode: "webhook", url: RECEIVER },
    });
    const retry = await rpc(token, "events/subscribe", {
      ...subscribeParams(other, otherSecret),
      ttlMs: 30 * 24 * 3600_000,
    });
    expect(retry.json.error?.message).toContain("Hevy webhook");
    expect(await store.getCredentials(principalId)).toBeNull();
  });

  it("keeps a refresh rolled back after a webhook failure readable for its whole life", async () => {
    const token = await connect();
    const signing = secret();
    receiverSecrets.set(RECEIVER, [signing]);
    const params = subscribeParams(RECEIVER, signing);
    await rpc(token, "events/subscribe", { ...params, ttlMs: 30 * 24 * 3600_000 });
    upstream.use(
      http.post(
        "https://api.hevyapp.com/v1/webhook-subscription",
        () => new HttpResponse(null, { status: 500 }),
      ),
    );
    hevyWebhook = null;
    const failed = await rpc(token, "events/subscribe", { ...params, ttlMs: 3600_000 });
    expect(failed.json.error?.message).toContain("Hevy webhook");
    clock += 3 * 24 * 3600_000;
    const principalId = `${HEVY_USER}:i651018`;
    expect(await store.listSubscriptions({ kind: "principal", principalId })).toHaveLength(1);
    // The ciphertext's own expiry reads the system clock.
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 3 * 24 * 3600_000 });
    try {
      expect(await openCredentials(await store.getCredentials(principalId))).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("retries the Hevy webhook release when Hevy is unreachable", async () => {
    const token = await connect();
    const signing = secret();
    receiverSecrets.set(RECEIVER, [signing]);
    await rpc(token, "events/subscribe", subscribeParams(RECEIVER, signing));
    upstream.use(
      http.delete(
        "https://api.hevyapp.com/v1/webhook-subscription",
        () => new HttpResponse(null, { status: 503 }),
        { once: true },
      ),
    );
    await rpc(token, "events/unsubscribe", {
      name: "workout.completed",
      arguments: {},
      delivery: { mode: "webhook", url: RECEIVER },
    });
    expect(hevyWebhook).not.toBeNull();
    await tick();
    expect(hevyWebhook).toBeNull();
    expect(await store.getCredentials(`${HEVY_USER}:i651018`)).toBeNull();
  });

  it("keeps a recreated subscription's queued item apart from its predecessor's", async () => {
    const base = {
      id: "sub_same",
      principalId: `${HEVY_USER}:i651018`,
      hevyUserId: HEVY_USER,
      intervalsAthleteId: "i651018",
      arguments: {},
      url: RECEIVER,
      secrets: [{ secret: secret(), retiresAt: null }],
      expiresAt: clock + 3600_000,
    };
    const event: McpEvent = {
      eventId: "intervals_i1",
      name: "workout.completed",
      timestamp: new Date(clock).toISOString(),
      data: {
        source: "intervals",
        workout_id: "i1",
        title: "Run",
        sport: "Run",
        start_time: new Date(clock).toISOString(),
        duration_seconds: 60,
        url: "https://intervals.icu/activities/i1",
        summary: "",
      },
      cursor: null,
    };
    // The new generation enqueues first; a stale snapshot of the old one
    // finishes after it.
    const fresh = await store.enqueueOnce({ ...base, createdAt: clock + 1 }, event);
    const stale = await store.enqueueOnce({ ...base, createdAt: clock }, event);
    expect(fresh).not.toBe(stale);
    expect((await store.getOutboxItem(fresh!))?.subscriptionCreatedAt).toBe(clock + 1);
  });

  it("releases the Hevy webhook once subscriptions expire without an unsubscribe", async () => {
    const token = await connect();
    const signing = secret();
    receiverSecrets.set(RECEIVER, [signing]);
    await rpc(token, "events/subscribe", {
      ...subscribeParams(RECEIVER, signing),
      ttlMs: 3600_000,
    });
    expect(hevyWebhook).not.toBeNull();
    await tick();
    expect(hevyWebhook).not.toBeNull();
    clock += 2 * 3600_000;
    await tick();
    expect(hevyWebhook).toBeNull();
    expect(await store.getCredentials(`${HEVY_USER}:i651018`)).toBeNull();
  });

  it("serves tools to the model", async () => {
    const token = await connect();

    // 2025-era clients keep working on the same URL, statelessly.
    const { POST } = await import("../../route");
    const legacy = await POST(
      new Request(`${BASE}/workouts`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "legacy", version: "1" },
          },
        }),
      }),
    );
    expect(legacy.status).toBe(200);
    expect(await legacy.text()).toContain('"protocolVersion":"2025-06-18"');

    const recent = await rpc(token, "tools/call", {
      name: "list-recent-workouts",
      arguments: { days: 7 },
    });
    expect(recent.json.result?.content?.[0]?.text).toContain("intervals · New York Running (Run)");
    const run = await rpc(token, "tools/call", {
      name: "get-intervals-activity",
      arguments: { activity_id: "i100" },
    });
    expect(run.json.result?.content?.[0]?.text).toContain("pace");
  });

  it("accepts Intervals webhooks once a secret is configured", async () => {
    const token = await connect();
    const signing = secret();
    receiverSecrets.set(RECEIVER, [signing]);
    await rpc(
      token,
      "events/subscribe",
      subscribeParams(RECEIVER, signing, { sources: ["intervals"] }),
    );
    received = [];

    const call = async (body: unknown) => {
      const r = await receiveIntervalsWebhook(
        new Request(`${BASE}/workouts/webhooks/intervals`, {
          method: "POST",
          body: JSON.stringify(body),
        }),
      );
      await deliverAll(r.followUp);
      return r.response.status;
    };
    expect(await call({ secret: "x", events: [] })).toBe(404);

    process.env["INTERVALS_WEBHOOK_SECRET"] = "hook-secret";
    resetConfigCacheForTesting();
    expect(await call({ secret: "wrong", events: [] })).toBe(401);

    // Re-analysis of an activity from before the subscription is not news.
    expect(await call(analyzed("i100"))).toBe(200);
    expect(events()).toHaveLength(0);

    clock += 60_000;
    activities.push(activity("i600", new Date(clock).toISOString()));
    expect(await call(analyzed("i600"))).toBe(200);
    expect(events()).toHaveLength(1);
    expect((events()[0]!.body as unknown as McpEvent).eventId).toBe("intervals_i600");
    // Re-analysis of the same activity does not notify twice, and neither
    // does the polling backstop.
    expect(await call(analyzed("i600"))).toBe(200);
    clock += 20 * 60 * 1000;
    expect((await tick()).json).toMatchObject({ queuedFromPolling: 0 });
    expect(events()).toHaveLength(1);
  });
});

describe("callback guards", () => {
  it("classifies addresses", () => {
    for (const ip of ["8.8.8.8", "104.18.32.7", "2606:4700::6810:84e5"]) {
      expect(isPublicAddress(ip), ip).toBe(true);
    }
    for (const ip of [
      "127.0.0.1",
      "10.1.2.3",
      "172.16.0.1",
      "192.168.1.1",
      "169.254.169.254",
      "100.64.0.1",
      "0.0.0.0",
      "::1",
      "::",
      "::ffff:127.0.0.1",
      "fd00::1",
      "fe80::1",
      "2002:7f00:1::",
      "not-an-ip",
    ]) {
      expect(isPublicAddress(ip), ip).toBe(false);
    }
  });

  it("checks callback URLs statically", () => {
    expect(checkCallbackUrl("https://hooks.chatgpt.com/x").ok).toBe(true);
    for (const url of [
      "http://hooks.chatgpt.com/x",
      "https://user:pw@hooks.chatgpt.com/x",
      "https://127.0.0.1/x",
      "https://[::1]/x",
      "https://localhost/x",
      "https://intranet/x",
      "not a url",
    ]) {
      expect(checkCallbackUrl(url).ok, url).toBe(false);
    }
  });

  it("checks signing secrets", () => {
    expect(checkSigningSecret(`whsec_${Buffer.alloc(32, 1).toString("base64")}`).ok).toBe(true);
    expect(checkSigningSecret(`whsec_${Buffer.alloc(16, 1).toString("base64")}`).ok).toBe(false);
    expect(checkSigningSecret(`whsec_${Buffer.alloc(65, 1).toString("base64")}`).ok).toBe(false);
    expect(checkSigningSecret(Buffer.alloc(32, 1).toString("base64")).ok).toBe(false);
    expect(checkSigningSecret("whsec_not*base64").ok).toBe(false);
  });

  it("canonicalizes key order at every depth", () => {
    expect(canonicalJson({ b: 1, a: { d: [2, { z: 1, y: 2 }], c: null } })).toBe(
      canonicalJson({ a: { c: null, d: [2, { y: 2, z: 1 }] }, b: 1 }),
    );
  });

  // Uses real DNS: localtest.me resolves to 127.0.0.1, which passes the static
  // URL check, so only the connection-time lookup guard can stop it.
  it.skipIf(!process.env["NETWORK_TESTS"])(
    "refuses hostnames that resolve to private addresses",
    async () => {
      const post = createSafeCallbackFetch();
      await expect(
        post("https://localtest.me/x", {
          headers: {},
          body: "{}",
          signal: AbortSignal.timeout(5000),
        }),
      ).rejects.toThrow();
    },
  );
});
