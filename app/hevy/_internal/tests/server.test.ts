// Drives the registered tools through a real MCP client. These tools are
// text-only by design: they render prose that costs a fraction of the raw JSON,
// so no structuredContent (and therefore no outputSchema) rides along.

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { registerTools } from "../server";
import { resetConfigCacheForTesting } from "../config";
import {
  HEVY_BASE,
  HttpResponse,
  http,
  setupHevyMockServer,
  TEST_API_KEY,
  workoutFixture,
} from "./test-helpers";

const server = setupHevyMockServer();

const AUTH: AuthInfo = {
  token: "bridge-token",
  clientId: "test-client",
  scopes: [],
  extra: { upstreamAccessToken: TEST_API_KEY },
};

beforeEach(() => {
  process.env["PUBLIC_BASE_URL"] = "https://mcp.example.com";
  process.env["JWT_SIGNING_KEY"] = Buffer.alloc(32, 7).toString("base64");
  process.env["ALLOWED_HEVY_USER_IDS"] = "9c465af3-de7d-42bc-9c7c-f0170396358b";
  resetConfigCacheForTesting();
});

afterEach(() => {
  resetConfigCacheForTesting();
});

async function connectClient() {
  const mcp = new McpServer({ name: "hevy", version: "test" });
  registerTools(mcp);

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  // The tools pull the upstream Hevy API key off the request's auth context.
  const send = clientTransport.send.bind(clientTransport);
  clientTransport.send = (message, options) => send(message, { ...options, authInfo: AUTH });

  const client = new Client({ name: "test", version: "test" });
  await Promise.all([mcp.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

describe("hevy MCP server", () => {
  test("declares no output schema on any tool", async () => {
    const client = await connectClient();
    const { tools } = await client.listTools();

    expect(tools.length).toBeGreaterThan(0);
    expect(tools.filter((t) => t.outputSchema !== undefined)).toEqual([]);
  });

  test("returns rendered text and no structured content", async () => {
    const client = await connectClient();
    server.use(
      http.get(`${HEVY_BASE}/workouts`, () =>
        HttpResponse.json({
          page: 1,
          page_count: 1,
          workouts: [workoutFixture({ id: "workout-1", title: "Morning Workout" })],
        }),
      ),
    );

    const result = await client.callTool({ name: "hevy-list-workouts", arguments: {} });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toBeUndefined();
    const text = (result.content as { type: string; text: string }[])[0]!.text;
    expect(text).toContain("Morning Workout");
    expect(text).toContain("Bench Press (Barbell)");
    // Prose, not JSON: the raw payload never appears alongside it.
    expect(text).not.toContain("weight_kg");
  });

  // hevy-save-workout replaces a workout in full, so the agent has to fetch the
  // current one first. The rendering rounds 100kg to "220.5lb" and cuts
  // start_time to local minutes, both of which would drift on the way back.
  test("keeps exact values on the reads that feed full-replace writes", async () => {
    const client = await connectClient();
    server.use(
      http.get(`${HEVY_BASE}/workouts/:id`, ({ params }) =>
        HttpResponse.json(workoutFixture({ id: params["id"] as string })),
      ),
    );

    const result = await client.callTool({
      name: "hevy-get-workout",
      arguments: { workout_id: "9c465af3-de7d-42bc-9c7c-f0170396358b" },
    });

    const text = (result.content as { type: string; text: string }[])[0]!.text;
    expect(text).toContain("220.5lb");
    expect(result.structuredContent).toMatchObject({
      start_time: "2026-07-19T12:00:00Z",
      exercises: [{ sets: [{ weight_kg: 100 }] }],
    });
  });
});
