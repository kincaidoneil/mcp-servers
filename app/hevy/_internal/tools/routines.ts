import { z } from "zod";
import type { HevyClient } from "../client";
import {
  PageSchema,
  PageSize10Schema,
  RoutineFolderIdSchema,
  RoutineIdSchema,
  RoutineWriteSchema,
} from "../schemas";

export const ListRoutinesInputSchema = z.object({
  page: PageSchema,
  pageSize: PageSize10Schema,
});

export function listRoutines(input: z.infer<typeof ListRoutinesInputSchema>, client: HevyClient) {
  return client.listRoutines(input);
}

export const GetRoutineInputSchema = z.object({
  routine_id: RoutineIdSchema,
});

export function getRoutine(input: z.infer<typeof GetRoutineInputSchema>, client: HevyClient) {
  return client.getRoutine(input.routine_id);
}

export const SaveRoutineInputSchema = z.object({
  routine_id: RoutineIdSchema.optional().describe(
    "Omit to create a new routine. Pass an existing routine's UUID to update it — " +
      "the update replaces the routine in full (including the exercise list), so fetch it " +
      "first and send the complete updated version.",
  ),
  folder_id: RoutineFolderIdSchema.nullable()
    .optional()
    .describe(
      "Folder to create the routine in (create only; ignored on update). " +
        'Null or omitted puts it in the default "My Routines" folder.',
    ),
  ...RoutineWriteSchema.shape,
});

export function saveRoutine(input: z.infer<typeof SaveRoutineInputSchema>, client: HevyClient) {
  const { routine_id, folder_id, ...routine } = input;
  return routine_id
    ? client.updateRoutine(routine_id, routine)
    : client.createRoutine({ ...routine, folder_id: folder_id ?? null });
}
