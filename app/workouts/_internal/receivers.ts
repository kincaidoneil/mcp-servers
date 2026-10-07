// Inbound HTTP from upstream services and the scheduler. Each receiver returns
// its response plus the outbox members to attempt once the response is out:
// Hevy wants an answer within 5 seconds, and ChatGPT may take up to 10.

import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { getConfig, normalizeAthleteId } from "./config";
import { drainOutbox, type DeliveryResult } from "./events/dispatch";
import {
  checkHevyWebhookAuth,
  ingestHevyWorkout,
  ingestIntervalsActivity,
  pollIntervals,
} from "./sources";

export interface Received {
  response: Response;
  followUp: string[];
}

const ok = (followUp: string[] = []): Received => ({
  response: new Response(null, { status: 200 }),
  followUp,
});
const status = (code: number, message: string): Received => ({
  response: Response.json({ error: message }, { status: code }),
  followUp: [],
});

function sameSecret(expected: string, actual: string): boolean {
  const a = Buffer.from(expected);
  const b = Buffer.from(actual);
  return a.length === b.length && timingSafeEqual(a, b);
}

const HevyWebhookSchema = z.object({ payload: z.object({ workoutId: z.string().min(1) }) });

export async function receiveHevyWebhook(req: Request): Promise<Received> {
  const user = new URL(req.url).searchParams.get("user");
  if (!user || !checkHevyWebhookAuth(user, req.headers.get("authorization"))) {
    return status(401, "unauthorized");
  }
  const body = HevyWebhookSchema.safeParse(await req.json().catch(() => null));
  if (!body.success) return status(400, "expected {payload: {workoutId}}");

  const result = await ingestHevyWorkout(user, body.data.payload.workoutId);
  if (!result.ok) {
    // 503 asks Hevy to redeliver; anything permanent is acknowledged so Hevy
    // stops retrying something that cannot succeed.
    return result.retry ? status(503, result.reason) : ok();
  }
  return ok(result.queued);
}

const IntervalsWebhookSchema = z.object({
  secret: z.string(),
  events: z.array(
    z.looseObject({
      athlete_id: z.union([z.string(), z.number()]).transform(String),
      type: z.string(),
      activity: z
        .looseObject({ id: z.union([z.string(), z.number()]).transform(String) })
        .nullish(),
    }),
  ),
});

export async function receiveIntervalsWebhook(req: Request): Promise<Received> {
  const expected = getConfig().intervalsWebhookSecret;
  if (!expected) return status(404, "Intervals webhooks are not enabled");
  const body = IntervalsWebhookSchema.safeParse(await req.json().catch(() => null));
  if (!body.success) return status(400, "unexpected webhook body");
  if (!sameSecret(expected, body.data.secret)) return status(401, "unauthorized");

  // ANALYZED arrives about a minute after UPLOADED with the metrics filled in.
  // Other event types are not workouts.
  const results = await Promise.all(
    body.data.events.flatMap((event) =>
      event.type === "ACTIVITY_ANALYZED" && event.activity
        ? [ingestIntervalsActivity(normalizeAthleteId(event.athlete_id), event.activity.id)]
        : [],
    ),
  );
  const followUp = results.flatMap((r) => (r.ok ? r.queued : []));
  const retry = results.some((r) => !r.ok && r.retry);
  // Events already emitted are claimed, so a redelivery only redoes the rest.
  if (retry) return { ...status(503, "retry later"), followUp };
  return ok(followUp);
}

export async function runTick(req: Request): Promise<Response> {
  const header = req.headers.get("authorization") ?? "";
  if (!sameSecret(`Bearer ${getConfig().tickSecret}`, header)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  const polled = await pollIntervals();
  const results = await drainOutbox();
  const count = (r: DeliveryResult) => results.filter((x) => x === r).length;
  return Response.json({
    queuedFromPolling: polled.length,
    delivered: count("delivered"),
    retrying: count("retrying"),
    dropped: count("dropped") + count("subscription_gone"),
  });
}
