// Drives the pare tool and resource through a real MCP client, the way the
// model and the host reach them in production.

import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { resetConfigCacheForTesting } from "../config";
import { registerPare, resetHtmlCacheForTesting } from "../server";
import { SESSION_ID_PATTERN, type StartResult } from "../schema";

beforeEach(() => {
  delete process.env["PARE_UI_HTML_PATH"];
  resetConfigCacheForTesting();
  resetHtmlCacheForTesting();
});

afterEach(() => {
  resetConfigCacheForTesting();
  resetHtmlCacheForTesting();
});

async function connectClient() {
  const mcp = new McpServer({ name: "pare", version: "test" });
  registerPare(mcp);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "test" });
  await Promise.all([mcp.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

function textOf(result: Awaited<ReturnType<Client["callTool"]>>): string {
  return (result.content as { type: string; text: string }[])[0]!.text;
}

const newsletters = {
  title: "Newsletter subscriptions",
  keep: { label: "Stay subscribed" },
  dispose: { label: "Unsubscribe" },
  extra_actions: [{ id: "snooze", label: "Snooze" }],
  items: [
    { id: "n1", title: "Morning Brew", subtitle: "crew@morningbrew.com" },
    { id: "n2", title: "The Hustle", suggestion: { action: "dispose", reason: "unopened" } },
    { id: "n3", title: "Stratechery" },
  ],
};

describe("pare MCP server", () => {
  test("advertises one app tool and starts or continues a session", async () => {
    const client = await connectClient();

    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(["pare-start"]);
    expect(tools[0]).toMatchObject({
      _meta: { ui: { resourceUri: "ui://pare/app.html" } },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    });
    expect(tools[0]!.outputSchema).toBeDefined();

    const started = await client.callTool({ name: "pare-start", arguments: newsletters });
    expect(started.isError).toBeFalsy();
    const { session_id } = started.structuredContent as StartResult;
    expect(session_id).toMatch(/^[abcdefghjkmnpqrstuvwxyz23456789]{12}$/);
    expect(session_id).toMatch(SESSION_ID_PATTERN);
    expect(started.structuredContent).toEqual({
      session_id,
      title: "Newsletter subscriptions",
      total: 3,
      decided: 0,
    });
    expect(textOf(started)).toContain(`Opened pare session ${session_id}`);
    expect(textOf(started)).toContain("session_id");

    // Reopening: the model passes the id and the decisions from its context.
    const continued = await client.callTool({
      name: "pare-start",
      arguments: {
        ...newsletters,
        session_id,
        decisions: [{ item_id: "n2", action: "dispose", decided_at: "2026-09-03T10:00:00.000Z" }],
      },
    });
    expect(continued.isError).toBeFalsy();
    expect(continued.structuredContent).toEqual({
      session_id,
      title: "Newsletter subscriptions",
      total: 3,
      decided: 1,
    });
    expect(textOf(continued)).toContain("1 already decided");
  });

  test("rejects invalid start input with a readable message", async () => {
    const client = await connectClient();

    const duplicate = await client.callTool({
      name: "pare-start",
      arguments: {
        title: "Dupes",
        items: [
          { id: "a", title: "One" },
          { id: "a", title: "Two" },
        ],
      },
    });
    expect(duplicate.isError).toBe(true);
    expect(textOf(duplicate)).toContain("duplicate item id a");

    const unknownItem = await client.callTool({
      name: "pare-start",
      arguments: {
        title: "Stale decision",
        session_id: "abc123",
        items: [{ id: "a", title: "One" }],
        decisions: [{ item_id: "zzz", action: "keep", decided_at: "2026-09-03T10:00:00.000Z" }],
      },
    });
    expect(unknownItem.isError).toBe(true);
    expect(textOf(unknownItem)).toContain("no item with id zzz");

    const unknownAction = await client.callTool({
      name: "pare-start",
      arguments: {
        title: "Bad suggestion",
        items: [{ id: "a", title: "One", suggestion: { action: "later" } }],
      },
    });
    expect(unknownAction.isError).toBe(true);
    expect(textOf(unknownAction)).toContain("unknown action later");

    // The 500-item cap is on the shape, so the SDK rejects it before the handler.
    const items = Array.from({ length: 501 }, (_, i) => ({ id: `i${i}`, title: `Item ${i}` }));
    const tooMany = await client.callTool({
      name: "pare-start",
      arguments: { title: "Too many", items },
    });
    expect(tooMany.isError).toBe(true);
    expect(textOf(tooMany)).toMatch(/<=500 items/);
  });

  test("serves the built app HTML as the ui resource", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "pare-ui-"));
    const htmlPath = path.join(dir, "index.html");
    await writeFile(htmlPath, "<!doctype html><title>pare</title>");
    process.env["PARE_UI_HTML_PATH"] = htmlPath;
    resetConfigCacheForTesting();

    const client = await connectClient();
    const { resources } = await client.listResources();
    expect(resources).toMatchObject([
      { uri: "ui://pare/app.html", _meta: { ui: { prefersBorder: false } } },
    ]);

    // The SDK copies the resource's _meta onto every content item.
    const read = await client.readResource({ uri: "ui://pare/app.html" });
    expect(read.contents).toEqual([
      {
        uri: "ui://pare/app.html",
        mimeType: "text/html;profile=mcp-app",
        text: "<!doctype html><title>pare</title>",
        _meta: { ui: { prefersBorder: false } },
      },
    ]);
  });

  test("explains how to build the app when the HTML is missing", async () => {
    process.env["PARE_UI_HTML_PATH"] = path.join(os.tmpdir(), "pare-missing", "index.html");
    resetConfigCacheForTesting();

    const client = await connectClient();
    await expect(client.readResource({ uri: "ui://pare/app.html" })).rejects.toThrow(
      /pnpm ui:build/,
    );
  });
});
