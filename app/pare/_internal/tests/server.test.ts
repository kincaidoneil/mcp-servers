// Drives the pare tools and resource through a real MCP client with the
// in-memory store, the way the app and the model reach them in production.

import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { resetConfigCacheForTesting } from "../config";
import { registerPare, resetHtmlCacheForTesting } from "../server";
import { resetStoreForTesting } from "../store";
import type { GetResultsResult, LoadResult, StartResult } from "../schema";

beforeEach(() => {
  process.env["PUBLIC_BASE_URL"] = "https://mcp.example.com";
  process.env["JWT_SIGNING_KEY"] = Buffer.alloc(32, 7).toString("base64");
  process.env["PARE_ACCESS_CODES"] = "kincaid:secret-a,guest:secret-b";
  delete process.env["UPSTASH_REDIS_REST_URL"];
  delete process.env["UPSTASH_REDIS_REST_TOKEN"];
  delete process.env["KV_REST_API_URL"];
  delete process.env["KV_REST_API_TOKEN"];
  delete process.env["PARE_UI_HTML_PATH"];
  resetConfigCacheForTesting();
  resetStoreForTesting();
  resetHtmlCacheForTesting();
});

afterEach(() => {
  resetConfigCacheForTesting();
  resetStoreForTesting();
  resetHtmlCacheForTesting();
});

function authFor(user: string): AuthInfo {
  return {
    token: "bridge-token",
    clientId: "test-client",
    scopes: [],
    extra: { upstreamAccessToken: "unused", identity: { user } },
  };
}

// One McpServer per client so two identities can share the module-level store.
async function connectClient(user = "kincaid") {
  const mcp = new McpServer({ name: "pare", version: "test" });
  registerPare(mcp);

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const send = clientTransport.send.bind(clientTransport);
  const authInfo = authFor(user);
  clientTransport.send = (message, options) => send(message, { ...options, authInfo });

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
  extra_actions: [{ id: "snooze", label: "Snooze", key: "s" }],
  items: [
    { id: "n1", title: "Morning Brew", subtitle: "crew@morningbrew.com" },
    { id: "n2", title: "The Hustle", suggestion: { action: "dispose", reason: "unopened" } },
    { id: "n3", title: "Stratechery" },
    { id: "n4", title: "Money Stuff" },
  ],
};

async function startSession(client: Client) {
  const started = await client.callTool({ name: "pare-start", arguments: newsletters });
  expect(started.isError).toBeFalsy();
  return started.structuredContent as StartResult;
}

