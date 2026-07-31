// Drives the registered tools through a real MCP client. Declaring an
// outputSchema makes structuredContent mandatory and validated on both ends, so
// a shape mismatch fails the call outright — this is what catches that.

import { describe, expect, test } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { registerTools } from "../server";
import {
  HttpResponse,
  NOTION_BASE,
  http,
  pageFixture,
  setupNotionMockServer,
} from "./test-helpers";

const server = setupNotionMockServer();

const AUTH: AuthInfo = {
  token: "bridge-token",
  clientId: "test-client",
  scopes: [],
  extra: { upstreamAccessToken: "notion-token" },
};

async function connectClient() {
  const mcp = new McpServer({ name: "notion-query", version: "test" });
  registerTools(mcp);

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  // The tools pull the upstream Notion token off the request's auth context.
  const send = clientTransport.send.bind(clientTransport);
  clientTransport.send = (message, options) => send(message, { ...options, authInfo: AUTH });

  const client = new Client({ name: "test", version: "test" });
  await Promise.all([mcp.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

function mockQueryResponse() {
  server.use(
    http.post(`${NOTION_BASE}/data_sources/:dsId/query`, () =>
      HttpResponse.json({
        object: "list",
        type: "page_or_data_source",
        page_or_data_source: {},
        has_more: false,
        next_cursor: null,
        results: [
          pageFixture({
            id: "page-1",
            title: "First entry",
            properties: { Satisfaction: { type: "number", number: 4 } },
          }),
        ],
      }),
    ),
  );
}

describe("notion MCP server", () => {
  test("advertises an output schema on both tools", async () => {
    const client = await connectClient();
    const { tools } = await client.listTools();

    expect(tools.map((t) => t.name).toSorted()).toEqual([
      "notion-query-data-source",
      "notion-query-database-view",
    ]);
    for (const tool of tools) {
      expect(tool.outputSchema).toMatchObject({
        type: "object",
        required: ["results", "next_cursor", "has_more"],
      });
    }
  });

  test("returns structured content that validates against the declared schema", async () => {
    const client = await connectClient();
    await client.listTools(); // caches the client-side output validator
    mockQueryResponse();

    const result = await client.callTool({
      name: "notion-query-data-source",
      arguments: { data_source_id: "11111111-1111-1111-1111-111111111111" },
    });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      has_more: false,
      next_cursor: null,
      results: [{ id: "page-1", title: "First entry", properties: { Satisfaction: "4" } }],
    });
    // The text block is the compat copy: same payload, serialized compactly.
    const text = (result.content as { type: string; text: string }[])[0]!.text;
    expect(JSON.parse(text)).toEqual(result.structuredContent);
    expect(text).not.toContain("\n");
  });
});
