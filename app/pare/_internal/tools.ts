// The six pare tools. Four face the model (start, resume, get-results,
// list-sessions); two are called only by the app (load, record).

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import { z } from "zod";
import { extractIdentity } from "@/lib/oauth-as";
import { getConfig } from "./config";
import { renderResults, renderSessionList } from "./render";
import {
  applyRecord,
  GetResultsInputSchema,
  GetResultsResultSchema,
  ListSessionsInputSchema,
  ListSessionsResultSchema,
  LoadInputSchema,
  LoadResultSchema,
  RecordInputSchema,
  RecordResultSchema,
  ResumeInputSchema,
  ResumeResultSchema,
  StartInputSchema,
  StartResultSchema,
  summarize,
  toResults,
  type GetResultsResult,
  type LoadResult,
  type RecordResult,
  type ResumeResult,
  type Session,
  type StartResult,
} from "./schema";
import { getStore, newSessionId } from "./store";

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
  "into one session rather than several. The user's decisions arrive in the chat as a message " +
  "when they finish; call pare-get-results to read progress before then. Do not re-ask " +
  "decisions in chat.";

type ToolResult =
  | { content: { type: "text"; text: string }[]; structuredContent: Record<string, unknown> }
  | { content: { type: "text"; text: string }[]; isError: true };

function ok(text: string, structuredContent: Record<string, unknown>): ToolResult {
  return { content: [{ type: "text", text }], structuredContent };
}

function fail(text: string): ToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

// The consent flow embeds the access-code owner's name as identity.user.
export function ownerFrom(extra: unknown): string {
  const user = extractIdentity(extra)["user"];
  if (typeof user !== "string" || user.length === 0) {
    throw new Error("missing identity.user in auth context");
  }
  return user;
}

// Every handler goes through here so a name removed from PARE_ACCESS_CODES
// loses access immediately, even while its tokens are still valid.
async function withOwner(
  extra: unknown,
  run: (owner: string) => Promise<ToolResult>,
): Promise<ToolResult> {
  const owner = ownerFrom(extra);
  if (!getConfig().accessCodes.has(owner)) {
    return fail("access revoked; reconnect the pare MCP server");
  }
  return run(owner);
}

async function withSession(
  extra: unknown,
  sessionId: string,
  run: (session: Session) => Promise<ToolResult>,
): Promise<ToolResult> {
  return withOwner(extra, async (owner) => {
    const session = await getStore().get(owner, sessionId);
    if (!session) return fail(`No pare session ${sessionId} for this user.`);
    return run(session);
  });
}

