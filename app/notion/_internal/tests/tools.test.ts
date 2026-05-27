import { describe, expect, test } from "vitest";
import { Client } from "@notionhq/client";
import { queryDataSource } from "../tools/query-data-source";
import { queryDatabaseView } from "../tools/query-database-view";
import {
  HttpResponse,
  NOTION_BASE,
  http,
  pageFixture,
  setupNotionMockServer,
} from "./test-helpers";

const server = setupNotionMockServer();

function client() {
  return new Client({ auth: "test-token" });
}

describe("notion-query-data-source", () => {
  test("queries with filter+sorts, returns rendered properties + cursor", async () => {
    let capturedBody: unknown = null;
    server.use(
      http.post(`${NOTION_BASE}/data_sources/:dsId/query`, async ({ request, params }) => {
        capturedBody = await request.json();
        expect(params["dsId"]).toBe("11111111-1111-1111-1111-111111111111");
        return HttpResponse.json({
          object: "list",
          type: "page_or_data_source",
          page_or_data_source: {},
          has_more: true,
          next_cursor: "cursor-for-page-2",
          results: [
            pageFixture({
              id: "page-1",
              title: "First entry",
              properties: {
                Tags: {
                  type: "multi_select",
                  multi_select: [{ name: "work" }, { name: "urgent" }],
                },
                Satisfaction: { type: "number", number: 4 },
              },
            }),
          ],
        });
      }),
    );

    const result = await queryDataSource(
      {
        data_source_id: "collection://11111111-1111-1111-1111-111111111111",
        filter: { property: "Tags", multi_select: { contains: "work" } },
        sorts: [{ property: "Created", direction: "descending" }],
        page_size: 10,
      },
      client(),
    );

    expect(capturedBody).toMatchObject({
      filter: { property: "Tags", multi_select: { contains: "work" } },
      sorts: [{ property: "Created", direction: "descending" }],
      page_size: 10,
    });
    expect(result.next_cursor).toBe("cursor-for-page-2");
    expect(result.has_more).toBe(true);
    expect(result.results).toHaveLength(1);
    const first = result.results[0]!;
    expect(first.id).toBe("page-1");
    expect(first.title).toBe("First entry");
    expect(first.properties).toMatchObject({
      Tags: "work, urgent",
      Satisfaction: "4",
    });
  });

  test("strips collection:// URI prefix from data_source_id", async () => {
    let capturedDsId = "";
    server.use(
      http.post(`${NOTION_BASE}/data_sources/:dsId/query`, ({ params }) => {
        capturedDsId = params["dsId"] as string;
        return HttpResponse.json({
          object: "list",
          type: "page_or_data_source",
          page_or_data_source: {},
          has_more: false,
          next_cursor: null,
          results: [],
        });
      }),
    );

    await queryDataSource({ data_source_id: "collection://abc-123" }, client());
    expect(capturedDsId).toBe("abc-123");
  });

  test("returns empty results when Notion returns none", async () => {
    server.use(
      http.post(`${NOTION_BASE}/data_sources/:dsId/query`, () =>
        HttpResponse.json({
          object: "list",
          type: "page_or_data_source",
          page_or_data_source: {},
          has_more: false,
          next_cursor: null,
          results: [],
        }),
      ),
    );

    const result = await queryDataSource({ data_source_id: "ds-1" }, client());
    expect(result.results).toEqual([]);
    expect(result.next_cursor).toBeNull();
    expect(result.has_more).toBe(false);
  });
});

