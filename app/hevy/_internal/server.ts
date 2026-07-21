import { createMcpHandler, withMcpAuth } from "mcp-handler";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { z } from "zod";
import { verifyAccessToken } from "@/lib/oauth-as";
import { getConfig } from "./config";
import {
  renderBodyMeasurementsPage,
  renderExerciseHistory,
  renderExerciseTemplate,
  renderExerciseTemplatesPage,
  renderRoutine,
  renderRoutineFolder,
  renderRoutineFoldersPage,
  renderRoutinesPage,
  renderWorkout,
  renderWorkoutCount,
  renderWorkoutsResult,
  stripNulls,
} from "./render";
import { createHevyClient, type HevyClient, type HevyResult } from "./client";
import {
  ListBodyMeasurementsInputSchema,
  listBodyMeasurements,
  LogBodyMeasurementInputSchema,
  logBodyMeasurement,
} from "./tools/body-measurements";
import {
  GetExerciseTemplateInputSchema,
  getExerciseTemplate,
  ListExerciseTemplatesInputSchema,
  listExerciseTemplates,
} from "./tools/exercise-templates";
import {
  CreateRoutineFolderInputSchema,
  createRoutineFolder,
  ListRoutineFoldersInputSchema,
  listRoutineFolders,
} from "./tools/routine-folders";
import {
  GetRoutineInputSchema,
  getRoutine,
  ListRoutinesInputSchema,
  listRoutines,
  SaveRoutineInputSchema,
  saveRoutine,
} from "./tools/routines";
import {
  GetExerciseHistoryInputSchema,
  getExerciseHistory,
  GetWorkoutCountInputSchema,
  getWorkoutCount,
  GetWorkoutInputSchema,
  getWorkout,
  ListWorkoutsInputSchema,
  listWorkouts,
  SaveWorkoutInputSchema,
  saveWorkout,
} from "./tools/workouts";

const METRIC_NOTE =
  "The Hevy API is metric-only: weight_kg (kilograms), distance_meters, duration_seconds. " +
  "Convert imperial units before calling.";

interface ToolSpec<Schema extends z.ZodObject<z.ZodRawShape>, Value> {
  name: string;
  title: string;
  description: string;
  schema: Schema;
  readOnly: boolean;
  idempotent?: boolean;
  run: (input: z.infer<Schema>, client: HevyClient) => Promise<HevyResult<Value>>;
  // Text rendering for the model-facing content block. Omit to fall back to
  // compact null-stripped JSON.
  render?: (value: Value) => string;
}

function registerTool<Schema extends z.ZodObject<z.ZodRawShape>, Value>(
  server: McpServer,
  spec: ToolSpec<Schema, Value>,
) {
  server.registerTool(
    spec.name,
    {
      title: spec.title,
      description: spec.description,
      inputSchema: spec.schema.shape,
      annotations: {
        title: spec.title,
        readOnlyHint: spec.readOnly,
        ...(spec.readOnly ? {} : { destructiveHint: false }),
        ...(spec.idempotent !== undefined ? { idempotentHint: spec.idempotent } : {}),
        openWorldHint: true,
      },
    },
    async (input, extra) => {
      const client = createHevyClient(extractUpstreamToken(extra));
      const result = await spec.run(spec.schema.parse(input), client);
      return toToolResult(result, spec.render);
    },
  );
}

function toToolResult<Value>(result: HevyResult<Value>, render?: (value: Value) => string) {
  if (!result.ok) {
    return {
      content: [{ type: "text" as const, text: errorMessage(result) }],
      isError: true,
    };
  }
  const bare = stripNulls(result.value);
  const structured =
    bare !== null && bare !== undefined && typeof bare === "object" && !Array.isArray(bare)
      ? (bare as { [k: string]: unknown })
      : { ok: true };
  const text = render ? render(result.value) : JSON.stringify(bare ?? { ok: true });
  return {
    content: [{ type: "text" as const, text }],
    structuredContent: structured,
  };
}