describe("pare MCP server", () => {
  test("runs a session from start through record to results", async () => {
    const client = await connectClient();

    const { tools } = await client.listTools();
    const byName = new Map(tools.map((t) => [t.name, t]));
    expect([...byName.keys()].toSorted()).toEqual([
      "pare-get-results",
      "pare-list-sessions",
      "pare-load",
      "pare-record",
      "pare-resume",
      "pare-start",
    ]);
    expect(byName.get("pare-start")).toMatchObject({
      _meta: { ui: { resourceUri: "ui://pare/app.html" } },
    });
    for (const name of ["pare-load", "pare-record"]) {
      expect(byName.get(name)).toMatchObject({
        _meta: { ui: { resourceUri: "ui://pare/app.html", visibility: ["app"] } },
      });
    }
    expect(tools.every((t) => t.outputSchema !== undefined)).toBe(true);

    const started = await client.callTool({ name: "pare-start", arguments: newsletters });
    expect(started.isError).toBeFalsy();
    const { session_id } = started.structuredContent as StartResult;
    expect(session_id).toMatch(/^[abcdefghjkmnpqrstuvwxyz23456789]{12}$/);
    expect(started.structuredContent).toEqual({
      session_id,
      title: "Newsletter subscriptions",
      total: 4,
    });
    expect(textOf(started)).toContain(`Opened pare session ${session_id}`);

    const loaded = await client.callTool({ name: "pare-load", arguments: { session_id } });
    const { session } = loaded.structuredContent as LoadResult;
    expect(session.owner).toBe("kincaid");
    expect(session.version).toBe(0);
    expect(session.queue).toEqual(["n1", "n2", "n3", "n4"]);
    expect(session.config.notes).toBe(true);

    const decidedAt = "2026-09-03T10:00:00.000Z";
    const recorded = await client.callTool({
      name: "pare-record",
      arguments: {
        session_id,
        decisions: [
          { item_id: "n1", action: "dispose", decided_at: decidedAt },
          {
            item_id: "n2",
            action: "keep",
            note: "keep the Sunday edition only",
            decided_at: decidedAt,
          },
          { item_id: "n3", action: "snooze", decided_at: decidedAt },
        ],
      },
    });
    expect(recorded.isError).toBeFalsy();
    expect(recorded.structuredContent).toEqual({
      version: 1,
      decided: 3,
      total: 4,
      status: "open",
    });

    // Undo n3 and put it behind n4 (a skip). The stale n1 in the queue is a
    // decided item, so the server drops it.
    const undone = await client.callTool({
      name: "pare-record",
      arguments: { session_id, undo: ["n3"], queue: ["n4", "n3", "n1"] },
    });
    expect(undone.structuredContent).toEqual({
      version: 2,
      decided: 2,
      total: 4,
      status: "open",
    });

    const reloaded = await client.callTool({ name: "pare-load", arguments: { session_id } });
    const after = (reloaded.structuredContent as LoadResult).session;
    expect(after.version).toBe(2);
    expect(after.queue).toEqual(["n4", "n3"]);
    expect(Object.keys(after.decisions).toSorted()).toEqual(["n1", "n2"]);

    const results = await client.callTool({ name: "pare-get-results", arguments: { session_id } });
    expect(results.structuredContent).toMatchObject({
      session_id,
      status: "open",
      total: 4,
      decided: 2,
      counts: { dispose: 1, keep: 1 },
      undecided: [
        { item_id: "n4", title: "Money Stuff" },
        { item_id: "n3", title: "Stratechery" },
      ],
    } satisfies Partial<GetResultsResult>);
    expect(textOf(results)).toBe(
      [
        "Newsletter subscriptions: 2 of 4 decided, session open",
        "Unsubscribe (1): Morning Brew",
        "Stay subscribed (1): The Hustle",
        "Notes:",
        '- The Hustle: "keep the Sunday edition only"',
        "Undecided (2): Money Stuff; Stratechery",
      ].join("\n"),
    );

    const done = await client.callTool({
      name: "pare-record",
      arguments: { session_id, status: "done" },
    });
    expect(done.structuredContent).toMatchObject({ version: 3, status: "done" });

    const resumed = await client.callTool({ name: "pare-resume", arguments: { session_id } });
    expect(resumed.structuredContent).toEqual({
      session_id,
      title: "Newsletter subscriptions",
      total: 4,
      decided: 2,
      status: "done",
    });

    const listed = await client.callTool({ name: "pare-list-sessions", arguments: {} });
    expect(listed.structuredContent).toMatchObject({
      sessions: [{ id: session_id, title: "Newsletter subscriptions", decided: 2, total: 4 }],
    });
    expect(textOf(listed)).toContain(session_id);
    expect(textOf(listed)).toContain("2/4");
  });

  test("keeps sessions private to their owner", async () => {
    const kincaid = await connectClient("kincaid");
    const guest = await connectClient("guest");
    const { session_id } = await startSession(kincaid);

    const denied = await Promise.all(
      ["pare-load", "pare-get-results", "pare-resume"].map((name) =>
        guest.callTool({ name, arguments: { session_id } }),
      ),
    );
    for (const result of denied) {
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain(session_id);
    }
    const listed = await guest.callTool({ name: "pare-list-sessions", arguments: {} });
    expect(listed.structuredContent).toEqual({ sessions: [] });
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

  test("revokes a user removed from PARE_ACCESS_CODES", async () => {
    const client = await connectClient();
    const { session_id } = await startSession(client);

    process.env["PARE_ACCESS_CODES"] = "guest:secret-b";
    resetConfigCacheForTesting();

    const result = await client.callTool({ name: "pare-get-results", arguments: { session_id } });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe("access revoked; reconnect the pare MCP server");
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
