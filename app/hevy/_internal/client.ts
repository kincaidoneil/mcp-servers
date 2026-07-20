// Thin fetch wrapper for the Hevy public API (https://api.hevyapp.com/v1).
// Every method returns a discriminated HevyResult instead of throwing, and
// validates the response body with a lenient zod schema.

import type { z } from "zod";
import {
  BodyMeasurementWriteSchema,
  EmptyResponseSchema,
  ExerciseHistorySchema,
  ExerciseTemplateSchema,
  PaginatedBodyMeasurementsSchema,
  PaginatedExerciseTemplatesSchema,
  PaginatedRoutineFoldersSchema,
  PaginatedRoutinesSchema,
  PaginatedWorkoutsSchema,
  RoutineFolderSchema,
  RoutineResponseSchema,
  RoutineWriteSchema,
  UserInfoSchema,
  WorkoutCountSchema,
  WorkoutSchema,
  WorkoutWriteSchema,
} from "./schemas";

const HEVY_ORIGIN = "https://api.hevyapp.com";

export type HevyErrorCode =
  | "unauthorized"
  | "not_found"
  | "conflict"
  | "rate_limited"
  | "invalid_response"
  | "http_error"
  | "network";

export type HevyResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: HevyErrorCode; status: number | null; message: string };

export type WorkoutWrite = z.infer<typeof WorkoutWriteSchema>;
export type RoutineWrite = z.infer<typeof RoutineWriteSchema>;
export type BodyMeasurementWrite = z.infer<typeof BodyMeasurementWriteSchema>;

interface RequestOptions {
  method?: "GET" | "POST" | "PUT";
  // Path segments after /v1. Each is percent-encoded, so hostile values like
  // "../x" or "//attacker.example" cannot change the request target.
  segments: (string | number)[];
  query?: Record<string, string | number | undefined>;
  body?: unknown;
}

export function createHevyClient(apiKey: string) {
  async function request<Schema extends z.ZodType>(
    schema: Schema,
    opts: RequestOptions,
  ): Promise<HevyResult<z.infer<Schema>>> {
    const url = new URL(HEVY_ORIGIN);
    url.pathname = `/v1/${opts.segments.map((s) => encodeURIComponent(String(s))).join("/")}`;
    for (const [key, value] of Object.entries(opts.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    if (url.origin !== HEVY_ORIGIN) {
      return {
        ok: false,
        code: "network",
        status: null,
        message: "request URL escaped Hevy origin",
      };
    }

    let response: Response;
    try {
      response = await fetch(url, {
        method: opts.method ?? "GET",
        headers: {
          "api-key": apiKey,
          accept: "application/json",
          ...(opts.body !== undefined ? { "content-type": "application/json" } : {}),
        },
        ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, code: "network", status: null, message };
    }

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      const code: HevyErrorCode =
        response.status === 401
          ? "unauthorized"
          : response.status === 404
            ? "not_found"
            : response.status === 409
              ? "conflict"
              : response.status === 429
                ? "rate_limited"
                : "http_error";
      return {
        ok: false,
        code,
        status: response.status,
        message: text.slice(0, 500) || response.statusText,
      };
    }

    const text = await response.text().catch(() => "");
    let data: unknown = null;
    if (text.length > 0) {
      try {
        data = JSON.parse(text);
      } catch {
        return {
          ok: false,
          code: "invalid_response",
          status: response.status,
          message: "Hevy returned a non-JSON body",
        };
      }
    }
    const parsed = schema.safeParse(data);
    if (!parsed.success) {
      return {
        ok: false,
        code: "invalid_response",
        status: response.status,
        message: `unexpected Hevy response shape: ${parsed.error.message.slice(0, 500)}`,
      };
    }
    return { ok: true, value: parsed.data };
  }

  return {
    listWorkouts(query: { page: number; pageSize: number }) {
      return request(PaginatedWorkoutsSchema, { segments: ["workouts"], query });
    },
    getWorkout(workoutId: string) {
      return request(WorkoutSchema, { segments: ["workouts", workoutId] });
    },
    getWorkoutCount() {
      return request(WorkoutCountSchema, { segments: ["workouts", "count"] });
    },
    getExerciseHistory(
      exerciseTemplateId: string,
      query: { start_date?: string; end_date?: string },
    ) {
      return request(ExerciseHistorySchema, {
        segments: ["exercise_history", exerciseTemplateId],
        query,
      });
    },
    createWorkout(workout: WorkoutWrite) {
      return request(WorkoutSchema, {
        method: "POST",
        segments: ["workouts"],
        body: { workout },
      });
    },
    updateWorkout(workoutId: string, workout: WorkoutWrite) {
      return request(WorkoutSchema, {
        method: "PUT",
        segments: ["workouts", workoutId],
        body: { workout },
      });
    },
    listRoutines(query: { page: number; pageSize: number }) {
      return request(PaginatedRoutinesSchema, { segments: ["routines"], query });
    },
    getRoutine(routineId: string) {
      return request(RoutineResponseSchema, { segments: ["routines", routineId] });
    },
    createRoutine(routine: RoutineWrite & { folder_id?: number | null }) {
      return request(RoutineResponseSchema, {
        method: "POST",
        segments: ["routines"],
        body: { routine },
      });
    },
    updateRoutine(routineId: string, routine: RoutineWrite) {
      return request(RoutineResponseSchema, {
        method: "PUT",
        segments: ["routines", routineId],
        body: { routine },
      });
    },
    listExerciseTemplates(query: { page: number; pageSize: number }) {
      return request(PaginatedExerciseTemplatesSchema, {
        segments: ["exercise_templates"],
        query,
      });
    },
    getExerciseTemplate(exerciseTemplateId: string) {
      return request(ExerciseTemplateSchema, {
        segments: ["exercise_templates", exerciseTemplateId],
      });
    },
    listRoutineFolders(query: { page: number; pageSize: number }) {
      return request(PaginatedRoutineFoldersSchema, { segments: ["routine_folders"], query });
    },
    getRoutineFolder(folderId: number) {
      return request(RoutineFolderSchema, { segments: ["routine_folders", folderId] });
    },
    createRoutineFolder(title: string) {
      return request(RoutineFolderSchema, {
        method: "POST",
        segments: ["routine_folders"],
        body: { routine_folder: { title } },
      });
    },
    listBodyMeasurements(query: { page: number; pageSize: number }) {
      return request(PaginatedBodyMeasurementsSchema, { segments: ["body_measurements"], query });
    },
    createBodyMeasurement(measurement: BodyMeasurementWrite) {
      return request(EmptyResponseSchema, {
        method: "POST",
        segments: ["body_measurements"],
        body: measurement,
      });
    },
    getUserInfo() {
      return request(UserInfoSchema, { segments: ["user", "info"] });
    },
  };
}

export type HevyClient = ReturnType<typeof createHevyClient>;