function errorMessage(err: Extract<HevyResult<unknown>, { ok: false }>): string {
  switch (err.code) {
    case "unauthorized":
      return (
        "Hevy rejected the saved API key (401). The key may have been regenerated — " +
        "reconnect the Hevy MCP server and paste the current key."
      );
    case "not_found":
      return `Hevy returned 404 — no such resource. ${err.message}`;
    case "conflict":
      return (
        "Hevy returned 409 — the resource already exists. For body measurements this means " +
        "a measurement is already logged for that date."
      );
    case "rate_limited":
      return "Hevy rate limit hit (429). Wait a moment and retry.";
    case "invalid_response":
      return `Hevy returned an unexpected response shape: ${err.message}`;
    case "http_error":
      return `Hevy returned HTTP ${err.status}: ${err.message}`;
    case "network":
      return `Could not reach the Hevy API: ${err.message}`;
  }
}

function registerTools(server: McpServer) {
  registerTool(server, {
    name: "hevy-list-workouts",
    title: "List Hevy workouts",
    description:
      "List logged workouts, newest first, with their exercises and sets. " +
      "Pass since and/or until to filter by date across pages in one call (the common " +
      "case, e.g. workouts in June); the server scans up to the 100 most recent and " +
      "returns only in-range workouts. Otherwise it returns one raw page (max 10). " +
      METRIC_NOTE,
    schema: ListWorkoutsInputSchema,
    readOnly: true,
    run: (input, client) => listWorkouts(input, client, getConfig().display.timeZone),
    render: (v) => renderWorkoutsResult(v, getConfig().display),
  });

  registerTool(server, {
    name: "hevy-get-workout",
    title: "Get a Hevy workout",
    description: "Fetch a single workout by UUID, including all exercises and sets. " + METRIC_NOTE,
    schema: GetWorkoutInputSchema,
    readOnly: true,
    run: getWorkout,
    render: (v) => renderWorkout(v, getConfig().display),
  });

  registerTool(server, {
    name: "hevy-get-workout-count",
    title: "Get Hevy workout count",
    description: "Get the total number of workouts on the account.",
    schema: GetWorkoutCountInputSchema,
    readOnly: true,
    run: getWorkoutCount,
    render: renderWorkoutCount,
  });

  registerTool(server, {
    name: "hevy-get-exercise-history",
    title: "Get Hevy exercise history",
    description:
      "Get every logged set of one exercise across all workouts, optionally within a date range. " +
      "Use this for progress analysis (e.g. bench press over the last year). " +
      METRIC_NOTE,
    schema: GetExerciseHistoryInputSchema,
    readOnly: true,
    run: getExerciseHistory,
    render: (v) => renderExerciseHistory(v, getConfig().display),
  });

  registerTool(server, {
    name: "hevy-save-workout",
    title: "Log or update a Hevy workout",
    description:
      "Log a completed workout (omit workout_id) or update an existing one (pass workout_id). " +
      "Updates replace the workout in full — fetch it first and send the complete version. " +
      "There is no delete: the Hevy API cannot remove workouts. " +
      METRIC_NOTE,
    schema: SaveWorkoutInputSchema,
    readOnly: false,
    run: saveWorkout,
    render: (v) => renderWorkout(v, getConfig().display),
  });

  registerTool(server, {
    name: "hevy-list-routines",
    title: "List Hevy routines",
    description: "List workout routines (training templates). Paginated (max 10 per page).",
    schema: ListRoutinesInputSchema,
    readOnly: true,
    run: listRoutines,
    render: (v) => renderRoutinesPage(v, getConfig().display),
  });

  registerTool(server, {
    name: "hevy-get-routine",
    title: "Get a Hevy routine",
    description: "Fetch a single routine by UUID, including exercises, sets, and rest times.",
    schema: GetRoutineInputSchema,
    readOnly: true,
    run: getRoutine,
    render: (v) => renderRoutine(v, getConfig().display),
  });

  registerTool(server, {
    name: "hevy-save-routine",
    title: "Create or update a Hevy routine",
    description:
      "Create a routine (omit routine_id) or update an existing one (pass routine_id). " +
      "Updates replace the routine in full — fetch it first and send the complete version. " +
      "Sets support target rep_range; exercises support rest_seconds. " +
      "There is no delete: the Hevy API cannot remove routines. " +
      METRIC_NOTE,
    schema: SaveRoutineInputSchema,
    readOnly: false,
    run: saveRoutine,
    render: (v) => renderRoutine(v, getConfig().display),
  });

  registerTool(server, {
    name: "hevy-list-exercise-templates",
    title: "List Hevy exercise templates",
    description:
      "List available exercises (built-in and custom) with muscle groups and equipment. " +
      "Paginated (max 100 per page). Use the returned ids in workout and routine exercises.",
    schema: ListExerciseTemplatesInputSchema,
    readOnly: true,
    run: listExerciseTemplates,
    render: renderExerciseTemplatesPage,
  });

  registerTool(server, {
    name: "hevy-get-exercise-template",
    title: "Get a Hevy exercise template",
    description: 'Fetch a single exercise template by its short id (e.g. "05293BCA").',
    schema: GetExerciseTemplateInputSchema,
    readOnly: true,
    run: getExerciseTemplate,
    render: renderExerciseTemplate,
  });

  registerTool(server, {
    name: "hevy-list-routine-folders",
    title: "List Hevy routine folders",
    description: "List routine folders (paginated), or fetch one folder by passing folder_id.",
    schema: ListRoutineFoldersInputSchema,
    readOnly: true,
    run: listRoutineFolders,
    render: renderRoutineFoldersPage,
  });

  registerTool(server, {
    name: "hevy-create-routine-folder",
    title: "Create a Hevy routine folder",
    description: "Create a routine folder. There is no delete or rename via the Hevy API.",
    schema: CreateRoutineFolderInputSchema,
    readOnly: false,
    run: createRoutineFolder,
    render: renderRoutineFolder,
  });

  registerTool(server, {
    name: "hevy-list-body-measurements",
    title: "List Hevy body measurements",
    description:
      "List logged body measurements (weight in kg, body fat %, circumferences in cm). " +
      "Paginated (max 10 per page).",
    schema: ListBodyMeasurementsInputSchema,
    readOnly: true,
    run: listBodyMeasurements,
    render: (v) => renderBodyMeasurementsPage(v, getConfig().display),
  });

  registerTool(server, {
    name: "hevy-log-body-measurement",
    title: "Log a Hevy body measurement",
    description:
      "Log a body measurement for a date (weight in kg, body fat %, circumferences in cm). " +
      "Fails with a conflict if a measurement already exists for that date; " +
      "existing measurements cannot be updated through this bridge.",
    schema: LogBodyMeasurementInputSchema,
    readOnly: false,
    run: logBodyMeasurement,
    render: () => "Body measurement logged.",
  });
}

