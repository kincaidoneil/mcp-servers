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

const START_DESCRIPTION =
  "Open a card-stack triage session in the pare app for many small keep-or-dispose " +
  "decisions: which newsletters to unsubscribe from, which tasks to delete, which files to " +
  "archive. Each item is one card. Give every card a short title, a subtitle for the source " +
  "(sender, project, folder), and a body with enough context to decide in a few seconds; use " +
  "meta for facts like 'Last opened: 14 months ago'. Set the keep and dispose labels to the " +
  "concrete verbs for this task ('Stay subscribed' / 'Unsubscribe'). Add extra_actions only " +
  "when the task has a third bucket (Snooze, Delegate, Later). Put your recommendation in " +
  "suggestion with a one-line reason; the user decides. Up to 500 items; batch a large list " +
  "into one session rather than several. After every decision the app updates your context " +
  "with the session_id and the full list of decisions so far; when the user finishes, the " +
  "decisions arrive in the chat as a message. Nothing is stored on the server: to reopen a " +
  "session later, call pare-start again with the same items, the session_id, and the " +
  "decisions from the latest context update. Do not re-ask decisions in chat.";

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
      title: "Start or reopen a pare triage session",
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
