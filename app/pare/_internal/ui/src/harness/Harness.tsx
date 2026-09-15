// A stand-in MCP host for local development and E2E tests. It embeds the
// app the way Claude does (HTML string into a sandboxed iframe, JSON-RPC over
// postMessage), replays the pare-start input and result, and shows what the
// app sends back: context updates after every decision, and chat messages.
//
// Query parameters: fixture=newsletters|tasks|terse, src=dist|dev,
// theme=light|dark.

import { useCallback, useEffect, useRef, useState } from "react";
import { AppBridge, PostMessageTransport } from "@modelcontextprotocol/ext-apps/app-bridge";
import type { McpUiDisplayMode } from "@modelcontextprotocol/ext-apps";
import { z } from "zod";
import { DecisionSchema, StartInputSchema, buildSession, type Decision } from "../../../schema";
import { FIXTURES } from "../fixtures";

type LogEntry = { kind: "message" | "context" | "link" | "display" | "tool"; text: string };

// What the model would see in its context after the app's latest update.
const ContextSchema = z.object({
  session_id: z.string(),
  status: z.string(),
  total: z.number(),
  decided: z.number(),
  decisions: z.array(DecisionSchema),
});
type ModelContext = z.infer<typeof ContextSchema>;

const params = new URLSearchParams(window.location.search);

