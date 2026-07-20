import { z } from "zod";
import type { HevyClient } from "../client";
import { ExerciseTemplateIdSchema, PageSchema, PageSize100Schema } from "../schemas";

export const ListExerciseTemplatesInputSchema = z.object({
  page: PageSchema,
  pageSize: PageSize100Schema,
});

export function listExerciseTemplates(
  input: z.infer<typeof ListExerciseTemplatesInputSchema>,
  client: HevyClient,
) {
  return client.listExerciseTemplates(input);
}

export const GetExerciseTemplateInputSchema = z.object({
  exercise_template_id: ExerciseTemplateIdSchema,
});

export function getExerciseTemplate(
  input: z.infer<typeof GetExerciseTemplateInputSchema>,
  client: HevyClient,
) {
  return client.getExerciseTemplate(input.exercise_template_id);
}
