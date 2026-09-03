// Everything the app asks of the MCP host, behind one interface so the UI
// never touches the `App` protocol object directly and the harness can be
// swapped in for tests.

import type { App, McpUiDisplayMode, McpUiHostContext } from "@modelcontextprotocol/ext-apps";
import type { z } from "zod";
import {
  LoadResultSchema,
  RecordResultSchema,
  type RecordInput,
  type RecordResult,
  type Session,
} from "../../schema";

export type HostResult<T> = { ok: true; value: T } | { ok: false; message: string };

export interface HostBridge {
  loadSession(sessionId: string): Promise<HostResult<Session>>;
  record(input: RecordInput): Promise<HostResult<RecordResult>>;
  sendMessage(text: string): Promise<HostResult<void>>;
  // Best effort: hosts without the capability are skipped silently.
  updateModelContext(text: string, structured?: Record<string, unknown>): Promise<void>;
  openLink(url: string): Promise<void>;
  requestDisplayMode(mode: McpUiDisplayMode): Promise<McpUiDisplayMode>;
  context(): McpUiHostContext | undefined;
  canSendMessage(): boolean;
  canOpenLinks(): boolean;
  availableDisplayModes(): McpUiDisplayMode[];
}

export function createHostBridge(app: App): HostBridge {
  const hasCapability = (key: "message" | "updateModelContext" | "openLinks") =>
    app.getHostCapabilities()?.[key] !== undefined;

  async function callTool<T>(
    name: string,
    args: Record<string, unknown>,
    schema: z.ZodType<T>,
  ): Promise<HostResult<T>> {
    let result;
    try {
      result = await app.callServerTool({ name, arguments: args });
    } catch (error) {
      return { ok: false, message: `${name} failed: ${describe(error)}` };
    }
    if (result.isError) {
      return { ok: false, message: textOf(result.content) || `${name} returned an error` };
    }
    const parsed = schema.safeParse(result.structuredContent);
    if (!parsed.success) {
      return { ok: false, message: `${name} returned an unexpected shape` };
    }
    return { ok: true, value: parsed.data };
  }

  return {
    async loadSession(sessionId) {
      const result = await callTool("pare-load", { session_id: sessionId }, LoadResultSchema);
      return result.ok ? { ok: true, value: result.value.session } : result;
    },
    record(input) {
      return callTool("pare-record", input, RecordResultSchema);
    },
    async sendMessage(text) {
      if (!hasCapability("message")) {
        return { ok: false, message: "This host cannot receive messages from apps." };
      }
      try {
        const result = await app.sendMessage({ role: "user", content: [{ type: "text", text }] });
        return result.isError
          ? { ok: false, message: "The host declined the message." }
          : { ok: true, value: undefined };
      } catch (error) {
        return { ok: false, message: describe(error) };
      }
    },
    async updateModelContext(text, structured) {
      if (!hasCapability("updateModelContext")) return;
      try {
        await app.updateModelContext({
          content: [{ type: "text", text }],
          ...(structured ? { structuredContent: structured } : {}),
        });
      } catch {
        // Context updates are advisory; the results tools remain the source of truth.
      }
    },
    async openLink(url) {
      if (!hasCapability("openLinks")) {
        window.open(url, "_blank", "noopener,noreferrer");
        return;
      }
      await app.openLink({ url }).catch(() => undefined);
    },
    async requestDisplayMode(mode) {
      try {
        const result = await app.requestDisplayMode({ mode });
        return result.mode;
      } catch {
        return app.getHostContext()?.displayMode ?? "inline";
      }
    },
    context: () => app.getHostContext(),
    canSendMessage: () => hasCapability("message"),
    canOpenLinks: () => hasCapability("openLinks"),
    availableDisplayModes: () => app.getHostContext()?.availableDisplayModes ?? ["inline"],
  };
}

function textOf(content: { type: string; text?: string }[] | undefined): string {
  return (content ?? [])
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n");
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