interface MaybeAuthInfo {
  authInfo?: { extra?: { upstreamAccessToken?: unknown } };
}

function extractUpstreamToken(extra: unknown): string {
  const authInfo = (extra as MaybeAuthInfo).authInfo;
  const token = authInfo?.extra?.upstreamAccessToken;
  if (typeof token !== "string" || token.length === 0) {
    throw new Error("missing upstream Hevy API key in auth context");
  }
  return token;
}

// Compose the Streamable HTTP MCP handler at /hevy, gated by withMcpAuth.
export function createHevyMcpHandler() {
  const config = getConfig();
  const rawHandler = createMcpHandler(
    (server) => {
      registerTools(server);
    },
    { serverInfo: { name: "hevy", version: "0.1.0" } },
    {
      streamableHttpEndpoint: "/hevy",
      disableSse: true,
      verboseLogs: false,
    },
  );
  return withMcpAuth(
    rawHandler,
    async (_req, bearer) => {
      if (!bearer) return undefined;
      const verified = await verifyAccessToken(bearer, config.oauth);
      if (!verified) return undefined;
      return {
        token: bearer,
        clientId: verified.clientId,
        scopes: verified.scopes,
        extra: {
          upstreamAccessToken: verified.upstreamAccessToken,
          identity: verified.identity,
        },
      };
    },
    { required: true, resourceMetadataPath: "/hevy/.well-known/oauth-protected-resource" },
  );
}

// Exported for tests.
export { registerTools, toToolResult };