describe("notion-query-database-view", () => {
  test("first call creates a view query, hydrates pages, and packs cursor", async () => {
    let createCalls = 0;
    let resultsCalls = 0;
    let deleteCalls = 0;
    const retrievedIds: string[] = [];

    server.use(
      http.post(`${NOTION_BASE}/views/:viewId/queries`, async ({ params, request }) => {
        createCalls++;
        expect(params["viewId"]).toBe("view-abc");
        const body = (await request.json()) as { page_size?: number };
        expect(body.page_size).toBe(2);
        return HttpResponse.json({
          object: "view_query",
          id: "query-xyz",
          view_id: "view-abc",
          expires_at: "2026-05-27T20:15:00.000Z",
          total_count: 2,
          next_cursor: "cursor-next",
          has_more: true,
          results: [
            { object: "page", id: "page-a" },
            { object: "page", id: "page-b" },
          ],
        });
      }),
      http.get(`${NOTION_BASE}/views/:viewId/queries/:queryId`, () => {
        resultsCalls++;
        return HttpResponse.json({ object: "list" });
      }),
      http.delete(`${NOTION_BASE}/views/:viewId/queries/:queryId`, () => {
        deleteCalls++;
        return HttpResponse.json({ deleted: true });
      }),
      http.get(`${NOTION_BASE}/pages/:pageId`, ({ params }) => {
        const pageId = params["pageId"] as string;
        retrievedIds.push(pageId);
        return HttpResponse.json(pageFixture({ id: pageId, title: `Page ${pageId}` }));
      }),
    );

    const result = await queryDatabaseView({ view_id: "view://view-abc", page_size: 2 }, client());

    expect(createCalls).toBe(1);
    expect(resultsCalls).toBe(0);
    expect(deleteCalls).toBe(0); // has_more=true, so we don't delete yet
    expect(retrievedIds.toSorted()).toEqual(["page-a", "page-b"]);
    expect(result.results.map((r) => r.id).toSorted()).toEqual(["page-a", "page-b"]);
    expect(result.results[0]?.title).toMatch(/^Page page-/);
    expect(result.next_cursor).toBeTruthy();
    expect(result.has_more).toBe(true);

    // The cursor encodes both the Notion query_id and the upstream cursor —
    // we can pass it back to get the next page.
    const unpacked = JSON.parse(Buffer.from(result.next_cursor!, "base64url").toString("utf8"));
    expect(unpacked).toEqual({ query_id: "query-xyz", start_cursor: "cursor-next" });
  });

  test("subsequent call paginates via results endpoint and DELETEs on terminal page", async () => {
    let createCalls = 0;
    let resultsCalls = 0;
    let deleteCalls = 0;

    server.use(
      http.post(`${NOTION_BASE}/views/:viewId/queries`, () => {
        createCalls++;
        return HttpResponse.json({ object: "view_query" });
      }),
      http.get(`${NOTION_BASE}/views/:viewId/queries/:queryId`, ({ params, request }) => {
        resultsCalls++;
        expect(params["queryId"]).toBe("query-xyz");
        const url = new URL(request.url);
        expect(url.searchParams.get("start_cursor")).toBe("cursor-next");
        return HttpResponse.json({
          object: "list",
          next_cursor: null,
          has_more: false,
          results: [{ object: "page", id: "page-c" }],
        });
      }),
      http.delete(`${NOTION_BASE}/views/:viewId/queries/:queryId`, ({ params }) => {
        deleteCalls++;
        expect(params["queryId"]).toBe("query-xyz");
        return HttpResponse.json({ deleted: true });
      }),
      http.get(`${NOTION_BASE}/pages/page-c`, () =>
        HttpResponse.json(pageFixture({ id: "page-c", title: "Page C" })),
      ),
    );

    const cursor = Buffer.from(
      JSON.stringify({ query_id: "query-xyz", start_cursor: "cursor-next" }),
      "utf8",
    ).toString("base64url");

    const result = await queryDatabaseView({ view_id: "view-abc", cursor }, client());

    expect(createCalls).toBe(0);
    expect(resultsCalls).toBe(1);
    // On terminal page, we fire DELETE to release the upstream cache.
    // Give it a tick to flush since it's fire-and-forget.
    await new Promise((r) => setTimeout(r, 10));
    expect(deleteCalls).toBe(1);

    expect(result.results).toHaveLength(1);
    expect(result.results[0]?.id).toBe("page-c");
    expect(result.has_more).toBe(false);
    expect(result.next_cursor).toBeNull();
  });

  test("rejects malformed cursor with a clear error", async () => {
    await expect(
      queryDatabaseView({ view_id: "view-abc", cursor: "not-base64-json" }, client()),
    ).rejects.toThrow(/cursor/);
  });
});
