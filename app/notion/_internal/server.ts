import { createMcpHandler, withMcpAuth } from "mcp-handler";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { verifyAccessToken } from "@/lib/oauth-as";
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
      const upstreamToken = extractUpstreamToken(extra);
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
      const upstreamToken = extractUpstreamToken(extra);
      const notion = createNotionClient(upstreamToken);
      const result = await queryDatabaseView(input, notion);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        structuredContent: result as unknown as { [k: string]: unknown },
      };
    },
  );
}

interface MaybeAuthInfo {
  authInfo?: { extra?: { upstreamAccessToken?: unknown } };
}

function extractUpstreamToken(extra: unknown): string {
  const authInfo = (extra as MaybeAuthInfo).authInfo;
  const token = authInfo?.extra?.upstreamAccessToken;
  if (typeof token !== "string" || token.length === 0) {
    throw new Error("missing upstream Notion access token in auth context");
  }
  return token;
}

// Compose the Streamable HTTP MCP handler at /notion, gated by withMcpAuth.
export function createNotionMcpHandler() {
  const config = getConfig();
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
  return withMcpAuth(
    rawHandler,
    async (_req, bearer) => {
      if (!bearer) return undefined;
      const verified = await verifyAccessToken(bearer, config.oauth);
      if (!verified) return undefined;
      return {
        token: bearer,
        clientId: verified.clientId,
        scopes: verified.scopes,
        extra: {
          upstreamAccessToken: verified.upstreamAccessToken,
          identity: verified.identity,
        },
      };
    },
    { required: true, resourceMetadataPath: "/notion/.well-known/oauth-protected-resource" },
  );
}
