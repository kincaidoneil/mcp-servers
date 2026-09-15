// The one pare tool. It opens the app with a session; everything after that
// happens between the app and the model (context updates, a final message).

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import { z } from "zod";
import {
  buildSession,
  StartInputBaseSchema,
  StartInputSchema,
  StartResultSchema,
  type StartResult,
} from "./schema";

export const APP_RESOURCE_URI = "ui://pare/app.html";

// What the model reads when it is choosing a tool. It has to stand on its
// own: the server instructions beside it are a hint a host MAY pass on, and
// many will not.
const START_DESCRIPTION =
  "Let the user answer the same question about many things, one card at a time, instead of " +
  "asking them item by item in the chat. Use it whenever a task comes down to the same quick " +
  "call repeated over more than about five things: which newsletters to unsubscribe from, " +
  "which tasks to drop, which files to archive, which bugs are worth fixing, which candidates " +
  "to advance, which of two dozen photos make the album. Any per-item choice with a small " +
  "fixed set of answers works. The two sides are whatever this task's two answers are (Keep " +
  "and Cut, Ship and Hold, Mine and Not mine), and extra_actions adds up to four more " +
  "buckets. Not for a single item, not where each one needs research before it can be " +
  "answered, and not for rankings or anything needing a written answer. Every card needs " +
  "enough on it to decide in a few seconds, since it never expands. Put your recommendation " +
  "in suggestion; the user decides. Up to 500 items, and one session beats several. After " +
  "every decision the app puts the whole list of decisions in your context; when the user " +
  "finishes, they arrive here as a message. Wait for them rather than asking in the chat.";

// No 0/o, 1/l/i so an id read aloud or retyped survives.
const ID_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
const ID_LENGTH = 12;

export function newSessionId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(ID_LENGTH));
  let id = "";
  for (const byte of bytes) id += ID_ALPHABET[byte % ID_ALPHABET.length];
  return id;
}

type ToolResult =
  | { content: { type: "text"; text: string }[]; structuredContent: Record<string, unknown> }
  | { content: { type: "text"; text: string }[]; isError: true };

function ok(text: string, structuredContent: Record<string, unknown>): ToolResult {
  return { content: [{ type: "text", text }], structuredContent };
}

function fail(text: string): ToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

export function registerTools(server: McpServer) {
  registerAppTool(
    server,
    "pare-start",
    {
      title: "Sort a list, one card at a time",
      description: START_DESCRIPTION,
      inputSchema: StartInputBaseSchema.shape,
      outputSchema: StartResultSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      _meta: { ui: { resourceUri: APP_RESOURCE_URI } },
    },
    async (input) => {
      // The SDK validated the shape; the refinements (unique ids, known
      // actions, decisions that name real items) only run here.
      const parsed = StartInputSchema.safeParse(input);
      if (!parsed.success) {
        return fail(`Invalid pare-start input:\n${z.prettifyError(parsed.error)}`);
      }
      const sessionId = parsed.data.session_id ?? newSessionId();
      const session = buildSession(parsed.data, sessionId, new Date().toISOString());
      const result: StartResult = {
        session_id: sessionId,
        title: session.config.title,
        total: session.config.items.length,
        decided: Object.keys(session.decisions).length,
      };
      return ok(
        `Opened pare session ${sessionId} "${result.title}": ${result.total} items, ` +
          `${result.decided} already decided. The user is triaging in the app. After every ` +
          "decision the app updates your context with the full list so far; when the user " +
          "finishes, the decisions arrive here as a message. To reopen this session later, " +
          `call pare-start again with the same items, session_id "${sessionId}", and the ` +
          "decisions from the latest context update. Do not ask for decisions item by item.",
        result,
      );
    },
  );
}
