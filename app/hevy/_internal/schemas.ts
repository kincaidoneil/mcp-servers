// Zod schemas shared by the Hevy client and tools. Response schemas are
// lenient: they validate only the fields we consume, so additive upstream
// changes don't break the bridge. Input schemas are strict because their
// values flow into request bodies and URL paths.

import { z } from "zod";

// ---- ID and date formats (inputs that end up in URL paths) ----

// Workouts and routines use UUIDs. Exercise templates use short codes like
// "D04AC939". Folder ids are integers.
export const WorkoutIdSchema = z.uuid().describe("Workout UUID.");
export const RoutineIdSchema = z.uuid().describe("Routine UUID.");
export const ExerciseTemplateIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,64}$/)
  .describe('Exercise template id, a short code like "D04AC939".');
export const RoutineFolderIdSchema = z.number().int().positive().describe("Routine folder id.");
export const MeasurementDateSchema = z.iso.date().describe("Calendar date in YYYY-MM-DD format.");

// ---- Pagination ----

export const PageSchema = z.number().int().min(1).default(1).describe("1-based page number.");
// Most Hevy list endpoints cap pageSize at 10; exercise templates allow 100.
export const PageSize10Schema = z
  .number()
  .int()
  .min(1)
  .max(10)
  .default(10)
  .describe("Items per page (max 10).");
export const PageSize100Schema = z
  .number()
  .int()
  .min(1)
  .max(100)
  .default(100)
  .describe("Items per page (max 100).");

// ---- Write inputs: workouts ----

export const SetTypeSchema = z
  .enum(["warmup", "normal", "failure", "dropset"])
  .describe("Set type.");

const setMetricFields = {
  weight_kg: z
    .number()
    .nullable()
    .optional()
    .describe("Weight in kilograms. The Hevy API is metric-only; convert lb to kg first."),
  reps: z.number().int().nullable().optional().describe("Number of repetitions."),
  distance_meters: z.number().int().nullable().optional().describe("Distance in meters."),
  duration_seconds: z.number().int().nullable().optional().describe("Duration in seconds."),
  custom_metric: z
    .number()
    .nullable()
    .optional()
    .describe("Custom metric, currently used for steps and floors."),
};

export const WorkoutSetInputSchema = z.object({
  type: SetTypeSchema.default("normal"),
  ...setMetricFields,
  rpe: z
    .number()
    .nullable()
    .optional()
    .describe("Rating of Perceived Exertion. Allowed values: 6, 7, 7.5, 8, 8.5, 9, 9.5, 10."),
});

export const WorkoutExerciseInputSchema = z.object({
  exercise_template_id: ExerciseTemplateIdSchema.describe(
    "Exercise template id from hevy-list-exercise-templates.",
  ),
  superset_id: z
    .number()
    .int()
    .nullable()
    .optional()
    .describe("Superset id, or null when the exercise is not part of a superset."),
  supersets_id: z
    .number()
    .int()
    .nullable()
    .optional()
    .describe(
      "Read-side alias of superset_id. The list/get tools return supersets_id; accepting " +
        "it here lets a fetched workout or routine round-trip through save without losing " +
        "its supersets. Prefer superset_id.",
    ),
  notes: z.string().nullable().optional().describe("Notes on the exercise."),
  sets: z.array(WorkoutSetInputSchema).min(1).describe("Sets in order."),
});

export const WorkoutWriteSchema = z.object({
  title: z.string().min(1).describe("Workout title."),
  description: z.string().nullable().optional().describe("Workout description."),
  start_time: z.iso
    .datetime()
    .describe("ISO 8601 timestamp of when the workout started, e.g. 2026-07-20T12:00:00Z."),
  end_time: z.iso.datetime().describe("ISO 8601 timestamp of when the workout ended."),
  is_private: z.boolean().optional().describe("Whether the workout is private."),
  exercises: z.array(WorkoutExerciseInputSchema).min(1).describe("Exercises in order."),
});

// ---- Write inputs: routines ----

export const RoutineSetInputSchema = z.object({
  type: SetTypeSchema.default("normal"),
  ...setMetricFields,
  rep_range: z
    .object({
      start: z.number().int().describe("Starting rep count."),
      end: z.number().int().describe("Ending rep count."),
    })
    .nullable()
    .optional()
    .describe("Target rep range for the set, e.g. { start: 8, end: 12 }."),
});

