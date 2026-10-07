// The MCP Events contract this server offers (draft spec as implemented by
// ChatGPT: https://developers.openai.com/plugins/build/mcp-events). The zod
// schemas here are the single source for both validation and the JSON Schema
// that events/list advertises.

import { z } from "zod";

export const WORKOUT_COMPLETED = "workout.completed";

export const SourceSchema = z.enum(["hevy", "intervals"]);
export type Source = z.infer<typeof SourceSchema>;

export const SubscriptionArgumentsSchema = z.strictObject({
  sources: z
    .array(SourceSchema)
    .min(1)
    .refine((s) => new Set(s).size === s.length, "sources must not repeat")
    .optional()
    .describe("Only deliver workouts from these sources. Omit to receive both."),
});
export type SubscriptionArguments = z.infer<typeof SubscriptionArgumentsSchema>;

export const WorkoutCompletedSchema = z.strictObject({
  source: SourceSchema.describe(
    "hevy for logged strength workouts; intervals for activities synced to Intervals.icu (runs, rides, and anything else from the watch).",
  ),
  workout_id: z
    .string()
    .describe(
      "Hevy workout UUID or Intervals activity id. Pass it to get-hevy-workout or get-intervals-activity for more detail.",
    ),
  title: z.string(),
  sport: z
    .string()
    .describe('Intervals activity type (e.g. "Run", "Ride"), or "Strength" for Hevy.'),
  start_time: z.string().describe("ISO 8601, UTC."),
  duration_seconds: z.number().nullable(),
  url: z.string().describe("Where the user can open this workout."),
  summary: z
    .string()
    .describe(
      "Plain-text rendering of the workout: exercises and sets for Hevy; distance, pace, heart rate, power, training load, and intervals for Intervals.",
    ),
});
export type WorkoutCompleted = z.infer<typeof WorkoutCompletedSchema>;

export interface McpEvent {
  eventId: string;
  name: typeof WORKOUT_COMPLETED;
  timestamp: string;
  data: WorkoutCompleted;
  // workout.completed has no replay.
  cursor: null;
}

export function eventDefinitions() {
  return [
    {
      name: WORKOUT_COMPLETED,
      description:
        "A workout was finished: a strength session logged in Hevy, or an activity (run, ride, swim, and so on) uploaded to Intervals.icu and analyzed. Fires once per workout.",
      delivery: ["webhook"],
      inputSchema: z.toJSONSchema(SubscriptionArgumentsSchema, { io: "input" }),
      payloadSchema: z.toJSONSchema(WorkoutCompletedSchema),
    },
  ];
}

// JSON-RPC params. Envelope fields (_meta) pass through untouched.

export const ListEventsParamsSchema = z.looseObject({ cursor: z.string().optional() });

export const SubscribeParamsSchema = z.looseObject({
  name: z.string(),
  arguments: z.record(z.string(), z.unknown()).optional(),
  delivery: z.looseObject({
    mode: z.literal("webhook"),
    url: z.string(),
    secret: z.string(),
  }),
  cursor: z.string().nullable().optional(),
  // Omitted: server default. null: the client asks for no expiry.
  ttlMs: z.number().int().positive().nullable().optional(),
});
export type SubscribeParams = z.infer<typeof SubscribeParamsSchema>;

export const UnsubscribeParamsSchema = z.looseObject({
  name: z.string(),
  arguments: z.record(z.string(), z.unknown()).optional(),
  delivery: z.looseObject({ mode: z.literal("webhook"), url: z.string() }),
});
export type UnsubscribeParams = z.infer<typeof UnsubscribeParamsSchema>;

export const SubscribeResultSchema = z.looseObject({
  id: z.string(),
  refreshBefore: z.string().nullable(),
  cursor: z.null(),
  truncated: z.boolean(),
});

// JSON-RPC error code the spec assigns to callback verification failures.
export const CALLBACK_ENDPOINT_ERROR = -32015;