export function registerTools(server: McpServer) {
  registerAppTool(
    server,
    "pare-start",
    {
      title: "Start a pare triage session",
      description: START_DESCRIPTION,
      inputSchema: StartInputSchema.shape,
      outputSchema: StartResultSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      _meta: { ui: { resourceUri: APP_RESOURCE_URI } },
    },
    (input, extra) =>
      withOwner(extra, async (owner) => {
        // The SDK validated the shape; the refinements (unique ids, known
        // suggestion actions) only run here.
        const parsed = StartInputSchema.safeParse(input);
        if (!parsed.success) {
          return fail(`Invalid pare-start input:\n${z.prettifyError(parsed.error)}`);
        }
        const config = parsed.data;
        const now = new Date().toISOString();
        const session: Session = {
          id: newSessionId(),
          owner,
          created_at: now,
          updated_at: now,
          version: 0,
          status: "open",
          config,
          decisions: {},
          queue: config.items.map((item) => item.id),
        };
        await getStore().put(session);
        const result: StartResult = {
          session_id: session.id,
          title: config.title,
          total: config.items.length,
        };
        return ok(
          `Opened pare session ${session.id} "${config.title}" with ${result.total} items. ` +
            "The user is triaging in the app now. Their decisions arrive in this chat as a " +
            "message when they finish, and pare-get-results returns progress at any time. " +
            "Do not ask the user for decisions item by item; wait for the app.",
          result,
        );
      }),
  );

  registerAppTool(
    server,
    "pare-resume",
    {
      title: "Resume a pare session",
      description:
        "Reopen an existing pare session in the app so the user can continue where they " +
        "left off. Find ids with pare-list-sessions.",
      inputSchema: ResumeInputSchema.shape,
      outputSchema: ResumeResultSchema.shape,
      annotations: { readOnlyHint: true, openWorldHint: false },
      _meta: { ui: { resourceUri: APP_RESOURCE_URI } },
    },
    (input, extra) =>
      withSession(extra, input.session_id, async (session) => {
        const summary = summarize(session);
        const result: ResumeResult = {
          session_id: session.id,
          title: summary.title,
          total: summary.total,
          decided: summary.decided,
          status: summary.status,
        };
        return ok(
          `Resumed pare session ${session.id} "${summary.title}": ${summary.decided} of ` +
            `${summary.total} decided, session ${summary.status}. The user continues in the app.`,
          result,
        );
      }),
  );

  server.registerTool(
    "pare-get-results",
    {
      title: "Get pare session results",
      description:
        "Read the decisions recorded so far in a pare session, grouped by action, with any " +
        "notes the user left and the items still undecided. Works while the session is open " +
        "and after the user finishes.",
      inputSchema: GetResultsInputSchema.shape,
      outputSchema: GetResultsResultSchema.shape,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (input, extra) =>
      withSession(extra, input.session_id, async (session) => {
        const results: GetResultsResult = toResults(session);
        return ok(renderResults(results), results);
      }),
  );

  server.registerTool(
    "pare-list-sessions",
    {
      title: "List pare sessions",
      description:
        "List this user's recent pare sessions, newest first, with progress and status. " +
        "Use the id with pare-resume or pare-get-results.",
      inputSchema: ListSessionsInputSchema.shape,
      outputSchema: ListSessionsResultSchema.shape,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (input, extra) =>
      withOwner(extra, async (owner) => {
        const sessions = await getStore().list(owner, input.limit);
        return ok(renderSessionList(sessions), { sessions });
      }),
  );

  registerAppTool(
    server,
    "pare-load",
    {
      title: "Load a pare session (app)",
      description: "Load the full session, including saved decisions, for the pare app.",
      inputSchema: LoadInputSchema.shape,
      outputSchema: LoadResultSchema.shape,
      annotations: { readOnlyHint: true, openWorldHint: false },
      _meta: { ui: { resourceUri: APP_RESOURCE_URI, visibility: ["app"] } },
    },
    (input, extra) =>
      withSession(extra, input.session_id, async (session) => {
        const summary = summarize(session);
        const result: LoadResult = { session };
        return ok(
          `Loaded pare session ${session.id}: ${summary.decided} of ${summary.total} decided.`,
          result,
        );
      }),
  );

  registerAppTool(
    server,
    "pare-record",
    {
      title: "Record pare decisions (app)",
      description: "Save a batch of decisions, undos, queue order, and status from the pare app.",
      inputSchema: RecordInputSchema.shape,
      outputSchema: RecordResultSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      _meta: { ui: { resourceUri: APP_RESOURCE_URI, visibility: ["app"] } },
    },
    (input, extra) =>
      withSession(extra, input.session_id, async (session) => {
        const updated = applyRecord(
          session,
          RecordInputSchema.parse(input),
          new Date().toISOString(),
        );
        await getStore().put(updated);
        const summary = summarize(updated);
        const result: RecordResult = {
          version: updated.version,
          decided: summary.decided,
          total: summary.total,
          status: updated.status,
        };
        return ok(
          `Recorded: ${summary.decided} of ${summary.total} decided, version ` +
            `${updated.version}, session ${updated.status}.`,
          result,
        );
      }),
  );
}
