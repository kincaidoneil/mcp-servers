// Everything the app asks of the MCP host, behind one interface so the UI
// never touches the `App` protocol object directly.

import type { App, McpUiDisplayMode, McpUiHostContext } from "@modelcontextprotocol/ext-apps";

export type HostResult<T> = { ok: true; value: T } | { ok: false; message: string };

export interface HostBridge {
  // Posts as the user and triggers a reply.
  sendMessage(text: string): Promise<HostResult<void>>;
  // Quiet: replaces the previous update, read on the model's next turn. Hosts
  // without the capability are skipped silently.
  updateModelContext(text: string, structured: Record<string, unknown>): Promise<void>;
  openLink(url: string): Promise<void>;
  requestDisplayMode(mode: McpUiDisplayMode): Promise<McpUiDisplayMode>;
  context(): McpUiHostContext | undefined;
  canSendMessage(): boolean;
  availableDisplayModes(): McpUiDisplayMode[];
}

export function createHostBridge(app: App): HostBridge {
  const capabilities = () => app.getHostCapabilities();
  const supportsStructured = () =>
    capabilities()?.updateModelContext?.structuredContent !== undefined;

  return {
    async sendMessage(text) {
      if (capabilities()?.message === undefined) {
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
      if (capabilities()?.updateModelContext === undefined) return;
      try {
        await app.updateModelContext({
          content: [{ type: "text", text }],
          ...(supportsStructured() ? { structuredContent: structured } : {}),
        });
      } catch {
        // Advisory. The final message carries everything anyway.
      }
    },
    async openLink(url) {
      if (capabilities()?.openLinks === undefined) {
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
    canSendMessage: () => capabilities()?.message !== undefined,
    availableDisplayModes: () => app.getHostContext()?.availableDisplayModes ?? ["inline"],
  };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
