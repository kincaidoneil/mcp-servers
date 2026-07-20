import { createMcpHandler } from "mcp-handler";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { extractUpstreamToken, protectMcpHandler } from "@/lib/oauth-as";
import { getConfig } from "./config";
import { createNotionClient } from "./client";
import { QueryDataSourceInputSchema, queryDataSource } from "./tools/query-data-source";
import { QueryDatabaseViewInputSchema, queryDatabaseView } from "./tools/query-database-view";

function registerTools(server: McpServer) {
  server.registerTool(
    "notion-query-data-source",
    {
      title: "Query Notion data source",
      description:
        "Query a Notion database (data source) with optional filter, sorts, and pagination. " +
        "Returns pages with their properties rendered as readable strings. " +
        "Use this for 'show me my last 10 entries' or any structured query that the " +
        "official notion-search can't express (semantic ranking is the wrong tool there).",
      inputSchema: QueryDataSourceInputSchema.shape,
      annotations: {
        title: "Query Notion data source",
        readOnlyHint: true,
        openWorldHint: true,
      },
    },
    async (input, extra) => {
      const upstreamToken = extractUpstreamToken(extra, "Notion access token");
      const notion = createNotionClient(upstreamToken);
      const result = await queryDataSource(input, notion);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        structuredContent: result as unknown as { [k: string]: unknown },
      };
    },
  );

  server.registerTool(
    "notion-query-database-view",
    {
      title: "Query Notion database view",
      description:
        "Query a saved Notion database view, applying its pre-configured filter and sort. " +
        "Use this when the user references a view by name (e.g. 'In Progress'). " +
        "Discover view IDs via the official notion-fetch on the parent database. " +
        "Pagination handled transparently — pass back next_cursor to get the next page.",
      inputSchema: QueryDatabaseViewInputSchema.shape,
      annotations: {
        title: "Query Notion database view",
        readOnlyHint: true,
        openWorldHint: true,
      },
    },
    async (input, extra) => {
      const upstreamToken = extractUpstreamToken(extra, "Notion access token");
      const notion = createNotionClient(upstreamToken);
      const result = await queryDatabaseView(input, notion);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        structuredContent: result as unknown as { [k: string]: unknown },
      };
    },
  );
}

// Compose the Streamable HTTP MCP handler at /notion, gated by withMcpAuth.
export function createNotionMcpHandler() {
  const rawHandler = createMcpHandler(
    (server) => {
      registerTools(server);
    },
    { serverInfo: { name: "notion-query", version: "0.1.0" } },
    {
      streamableHttpEndpoint: "/notion",
      disableSse: true,
      verboseLogs: false,
    },
  );
  return protectMcpHandler(rawHandler, "/notion", () => getConfig().oauth);
}
