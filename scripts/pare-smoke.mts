// HTTP smoke test for the pare bridge. Talks Streamable HTTP to a running
// server the way a real MCP client does: lists the tool, reads the app
// resource, starts and reopens a session, and checks that no bearer token is
// needed. Stops at the first failure.
//
//   PARE_BASE_URL=http://localhost:3100 pnpm smoke:pare
//
// oxlint-disable no-console

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { z } from "zod";

const base = (process.env["PARE_BASE_URL"] ?? "http://localhost:3100").replace(/\/$/, "");
const pare = `${base}/pare`;

// ---- Reporting ---------------------------------------------------------------

class SmokeFailure extends Error {}

function fail(message: string): never {
  throw new SmokeFailure(message);
}

function expect(condition: boolean, message: string): asserts condition {
  if (!condition) fail(message);
}

let stepNumber = 0;
async function step<T>(label: string, run: () => Promise<{ detail: string; value: T }>) {
  stepNumber += 1;
  const { detail, value } = await run();
  console.log(`ok ${String(stepNumber).padStart(2)}  ${label}: ${detail}`);
  return value;
}

// ---- Tool call helpers -------------------------------------------------------

// Mirrors SESSION_ID_PATTERN in app/pare/_internal/schema.ts; node runs this
// script without a bundler, so it cannot import that module.
const SESSION_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{2,39}$/;

const Started = z.object({
  session_id: z.string().regex(SESSION_ID_PATTERN),
  total: z.number(),
  decided: z.number(),
});

type ToolResult = Awaited<ReturnType<Client["callTool"]>>;

function textOf(result: ToolResult): string {
  const content = z
    .array(z.object({ type: z.string(), text: z.string().optional() }))
    .parse(result.content ?? []);
  return content
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("\n");
}

async function callTool<T>(
  client: Client,
  name: string,
  args: Record<string, unknown>,
  schema: z.ZodType<T>,
): Promise<{ data: T; text: string }> {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) fail(`${name} returned an error: ${textOf(result)}`);
  const parsed = schema.safeParse(result.structuredContent);
  if (!parsed.success) {
    fail(`${name}: unexpected structuredContent\n${z.prettifyError(parsed.error)}`);
  }
  return { data: parsed.data, text: textOf(result) };
}

const smokeItems = [
  { id: "s1", title: "First", subtitle: "smoke" },
  { id: "s2", title: "Second", suggestion: { action: "dispose", reason: "unused" } },
  { id: "s3", title: "Third" },
];
const smokeSession = {
  title: "Smoke test",
  keep: { label: "Keep" },
  dispose: { label: "Drop" },
  items: smokeItems,
};

// ---- The flow ---------------------------------------------------------------

async function main() {
  console.log(`pare smoke against ${base}`);

  const client = new Client({ name: "pare-smoke", version: "0.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(pare));

  try {
    await step("mcp initialize + tools/list", async () => {
      await client.connect(transport);
      const { tools } = await client.listTools();
      expect(
        tools.length === 1 && tools[0]?.name === "pare-start",
        `expected exactly pare-start, got ${tools.map((t) => t.name).join(", ") || "(none)"}`,
      );
      const Ui = z.object({ ui: z.object({ resourceUri: z.string() }) });
      // oxlint-disable-next-line no-underscore-dangle
      const meta = Ui.safeParse(tools[0]._meta);
      expect(
        meta.success && meta.data.ui.resourceUri === "ui://pare/app.html",
        "pare-start lacks _meta.ui.resourceUri",
      );
      const serverName = client.getServerVersion()?.name;
      return { detail: `server "${serverName}", 1 tool`, value: undefined };
    });

    await step("resources/read ui://pare/app.html", async () => {
      const { contents } = await client.readResource({ uri: "ui://pare/app.html" });
      expect(contents.length === 1, `expected one content item, got ${contents.length}`);
      const item = contents[0]!;
      expect(
        item.mimeType === "text/html;profile=mcp-app",
        `mimeType is ${item.mimeType ?? "(none)"}`,
      );
      expect("text" in item, "resource content is a blob, expected text");
      expect(/^<!doctype html>/i.test(item.text), "HTML does not start with <!doctype html>");
      const kb = Math.round(item.text.length / 1024);
      expect(item.text.length > 100 * 1024, `HTML is only ${kb} KB, expected more than 100 KB`);
      return { detail: `${item.mimeType}, ${kb} KB`, value: undefined };
    });

    const sessionId = await step("pare-start (new session)", async () => {
      const { data, text } = await callTool(client, "pare-start", smokeSession, Started);
      expect(data.total === 3, `total is ${data.total}`);
      expect(data.decided === 0, `decided is ${data.decided}, expected 0`);
      expect(text.includes(data.session_id), "text does not mention the session id");
      return { detail: `session ${data.session_id}, ${data.total} items`, value: data.session_id };
    });

    await step("pare-start (reopen with a decision)", async () => {
      const { data } = await callTool(
        client,
        "pare-start",
        {
          ...smokeSession,
          session_id: sessionId,
          decisions: [{ item_id: "s2", action: "dispose", decided_at: new Date().toISOString() }],
        },
        Started,
      );
      expect(data.session_id === sessionId, `reopened as ${data.session_id}, not ${sessionId}`);
      expect(data.decided === 1, `decided is ${data.decided}, expected 1`);
      return { detail: `same id, ${data.decided} of ${data.total} decided`, value: undefined };
    });

    await step("pare-start (duplicate item id)", async () => {
      const result = await client.callTool({
        name: "pare-start",
        arguments: {
          title: "Dupes",
          items: [
            { id: "a", title: "One" },
            { id: "a", title: "Two" },
          ],
        },
      });
      expect(result.isError === true, "duplicate item ids were accepted");
      const text = textOf(result);
      expect(/duplicate/i.test(text), `error does not mention duplicate:\n${text}`);
      const line =
        text
          .split("\n")
          .find((l) => /duplicate/i.test(l))
          ?.trim() ?? "";
      return { detail: line, value: undefined };
    });
  } finally {
    await client.close().catch(() => undefined);
  }

  await step("unauthenticated POST /pare", async () => {
    const res = await fetch(pare, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "pare-smoke-raw", version: "0.0.0" },
        },
      }),
    });
    expect(res.status === 200 || res.status === 202, `returned ${res.status}, expected 200/202`);
    await res.body?.cancel();
    return { detail: `${res.status} with no bearer token`, value: undefined };
  });

  console.log("all steps passed");
}

main().catch((err: unknown) => {
  if (err instanceof SmokeFailure) {
    console.error(`FAIL step ${stepNumber}: ${err.message}`);
  } else {
    console.error(`FAIL step ${stepNumber}:`, err);
  }
  process.exit(1);
});
