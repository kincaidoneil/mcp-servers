// The /workouts MCP endpoint: MCP 2.0 (2026-07-28) through SDK v2, which
// ChatGPT requires for events, with 2025-era clients served statelessly on the
// same URL. Tools read workouts; events/* manage workout.completed
// subscriptions.

import {
  createMcpHandler,
  McpServer,
  ProtocolError,
  type AuthInfo,
  type McpRequestContext,
} from "@modelcontextprotocol/server";
import { z } from "zod";
import { createHevyClient } from "@/app/hevy/_internal/client";
import { renderWorkout } from "@/app/hevy/_internal/render";
import { listWorkouts } from "@/app/hevy/_internal/tools/workouts";
import { verifyAccessToken } from "@/lib/oauth-as";
import { getConfig, SERVICE_PATH } from "./config";
import { toPrincipal, type Principal } from "./credentials";
import {
  SubscribeParamsSchema,
  UnsubscribeParamsSchema,
  ListEventsParamsSchema,
  eventDefinitions,
  SubscribeResultSchema,
} from "./events/schema";
import { subscribe, unsubscribe } from "./events/subscriptions";
import { createIntervalsClient } from "./intervals";
import { activityLine, renderActivity } from "./render-activity";
import { fetchActivity } from "./sources";

const text = (value: string) => ({ content: [{ type: "text" as const, text: value }] });
const failure = (value: string) => ({ ...text(value), isError: true });

const display = () => getConfig().display;

function registerTools(server: McpServer, principal: Principal) {
  server.registerTool(
    "get-hevy-workout",
    {
      title: "Get a Hevy workout",
      description:
        "Fetch one Hevy strength workout by UUID with every exercise and set. Use the workout_id from a workout.completed event.",
      inputSchema: z.object({ workout_id: z.uuid() }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ workout_id }) => {
      const result = await createHevyClient(principal.credentials.hevy.apiKey).getWorkout(
        workout_id,
      );
      return result.ok
        ? text(renderWorkout(result.value, display()))
        : failure(`Hevy returned ${result.code}: ${result.message}`);
    },
  );

  server.registerTool(
    "get-intervals-activity",
    {
      title: "Get an Intervals.icu activity",
      description:
        "Fetch one Intervals.icu activity by id (e.g. i194509836) for analysis: totals, the athlete's thresholds and HR zones, load and fitness after the activity, efficiency (decoupling, HR recovery), running form, every detected interval with pace, grade-adjusted pace, grade and HR, and per-mile splits from the recorded streams. A workout.completed event already carries this same text in its summary.",
      inputSchema: z.object({ activity_id: z.string().regex(/^i?\d+$/) }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ activity_id }) => {
      const result = await fetchActivity(
        createIntervalsClient(principal.credentials.intervals),
        activity_id,
      );
      return result.ok
        ? text(renderActivity(result.value.activity, display(), result.value.streams))
        : failure(`Intervals returned ${result.code}: ${result.message}`);
    },
  );

  server.registerTool(
    "list-recent-workouts",
    {
      title: "List recent workouts",
      description:
        "List workouts from both Hevy and Intervals.icu over the last N days, newest first, one line each. Use it for context around a new workout, such as training load across the week.",
      inputSchema: z.object({ days: z.number().int().min(1).max(42).default(7) }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ days }) => {
      const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
      const [hevy, intervals] = await Promise.all([
        listWorkouts(
          { page: 1, pageSize: 10, since: since.toISOString(), limit: 100 },
          createHevyClient(principal.credentials.hevy.apiKey),
          display().timeZone,
        ),
        createIntervalsClient(principal.credentials.intervals).listActivities(
          since.toISOString().slice(0, 10),
          new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
        ),
      ]);
      const rows: { at: number; line: string }[] = [];
      const notes: string[] = [];
      if (hevy.ok && "workouts" in hevy.value) {
        for (const w of hevy.value.workouts) {
          const start = w.start_time ? Date.parse(w.start_time) : 0;
          const minutes =
            start && w.end_time ? Math.round((Date.parse(w.end_time) - start) / 60000) : null;
          rows.push({
            at: start,
            line: `${w.start_time ?? "?"} · hevy · ${w.title}${minutes ? ` · ${minutes} min` : ""} · ${w.exercises?.length ?? 0} exercises · id ${w.id}`,
          });
        }
      } else {
        notes.push(`Hevy unavailable${hevy.ok ? "" : ` (${hevy.code})`}.`);
      }
      if (intervals.ok) {
        for (const a of intervals.value) {
          rows.push({ at: Date.parse(a.start_date ?? "") || 0, line: activityLine(a, display()) });
        }
      } else {
        notes.push(`Intervals unavailable (${intervals.code}).`);
      }
      rows.sort((a, b) => b.at - a.at);
      const body =
        rows.length > 0
          ? rows.map((r) => r.line).join("\n")
          : `No workouts in the last ${days} days.`;
      return text([body, ...notes].join("\n"));
    },
  );
}

function registerEvents(server: McpServer, principal: Principal) {
  server.server.setRequestHandler(
    "events/list",
    { params: ListEventsParamsSchema, result: z.looseObject({ events: z.array(z.unknown()) }) },
    async () => ({ events: eventDefinitions() }),
  );

  server.server.setRequestHandler(
    "events/subscribe",
    { params: SubscribeParamsSchema, result: SubscribeResultSchema },
    async (params) => {
      const outcome = await subscribe(principal, params);
      if (!outcome.ok) throw new ProtocolError(outcome.code, outcome.message, outcome.data);
      return outcome.result;
    },
  );

  server.server.setRequestHandler(
    "events/unsubscribe",
    { params: UnsubscribeParamsSchema, result: z.looseObject({}) },
    async (params) => {
      const outcome = await unsubscribe(principal, params);
      if (!outcome.ok) throw new ProtocolError(outcome.code, outcome.message, outcome.data);
      return {};
    },
  );
}

async function authenticate(bearer: string | undefined): Promise<Principal | null> {
  if (!bearer) return null;
  const verified = await verifyAccessToken(bearer, getConfig().oauth);
  return verified ? toPrincipal(verified.upstreamAccessToken, verified.identity) : null;
}

export function createWorkoutsMcpHandler() {
  const handler = createMcpHandler(async (ctx: McpRequestContext) => {
    // The gate below already admitted this token; decrypting it again here is
    // cheaper than threading an untyped principal through authInfo.extra.
    const principal = await authenticate(ctx.authInfo?.token);
    if (!principal) throw new Error("unauthenticated request reached the MCP server");
    const server = new McpServer(
      { name: "workouts", version: "0.1.0" },
      // events is not in the SDK's capability type yet; the SDK passes it
      // through to server/discover unchanged.
      { capabilities: { tools: {}, events: {} } as { tools: object } },
    );
    registerTools(server, principal);
    registerEvents(server, principal);
    return server;
  });

  return async (req: Request): Promise<Response> => {
    const bearer = req.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
    const principal = await authenticate(bearer);
    if (!bearer || !principal) {
      const metadata = `${new URL(getConfig().oauth.baseUrl).origin}${SERVICE_PATH}/.well-known/oauth-protected-resource`;
      return Response.json(
        {
          error: "invalid_token",
          error_description: "A valid /workouts access token is required.",
        },
        {
          status: 401,
          headers: { "WWW-Authenticate": `Bearer resource_metadata="${metadata}"` },
        },
      );
    }
    const authInfo: AuthInfo = { token: bearer, clientId: principal.id, scopes: [] };
    return handler.fetch(req, { authInfo });
  };
}