export const RoutineExerciseInputSchema = z.object({
  exercise_template_id: ExerciseTemplateIdSchema.describe(
    "Exercise template id from hevy-list-exercise-templates.",
  ),
  superset_id: z
    .number()
    .int()
    .nullable()
    .optional()
    .describe("Superset id, or null when the exercise is not part of a superset."),
  supersets_id: z
    .number()
    .int()
    .nullable()
    .optional()
    .describe(
      "Read-side alias of superset_id. The list/get tools return supersets_id; accepting " +
        "it here lets a fetched workout or routine round-trip through save without losing " +
        "its supersets. Prefer superset_id.",
    ),
  rest_seconds: z
    .number()
    .int()
    .nullable()
    .optional()
    .describe("Rest time in seconds between sets."),
  notes: z.string().nullable().optional().describe("Notes on the exercise."),
  sets: z.array(RoutineSetInputSchema).min(1).describe("Sets in order."),
});

export const RoutineWriteSchema = z.object({
  title: z.string().min(1).describe("Routine title."),
  notes: z.string().nullable().optional().describe("Notes for the routine."),
  exercises: z.array(RoutineExerciseInputSchema).min(1).describe("Exercises in order."),
});

// The Hevy write API expects superset_id, but reads return supersets_id (see the
// alias on the exercise input schemas). Collapse the two into the single
// superset_id the API wants, so a fetched exercise saves back with its superset
// intact. Runs on the parsed input just before the request body is built.
export function normalizeSupersetId<
  E extends { superset_id?: number | null; supersets_id?: number | null },
>(exercise: E): Omit<E, "supersets_id"> {
  const { supersets_id, ...rest } = exercise;
  return { ...rest, superset_id: rest.superset_id ?? supersets_id ?? null };
}

// ---- Write inputs: body measurements ----

const bodyMetricFields = {
  weight_kg: z.number().nullable().optional().describe("Body weight in kilograms."),
  lean_mass_kg: z.number().nullable().optional().describe("Lean mass in kilograms."),
  fat_percent: z.number().nullable().optional().describe("Body fat percentage."),
  neck_cm: z.number().nullable().optional().describe("Neck circumference in cm."),
  shoulder_cm: z.number().nullable().optional().describe("Shoulder circumference in cm."),
  chest_cm: z.number().nullable().optional().describe("Chest circumference in cm."),
  left_bicep_cm: z.number().nullable().optional().describe("Left bicep circumference in cm."),
  right_bicep_cm: z.number().nullable().optional().describe("Right bicep circumference in cm."),
  left_forearm_cm: z.number().nullable().optional().describe("Left forearm circumference in cm."),
  right_forearm_cm: z.number().nullable().optional().describe("Right forearm circumference in cm."),
  abdomen: z.number().nullable().optional().describe("Abdomen circumference in cm."),
  waist: z.number().nullable().optional().describe("Waist circumference in cm."),
  hips: z.number().nullable().optional().describe("Hip circumference in cm."),
  left_thigh: z.number().nullable().optional().describe("Left thigh circumference in cm."),
  right_thigh: z.number().nullable().optional().describe("Right thigh circumference in cm."),
  left_calf: z.number().nullable().optional().describe("Left calf circumference in cm."),
  right_calf: z.number().nullable().optional().describe("Right calf circumference in cm."),
};

export const BodyMeasurementWriteSchema = z.object({
  date: MeasurementDateSchema,
  ...bodyMetricFields,
});

// ---- Response schemas ----

export const SetSchema = z.object({
  index: z.number().optional(),
  type: z.string().optional(),
  weight_kg: z.number().nullable().optional(),
  reps: z.number().nullable().optional(),
  distance_meters: z.number().nullable().optional(),
  duration_seconds: z.number().nullable().optional(),
  rpe: z.number().nullable().optional(),
  custom_metric: z.number().nullable().optional(),
});

// Routine responses (unlike workout responses) carry target rep_range on each
// set. Keep it so reads render the range and a fetched routine round-trips
// through hevy-save-routine without losing its programming.
export const RoutineSetSchema = SetSchema.extend({
  rep_range: z
    .object({
      start: z.number().nullable().optional(),
      end: z.number().nullable().optional(),
    })
    .nullable()
    .optional(),
});

export const WorkoutSchema = z.object({
  id: z.string(),
  title: z.string(),
  routine_id: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  start_time: z.string().optional(),
  end_time: z.string().optional(),
  created_at: z.string().optional(),
  updated_at: z.string().optional(),
  exercises: z
    .array(
      z.object({
        index: z.number().optional(),
        title: z.string().optional(),
        notes: z.string().nullable().optional(),
        exercise_template_id: z.string().optional(),
        supersets_id: z.number().nullable().optional(),
        sets: z.array(SetSchema).optional(),
      }),
    )
    .optional(),
});
export type Workout = z.infer<typeof WorkoutSchema>;

export const PaginatedWorkoutsSchema = z.object({
  page: z.number(),
  page_count: z.number(),
  workouts: z.array(WorkoutSchema),
});

