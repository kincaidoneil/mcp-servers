import { readFile } from "node:fs/promises";
import { createMcpHandler } from "mcp-handler";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerAppResource, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
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

// A hint hosts MAY put in the system prompt. Standing policy rather than
// documentation: the tool's own description says what it is and how to call
// it, and has to work on its own, because plenty of hosts drop this.
const INSTRUCTIONS =
  "pare hands the user a stack of cards and lets them answer one question at a time, " +
  "instead of being asked about item after item in the chat.\n\n" +
  "Notice the shape, not the words. Any time you are about to put a list in front of someone " +
  "and ask which ones — which to keep, which to cut, which to approve, which bucket each " +
  "belongs in — that is what this is for, and it is worth offering before you start " +
  "enumerating. The same goes in the middle of a task, when work you are already doing turns " +
  "out to need their call on each of many things.\n\n" +
  "Offer it, do not insist: a short list is often faster in the chat. And do not use it to " +
  "hand back decisions that are yours to make. It is for the ones that are genuinely theirs: " +
  "taste, priorities, risk, and the things only they know.";

// The Streamable HTTP MCP handler at /pare. Public: pare holds no state and
// needs no identity.
export function createPareMcpHandler() {
  return createMcpHandler(
    (server) => {
      registerPare(server);
    },
    { serverInfo: { name: "pare", version: "0.1.0" }, instructions: INSTRUCTIONS },
    {
      streamableHttpEndpoint: "/pare",
      disableSse: true,
      verboseLogs: false,
    },
  );
}
