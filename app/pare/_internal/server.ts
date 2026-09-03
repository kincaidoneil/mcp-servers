import { readFile } from "node:fs/promises";
import { createMcpHandler } from "mcp-handler";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerAppResource, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { protectMcpHandler } from "@/lib/oauth-as";
import { getConfig } from "./config";
import { APP_RESOURCE_URI, registerTools } from "./tools";

// The built app is one self-contained HTML file (vite-plugin-singlefile).
// Read once per process; the file only changes with a deploy.
let htmlCache: string | null = null;

async function readAppHtml(): Promise<string> {
  if (htmlCache !== null) return htmlCache;
  const htmlPath = getConfig().ui.htmlPath;
  try {
    htmlCache = await readFile(htmlPath, "utf8");
  } catch (err) {
    throw new Error(`pare app HTML not found at ${htmlPath}; run \`pnpm ui:build\` first`, {
      cause: err,
    });
  }
  return htmlCache;
}

export function resetHtmlCacheForTesting() {
  htmlCache = null;
}

export function registerResource(server: McpServer) {
  registerAppResource(
    server,
    "Pare",
    APP_RESOURCE_URI,
    {
      description: "Card-stack triage UI for pare sessions.",
      _meta: { ui: { prefersBorder: false } },
    },
    async () => ({
      // Hosts read `_meta.ui` from the content item first and the listing
      // second, so both carry it.
      contents: [
        {
          uri: APP_RESOURCE_URI,
          mimeType: RESOURCE_MIME_TYPE,
          text: await readAppHtml(),
          _meta: { ui: { prefersBorder: false } },
        },
      ],
    }),
  );
}

export function registerPare(server: McpServer) {
  registerTools(server);
  registerResource(server);
}

// Compose the Streamable HTTP MCP handler at /pare, gated by withMcpAuth.
export function createPareMcpHandler() {
  const rawHandler = createMcpHandler(
    (server) => {
      registerPare(server);
    },
    { serverInfo: { name: "pare", version: "0.1.0" } },
    {
      streamableHttpEndpoint: "/pare",
      disableSse: true,
      verboseLogs: false,
    },
  );
  return protectMcpHandler(rawHandler, "/pare", () => getConfig().oauth);
}