// Server-synthesized result of a date-ranged workout query. listWorkouts
// aggregates across API pages and filters by start_time; this is the shape the
// range renderer and structuredContent see. It has no page_count, which is how
// the renderer tells it apart from a raw paginated page.
export interface WorkoutsRangeResult {
  workouts: Workout[];
  since: string | null;
  until: string | null;
  scanned: number;
  truncated: boolean;
}

export const WorkoutCountSchema = z.object({
  workout_count: z.number(),
});

export const ExerciseHistoryEntrySchema = z.object({
  workout_id: z.string().optional(),
  workout_title: z.string().optional(),
  workout_start_time: z.string().optional(),
  workout_end_time: z.string().optional(),
  exercise_template_id: z.string().optional(),
  weight_kg: z.number().nullable().optional(),
  reps: z.number().nullable().optional(),
  distance_meters: z.number().nullable().optional(),
  duration_seconds: z.number().nullable().optional(),
  rpe: z.number().nullable().optional(),
  custom_metric: z.number().nullable().optional(),
  set_type: z.string().optional(),
});

export const ExerciseHistorySchema = z.object({
  exercise_history: z.array(ExerciseHistoryEntrySchema),
});

export const RoutineSchema = z.object({
  id: z.string(),
  title: z.string(),
  folder_id: z.number().nullable().optional(),
  created_at: z.string().optional(),
  updated_at: z.string().optional(),
  exercises: z
    .array(
      z.object({
        index: z.number().optional(),
        title: z.string().optional(),
        rest_seconds: z.union([z.number(), z.string()]).nullable().optional(),
        notes: z.string().nullable().optional(),
        exercise_template_id: z.string().optional(),
        supersets_id: z.number().nullable().optional(),
        sets: z.array(RoutineSetSchema).optional(),
      }),
    )
    .optional(),
});
export type Routine = z.infer<typeof RoutineSchema>;

// GET /v1/routines/{id} wraps the routine in a { routine } envelope; POST and
// PUT return it bare. Accept both and normalize to the bare routine.
export const RoutineResponseSchema = z.union([
  z.object({ routine: RoutineSchema }).transform((r) => r.routine),
  RoutineSchema,
]);

export const PaginatedRoutinesSchema = z.object({
  page: z.number(),
  page_count: z.number(),
  routines: z.array(RoutineSchema),
});

export const ExerciseTemplateSchema = z.object({
  id: z.string(),
  title: z.string(),
  type: z.string().optional(),
  primary_muscle_group: z.string().optional(),
  secondary_muscle_groups: z.array(z.string()).optional(),
  equipment_category: z.string().optional(),
  is_custom: z.boolean().optional(),
});
export type ExerciseTemplate = z.infer<typeof ExerciseTemplateSchema>;

export const PaginatedExerciseTemplatesSchema = z.object({
  page: z.number(),
  page_count: z.number(),
  exercise_templates: z.array(ExerciseTemplateSchema),
});

export const RoutineFolderSchema = z.object({
  id: z.number(),
  index: z.number().optional(),
  title: z.string(),
  created_at: z.string().optional(),
  updated_at: z.string().optional(),
});
export type RoutineFolder = z.infer<typeof RoutineFolderSchema>;

export const PaginatedRoutineFoldersSchema = z.object({
  page: z.number(),
  page_count: z.number(),
  routine_folders: z.array(RoutineFolderSchema),
});

export const BodyMeasurementSchema = z.object({
  date: z.string(),
  weight_kg: z.number().nullable().optional(),
  lean_mass_kg: z.number().nullable().optional(),
  fat_percent: z.number().nullable().optional(),
  neck_cm: z.number().nullable().optional(),
  shoulder_cm: z.number().nullable().optional(),
  chest_cm: z.number().nullable().optional(),
  left_bicep_cm: z.number().nullable().optional(),
  right_bicep_cm: z.number().nullable().optional(),
  left_forearm_cm: z.number().nullable().optional(),
  right_forearm_cm: z.number().nullable().optional(),
  abdomen: z.number().nullable().optional(),
  waist: z.number().nullable().optional(),
  hips: z.number().nullable().optional(),
  left_thigh: z.number().nullable().optional(),
  right_thigh: z.number().nullable().optional(),
  left_calf: z.number().nullable().optional(),
  right_calf: z.number().nullable().optional(),
});
export type BodyMeasurement = z.infer<typeof BodyMeasurementSchema>;

export const PaginatedBodyMeasurementsSchema = z.object({
  page: z.number(),
  page_count: z.number(),
  body_measurements: z.array(BodyMeasurementSchema),
});

export const UserInfoSchema = z.object({
  data: z.object({
    id: z.string(),
    name: z.string().optional(),
    url: z.string().optional(),
  }),
});
export type UserInfo = z.infer<typeof UserInfoSchema>;

// POST /v1/body_measurements returns an empty body on success.
export const EmptyResponseSchema = z.unknown();
