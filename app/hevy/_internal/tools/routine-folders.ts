import { z } from "zod";
import type { HevyClient } from "../client";
import { PageSchema, PageSize10Schema, RoutineFolderIdSchema } from "../schemas";

export const ListRoutineFoldersInputSchema = z.object({
  page: PageSchema,
  pageSize: PageSize10Schema,
  folder_id: RoutineFolderIdSchema.optional().describe(
    "Pass a folder id to fetch just that folder instead of a page of folders.",
  ),
});

export function listRoutineFolders(
  input: z.infer<typeof ListRoutineFoldersInputSchema>,
  client: HevyClient,
) {
  if (input.folder_id !== undefined) return client.getRoutineFolder(input.folder_id);
  return client.listRoutineFolders({ page: input.page, pageSize: input.pageSize });
}

export const CreateRoutineFolderInputSchema = z.object({
  title: z.string().min(1).describe("Folder title."),
});

export function createRoutineFolder(
  input: z.infer<typeof CreateRoutineFolderInputSchema>,
  client: HevyClient,
) {
  return client.createRoutineFolder(input.title);
}
