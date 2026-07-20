import { z } from "zod";
import type { HevyClient } from "../client";
import {
  ExerciseTemplateIdSchema,
  PageSchema,
  PageSize10Schema,
  WorkoutIdSchema,
  WorkoutWriteSchema,
} from "../schemas";

export const ListWorkoutsInputSchema = z.object({
  page: PageSchema,
  pageSize: PageSize10Schema,
});

export function listWorkouts(input: z.infer<typeof ListWorkoutsInputSchema>, client: HevyClient) {
  return client.listWorkouts(input);
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
  return workout_id ? client.updateWorkout(workout_id, workout) : client.createWorkout(workout);
}