export function Harness() {
  const [fixture, setFixture] = useState(params.get("fixture") ?? "newsletters");
  const [src, setSrc] = useState(params.get("src") ?? "dist");
  const [theme, setTheme] = useState<"light" | "dark">(
    params.get("theme") === "dark" ? "dark" : "light",
  );
  const [displayMode, setDisplayMode] = useState<McpUiDisplayMode>("inline");
  const [log, setLog] = useState<LogEntry[]>([]);
  const [context, setContext] = useState<ModelContext | null>(null);
  const [mountKey, setMountKey] = useState(0);
  // Decisions the "model" passes back into pare-start on the next mount.
  const [seed, setSeed] = useState<Decision[]>([]);
  const bridge = useRef<AppBridge | null>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const contextRef = useRef<ModelContext | null>(null);
  contextRef.current = context;

  const pushLog = useCallback((entry: LogEntry) => setLog((l) => [...l, entry]), []);
  const sessionId = `harness-${fixture}`;

  useEffect(() => {
    document.documentElement.dataset["theme"] = theme;
    bridge.current?.sendHostContextChange({ theme });
  }, [theme]);

  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe) return;
    let cancelled = false;
    const input = StartInputSchema.parse({
      ...(FIXTURES[fixture] ?? FIXTURES["newsletters"]),
      session_id: sessionId,
      decisions: seed,
    });
    const session = buildSession(input, sessionId, new Date().toISOString());

    const host = new AppBridge(
      null,
      { name: "pare-harness", version: "0.2.0" },
      {
        openLinks: {},
        serverTools: {},
        logging: {},
        updateModelContext: { text: {}, structuredContent: {} },
        message: { text: {} },
      },
      {
        hostContext: {
          theme,
          platform: "web",
          displayMode: "inline",
          availableDisplayModes: ["inline", "fullscreen"],
          containerDimensions: { maxHeight: 6000 },
          safeAreaInsets: { top: 0, right: 0, bottom: 0, left: 0 },
        },
      },
    );
    bridge.current = host;

    host.oncalltool = async (request) => {
      pushLog({ kind: "tool", text: `${request.name} ${JSON.stringify(request.arguments)}` });
      return { content: [{ type: "text", text: `unknown tool ${request.name}` }], isError: true };
    };
    // oxlint-disable-next-line unicorn/prefer-add-event-listener -- AppBridge request handlers are setters
    host.onmessage = async (message) => {
      const text = message.content
        .map((block) => (block.type === "text" ? block.text : `[${block.type}]`))
        .join("\n");
      // ?send=fail stands in for a host that declines the message, so the app
      // can be checked for what it claims after a hand-off that did not land.
      if (params.get("send") === "fail") {
        pushLog({ kind: "message", text: `[declined] ${text}` });
        return { isError: true };
      }
      pushLog({ kind: "message", text });
      return {};
    };
    host.onupdatemodelcontext = async (update) => {
      const text = (update.content ?? [])
        .map((block) => (block.type === "text" ? block.text : `[${block.type}]`))
        .join("\n");
      pushLog({ kind: "context", text });
      const parsed = ContextSchema.safeParse(update.structuredContent);
      if (parsed.success) setContext(parsed.data);
      return {};
    };
    host.onopenlink = async ({ url }) => {
      pushLog({ kind: "link", text: url });
      window.open(url, "_blank", "noopener,noreferrer");
      return {};
    };
    host.onrequestdisplaymode = async ({ mode }) => {
      const next: McpUiDisplayMode = mode === "fullscreen" ? "fullscreen" : "inline";
      setDisplayMode(next);
      pushLog({ kind: "display", text: next });
      void host.sendHostContextChange({ displayMode: next });
      return { mode: next };
    };
    host.onsizechange = ({ height }) => {
      if (height !== undefined && iframeRef.current) {
        iframeRef.current.style.height = `${Math.ceil(height)}px`;
      }
    };
    host.onloggingmessage = (entry) => {
      pushLog({ kind: "tool", text: `log ${entry.level}: ${JSON.stringify(entry.data)}` });
    };
    host.oninitialized = () => {
      void host.sendToolInput({ arguments: input });
      void host.sendToolResult({
        content: [{ type: "text", text: `Opened pare session ${session.id}` }],
        structuredContent: {
          session_id: session.id,
          title: session.config.title,
          total: session.config.items.length,
          decided: Object.keys(session.decisions).length,
        },
      });
    };

    (async () => {
      const win = iframe.contentWindow;
      if (!win) return;
      await host.connect(new PostMessageTransport(win, win));
      if (cancelled) return;
      if (src === "dev") {
        iframe.src = "/index.html";
      } else {
        // "dist" is the production build; any other value is a built file
        // under the UI folder, e.g. "variants/x" for variants/x.html.
        const path = src === "dist" ? "/dist/index.html" : `/${src}.html`;
        const response = await fetch(path);
        if (!response.ok) {
          pushLog({ kind: "tool", text: `${path} missing: run pnpm ui:build` });
          return;
        }
        iframe.srcdoc = await response.text();
      }
    })();

    return () => {
      cancelled = true;
      void host.close();
      bridge.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fixture, src, mountKey]);

  const clearCache = () => {
    try {
      localStorage.removeItem(`pare:session:${sessionId}`);
    } catch {
      // Storage may be unavailable; nothing to clear then.
    }
  };

  // A fresh session: no cache, no seed.
  const restart = () => {
    clearCache();
    setSeed([]);
    setContext(null);
    setLog([]);
    setMountKey((k) => k + 1);
  };

  // What a model would do in a new conversation: call pare-start again with
  // the decisions from the last context update. The cache is cleared so the
  // seed alone has to restore progress.
  const reopenFromContext = () => {
    clearCache();
    setSeed(contextRef.current?.decisions ?? []);
    setLog([]);
    setMountKey((k) => k + 1);
  };

  return (
    <div className={"harness" + (displayMode === "fullscreen" ? " harness--fullscreen" : "")}>
      <style>{HARNESS_CSS}</style>
      <aside className="harness__panel">
        <h1>pare harness</h1>
        <label>
          Fixture
          <select value={fixture} onChange={(e) => setFixture(e.target.value)}>
            {Object.keys(FIXTURES).map((key) => (
              <option key={key} value={key}>
                {key}
              </option>
            ))}
          </select>
        </label>
        <label>
          Source
          <select value={src} onChange={(e) => setSrc(e.target.value)}>
            <option value="dist">dist/index.html (srcdoc, like a host)</option>
            <option value="dev">live dev server</option>
            {src !== "dist" && src !== "dev" && <option value={src}>{src}.html</option>}
          </select>
        </label>
        <label>
          Theme
          <select
            value={theme}
            onChange={(e) => setTheme(e.target.value === "dark" ? "dark" : "light")}
          >
            <option value="light">light</option>
            <option value="dark">dark</option>
          </select>
        </label>
        <div className="harness__buttons">
          <button type="button" onClick={() => setMountKey((k) => k + 1)} data-testid="remount">
            Remount iframe
          </button>
          <button type="button" onClick={reopenFromContext} data-testid="reopen">
            Reopen from context
          </button>
          <button type="button" onClick={restart} data-testid="restart">
            Restart
          </button>
        </div>

        <h2>Model context</h2>
        <div className="harness__store" data-testid="context">
          {context ? (
            <>
              <div data-testid="context-decided">
                {context.decided} of {context.total} decided · {context.status}
              </div>
              <ul data-testid="context-list">
                {context.decisions.map((d) => (
                  <li key={d.item_id} data-item-id={d.item_id} data-action={d.action}>
                    {d.item_id}: {d.action}
                    {d.note ? ` (${d.note})` : ""}
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <span data-testid="context-decided">no update yet</span>
          )}
        </div>

        <h2>Sent to chat</h2>
        <div className="harness__log" data-testid="log">
          {log.map((entry, i) => (
            <pre
              key={i}
              className={`harness__entry harness__entry--${entry.kind}`}
              data-testid={`log-${entry.kind}`}
            >
              {entry.text}
            </pre>
          ))}
        </div>
      </aside>
      <main className="harness__stage">
        <div className="harness__chat">
          <p className="harness__bubble">
            Here are the newsletters that hit your inbox this year. Go through them and I will
            unsubscribe from whatever you drop.
          </p>
          <iframe
            key={mountKey}
            ref={iframeRef}
            title="pare"
            sandbox="allow-scripts allow-same-origin"
            className="harness__iframe"
            data-testid="app"
          />
        </div>
      </main>
    </div>
  );
}

const HARNESS_CSS = `
  :root { color-scheme: light; --bg: #faf9f5; --fg: #141413; --panel: #f1f0ea; --line: rgba(0,0,0,.1); }
  :root[data-theme="dark"] { color-scheme: dark; --bg: #262624; --fg: #faf9f5; --panel: #1f1e1c; --line: rgba(255,255,255,.12); }
  body { margin: 0; font: 13px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; background: var(--bg); color: var(--fg); }
  .harness { display: grid; grid-template-columns: 320px 1fr; min-height: 100vh; }
  .harness__panel { background: var(--panel); border-right: 1px solid var(--line); padding: 16px; display: flex; flex-direction: column; gap: 8px; overflow: auto; height: 100vh; position: sticky; top: 0; }
  .harness__panel h1 { font-size: 14px; margin: 0 0 6px; }
  .harness__panel h2 { font-size: 11px; text-transform: uppercase; letter-spacing: .08em; opacity: .6; margin: 14px 0 2px; }
  .harness__panel label { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
  .harness__panel select { max-width: 190px; }
  .harness__buttons { display: flex; gap: 6px; margin-top: 6px; flex-wrap: wrap; }
  .harness__store { font-size: 12px; }
  .harness__store ul { margin: 4px 0; padding-left: 16px; }
  .harness__log { display: flex; flex-direction: column; gap: 6px; }
  .harness__entry { margin: 0; padding: 6px 8px; border-radius: 6px; background: var(--bg); border: 1px solid var(--line); white-space: pre-wrap; font-size: 11px; max-height: 220px; overflow: auto; }
  .harness__entry--message { border-color: #2c7a4b; }
  .harness__entry--context { opacity: .75; }
  .harness__stage { padding: 40px 24px; display: flex; justify-content: center; }
  .harness__chat { width: min(720px, 100%); display: flex; flex-direction: column; gap: 16px; }
  .harness__bubble { margin: 0; align-self: flex-end; max-width: 70%; background: var(--panel); border: 1px solid var(--line); border-radius: 14px; padding: 10px 14px; }
  .harness__iframe { width: 100%; height: 480px; border: 0; display: block; background: transparent; }
  .harness--fullscreen .harness__iframe { position: fixed; inset: 0; width: 100vw; height: 100vh !important; z-index: 50; background: var(--bg); }
`;
