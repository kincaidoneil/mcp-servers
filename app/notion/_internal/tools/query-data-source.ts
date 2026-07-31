import { z } from "zod";
import type { NotionClient } from "../client";
import { extractPageTitle, renderProperty } from "../render";

export const QueryDataSourceInputSchema = z.object({
  data_source_id: z
    .string()
    .min(1)
    .describe(
      "The Notion data source UUID. Either a raw UUID or a `collection://UUID` URI from notion-fetch.",
    ),
  filter: z
    .unknown()
    .optional()
    .describe(
      "Notion filter object — see https://developers.notion.com/reference/post-database-query-filter. Pass through unchanged.",
    ),
  sorts: z
    .array(z.unknown())
    .optional()
    .describe("Notion sorts array. e.g. [{ property: 'Date', direction: 'descending' }]."),
  page_size: z.number().int().min(1).max(100).optional(),
  start_cursor: z.string().optional(),
});

export type QueryDataSourceInput = z.infer<typeof QueryDataSourceInputSchema>;

// Declared as the tools' outputSchema, so keep the field types permissive:
// the SDK hard-fails a tool call whose structuredContent doesn't parse, and
// Notion omits url/timestamps on partial pages (we substitute "").
export const QueryResultRowSchema = z.object({
  id: z.string().describe("Notion page UUID."),
  url: z.string().describe("Notion page URL. Empty when the page is inaccessible."),
  title: z.string().describe("Rendered page title. Empty when the page has none."),
  properties: z
    .record(z.string(), z.string())
    .describe("Property name to rendered value. The title property is omitted; see `title`."),
  created_time: z.string().describe("ISO 8601 creation timestamp."),
  last_edited_time: z.string().describe("ISO 8601 last-edit timestamp."),
});

export const QueryResultSchema = z.object({
  results: z.array(QueryResultRowSchema),
  next_cursor: z
    .string()
    .nullable()
    .describe("Opaque cursor for the next page. Null when has_more is false."),
  has_more: z.boolean().describe("Whether more pages match the query."),
});

export type QueryResultRow = z.infer<typeof QueryResultRowSchema>;
export type QueryResult = z.infer<typeof QueryResultSchema>;

export async function queryDataSource(
  input: QueryDataSourceInput,
  notion: NotionClient,
): Promise<QueryResult> {
  const data_source_id = stripCollectionUri(input.data_source_id);
  const response = await notion.dataSources.query({
    data_source_id,
    ...(input.filter !== undefined ? { filter: input.filter as never } : {}),
    ...(input.sorts !== undefined ? { sorts: input.sorts as never } : {}),
    ...(input.page_size !== undefined ? { page_size: input.page_size } : {}),
    ...(input.start_cursor !== undefined ? { start_cursor: input.start_cursor } : {}),
  });

  const results: QueryResultRow[] = [];
  for (const row of response.results) {
    if (row.object !== "page") continue;
    results.push(buildResultRow(row));
  }

  return {
    results,
    next_cursor: response.next_cursor ?? null,
    has_more: response.has_more,
  };
}

export function buildResultRow(page: {
  id: string;
  url?: string;
  created_time?: string;
  last_edited_time?: string;
  properties?: Record<string, unknown>;
}): QueryResultRow {
  const properties = page.properties ?? {};
  const rendered: Record<string, string> = {};
  for (const [name, value] of Object.entries(properties)) {
    if (isTitleProperty(value)) continue; // title shows up as the page's `title` field
    rendered[name] = renderProperty(value);
  }
  return {
    id: page.id,
    url: page.url ?? "",
    title: extractPageTitle(properties),
    properties: rendered,
    created_time: page.created_time ?? "",
    last_edited_time: page.last_edited_time ?? "",
  };
}

function isTitleProperty(value: unknown): boolean {
  return !!value && typeof value === "object" && (value as { type?: unknown }).type === "title";
}

function stripCollectionUri(value: string): string {
  return value.startsWith("collection://") ? value.slice("collection://".length) : value;
}
