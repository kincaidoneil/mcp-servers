import { z } from "zod";
import type { NotionClient } from "../client";
import { buildResultRow, type QueryResult, type QueryResultRow } from "./query-data-source";

export const QueryDatabaseViewInputSchema = z.object({
  view_id: z
    .string()
    .min(1)
    .describe("The Notion view UUID. Either a raw UUID or a `view://UUID` URI from notion-fetch."),
  page_size: z.number().int().min(1).max(100).optional(),
  cursor: z
    .string()
    .optional()
    .describe("Pass next_cursor from the previous response to paginate. Opaque to the caller."),
});

export type QueryDatabaseViewInput = z.infer<typeof QueryDatabaseViewInputSchema>;

export async function queryDatabaseView(
  input: QueryDatabaseViewInput,
  notion: NotionClient,
): Promise<QueryResult> {
  const view_id = stripViewUri(input.view_id);

  let queryId: string;
  let pageIds: string[];
  let nextCursor: string | null;
  let hasMore: boolean;

  if (input.cursor === undefined) {
    // First call → create the cached query.
    const created = await notion.views.queries.create({
      view_id,
      ...(input.page_size !== undefined ? { page_size: input.page_size } : {}),
    });
    queryId = created.id;
    pageIds = created.results.map((r) => r.id);
    nextCursor = created.next_cursor ?? null;
    hasMore = created.has_more;
  } else {
    // Subsequent call → paginate the existing query.
    const cursor = decodeCursor(input.cursor);
    queryId = cursor.query_id;
    const page = await notion.views.queries.results({
      view_id,
      query_id: cursor.query_id,
      start_cursor: cursor.start_cursor,
      ...(input.page_size !== undefined ? { page_size: input.page_size } : {}),
    });
    pageIds = page.results.map((r) => r.id);
    nextCursor = (page.next_cursor as string | null) ?? null;
    hasMore = page.has_more;
  }

  const results = await hydratePages(pageIds, notion);

  if (!hasMore) {
    // Fire-and-forget the upstream DELETE to release Notion's cache.
    notion.views.queries.delete({ view_id, query_id: queryId }).catch(() => {
      // We don't care if it fails; Notion will GC after 15 min anyway.
    });
  }

  return {
    results,
    next_cursor: hasMore ? encodeCursor({ query_id: queryId, start_cursor: nextCursor }) : null,
    has_more: hasMore,
  };
}

async function hydratePages(ids: string[], notion: NotionClient): Promise<QueryResultRow[]> {
  const pages = await Promise.all(
    ids.map(async (id) => {
      const page = await notion.pages.retrieve({ page_id: id });
      if (!("properties" in page)) {
        // Partial response (e.g., page in trash or insufficient permission)
        return {
          id: page.id,
          url: "",
          title: "",
          properties: {},
          created_time: "",
          last_edited_time: "",
        };
      }
      return buildResultRow(page);
    }),
  );
  return pages;
}

interface CursorPayload {
  query_id: string;
  start_cursor: string | null;
}

function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function decodeCursor(cursor: string): { query_id: string; start_cursor: string } {
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw new Error(`cursor is not valid base64-url-encoded JSON: ${cursor.slice(0, 32)}…`);
  }
  if (
    !decoded ||
    typeof decoded !== "object" ||
    typeof (decoded as { query_id?: unknown }).query_id !== "string" ||
    typeof (decoded as { start_cursor?: unknown }).start_cursor !== "string"
  ) {
    throw new Error("cursor payload is missing query_id or start_cursor");
  }
  return decoded as { query_id: string; start_cursor: string };
}

function stripViewUri(value: string): string {
  return value.startsWith("view://") ? value.slice("view://".length) : value;
}
