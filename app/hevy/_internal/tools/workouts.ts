import { z } from "zod";
import type { HevyClient, HevyResult } from "../client";
import { resolveRangeBound } from "../render";
import {
  ExerciseTemplateIdSchema,
  PageSchema,
  PageSize10Schema,
  normalizeSupersetId,
  type PaginatedWorkoutsSchema,
  type Workout,
  WorkoutIdSchema,
  type WorkoutsRangeResult,
  WorkoutWriteSchema,
} from "../schemas";

// The workouts endpoint caps pageSize at 10. A date-ranged query aggregates
// pages server-side; cap the scan at 10 pages (100 workouts) so an open-ended
// range can't fan out unbounded, and flag truncation when we hit it.
const RANGE_PAGE_SIZE = 10;
const MAX_RANGE_PAGES = 10;

// Accept a calendar date (2026-06-01) or a full ISO 8601 timestamp.
const RangeBoundSchema = z.union([z.iso.datetime(), z.iso.date()]);

export const ListWorkoutsInputSchema = z.object({
  page: PageSchema,
  pageSize: PageSize10Schema,
  since: RangeBoundSchema.optional().describe(
    "Only include workouts starting on or after this point. Accepts a calendar date " +
      "(2026-06-01, interpreted in the account's display timezone) or an ISO 8601 " +
      "timestamp. Setting since or until filters across pages server-side instead of " +
      "returning one raw page.",
  ),
  until: RangeBoundSchema.optional().describe(
    "Only include workouts starting on or before this point (inclusive). A bare date " +
      "covers the whole day; an ISO 8601 timestamp is exact.",
  ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .describe(
      "Max workouts to return when filtering (since/until) or fetching the newest N " +
        "across pages. Up to 100.",
    ),
});

type ListWorkoutsInput = z.infer<typeof ListWorkoutsInputSchema>;
type ListWorkoutsValue = z.infer<typeof PaginatedWorkoutsSchema> | WorkoutsRangeResult;

export function listWorkouts(
  input: ListWorkoutsInput,
  client: HevyClient,
  timeZone = "UTC",
): Promise<HevyResult<ListWorkoutsValue>> {
  const rangeMode =
    input.since !== undefined || input.until !== undefined || input.limit !== undefined;
  if (!rangeMode) {
    return client.listWorkouts({ page: input.page, pageSize: input.pageSize });
  }
  return listWorkoutsRange(input, client, timeZone);
}

// Walk pages newest-first, keeping workouts whose start_time falls in [since,
// until]. Filtering decides which workouts to keep; the newest-first order only
// drives the early exit (once a whole page sits before `since`, no older page
// can match). Both are defensive: a bad timestamp is skipped, not fatal.
async function listWorkoutsRange(
  input: ListWorkoutsInput,
  client: HevyClient,
  timeZone: string,
): Promise<HevyResult<WorkoutsRangeResult>> {
  const since = input.since ? resolveRangeBound(input.since, "start", timeZone) : undefined;
  const until = input.until ? resolveRangeBound(input.until, "end", timeZone) : undefined;
  const workouts: Workout[] = [];
  let scanned = 0;

  const done = (truncated: boolean): HevyResult<WorkoutsRangeResult> => ({
    ok: true,
    value: { workouts, since: input.since ?? null, until: input.until ?? null, scanned, truncated },
  });

  for (let page = 1; page <= MAX_RANGE_PAGES; page++) {
    // Sequential by necessity: each page's early-exit decision depends on the
    // previous page's data, so these can't be fetched in parallel.
    // oxlint-disable-next-line no-await-in-loop
    const res = await client.listWorkouts({ page, pageSize: RANGE_PAGE_SIZE });
    if (!res.ok) return res;
    const batch = res.value.workouts;
    scanned += batch.length;

    let sawSinceOrNewer = false;
    for (const w of batch) {
      const t = w.start_time ? Date.parse(w.start_time) : Number.NaN;
      if (Number.isNaN(t)) continue;
      if (since !== undefined && t < since) continue;
      sawSinceOrNewer = true;
      if (until !== undefined && t > until) continue;
      workouts.push(w);
      if (input.limit !== undefined && workouts.length >= input.limit) return done(false);
    }

    if (page >= res.value.page_count) return done(false);
    // Newest-first early exit: nothing on this page reached `since`, so no
    // older page can either.
    if (since !== undefined && batch.length > 0 && !sawSinceOrNewer) return done(false);
  }
  return done(true);
}

export const GetWorkoutInputSchema = z.object({
  workout_id: WorkoutIdSchema,
});

export function getWorkout(input: z.infer<typeof GetWorkoutInputSchema>, client: HevyClient) {
  return client.getWorkout(input.workout_id);
}

export const GetWorkoutCountInputSchema = z.object({});

export function getWorkoutCount(
  _input: z.infer<typeof GetWorkoutCountInputSchema>,
  client: HevyClient,
) {
  return client.getWorkoutCount();
}

export const GetExerciseHistoryInputSchema = z.object({
  exercise_template_id: ExerciseTemplateIdSchema,
  start_date: z.iso
    .datetime()
    .optional()
    .describe("Only include sets on or after this ISO 8601 timestamp."),
  end_date: z.iso
    .datetime()
    .optional()
    .describe("Only include sets on or before this ISO 8601 timestamp."),
});

export function getExerciseHistory(
  input: z.infer<typeof GetExerciseHistoryInputSchema>,
  client: HevyClient,
) {
  return client.getExerciseHistory(input.exercise_template_id, {
    start_date: input.start_date,
    end_date: input.end_date,
  });
}

export const SaveWorkoutInputSchema = z.object({
  workout_id: WorkoutIdSchema.optional().describe(
    "Omit to log a new workout. Pass an existing workout's UUID to update it — " +
      "the update replaces the workout in full (including the exercise list), so fetch it " +
      "first and send the complete updated version.",
  ),
  ...WorkoutWriteSchema.shape,
});

export function saveWorkout(input: z.infer<typeof SaveWorkoutInputSchema>, client: HevyClient) {
  const { workout_id, ...workout } = input;
  const body = { ...workout, exercises: workout.exercises.map(normalizeSupersetId) };
  return workout_id ? client.updateWorkout(workout_id, body) : client.createWorkout(body);
}
