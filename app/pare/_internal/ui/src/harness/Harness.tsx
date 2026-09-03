// A stand-in MCP host for local development and E2E tests. It embeds the
// app the way Claude does (HTML string into a sandboxed iframe, JSON-RPC over
// postMessage), answers the app's tool calls from an in-memory store, and
// shows what the app sends back to the chat.
//
// Query parameters: fixture=newsletters|tasks|terse, src=dist|dev,
// theme=light|dark, fail=1 (make every save fail).

import { useCallback, useEffect, useRef, useState } from "react";
import { AppBridge, PostMessageTransport } from "@modelcontextprotocol/ext-apps/app-bridge";
import type { McpUiDisplayMode } from "@modelcontextprotocol/ext-apps";
import {
  LoadInputSchema,
  RecordInputSchema,
  SessionConfigSchema,
  SessionSchema,
  applyRecord,
  toResults,
  type Session,
} from "../../../schema";
import { FIXTURES } from "../fixtures";

type LogEntry = { kind: "message" | "context" | "tool" | "link" | "display"; text: string };

const STORE_KEY = "pare-harness-store";

function readStore(): Map<string, Session> {
  try {
    const raw = sessionStorage.getItem(STORE_KEY);
    if (!raw) return new Map();
    const parsed: unknown = JSON.parse(raw);
    const out = new Map<string, Session>();
    if (Array.isArray(parsed)) {
      for (const entry of parsed) {
        const session = SessionSchema.safeParse(entry);
        if (session.success) out.set(session.data.id, session.data);
      }
    }
    return out;
  } catch {
    return new Map();
  }
}

function writeStore(store: Map<string, Session>) {
  sessionStorage.setItem(STORE_KEY, JSON.stringify([...store.values()]));
}

function sessionFor(fixture: string, store: Map<string, Session>): Session {
  const id = `harness-${fixture}`;
  const existing = store.get(id);
  if (existing) return existing;
  const config = SessionConfigSchema.parse(FIXTURES[fixture] ?? FIXTURES["newsletters"]);
  const now = new Date().toISOString();
  const session: Session = {
    id,
    owner: "harness",
    created_at: now,
    updated_at: now,
    version: 0,
    status: "open",
    config,
    decisions: {},
    queue: config.items.map((item) => item.id),
  };
  store.set(id, session);
  writeStore(store);
  return session;
}

const params = new URLSearchParams(window.location.search);

export function Harness() {
  const [fixture, setFixture] = useState(params.get("fixture") ?? "newsletters");
  const [src, setSrc] = useState<"dist" | "dev">(params.get("src") === "dev" ? "dev" : "dist");
  const [theme, setTheme] = useState<"light" | "dark">(
    params.get("theme") === "dark" ? "dark" : "light",
  );
  const [failSaves, setFailSaves] = useState(params.get("fail") === "1");
  const [displayMode, setDisplayMode] = useState<McpUiDisplayMode>("inline");
  const [log, setLog] = useState<LogEntry[]>([]);
  const [mountKey, setMountKey] = useState(0);
  const [snapshot, setSnapshot] = useState<Session | null>(null);
  const store = useRef(readStore());
  const bridge = useRef<AppBridge | null>(null);
  const failRef = useRef(failSaves);
  failRef.current = failSaves;

  const pushLog = useCallback((entry: LogEntry) => setLog((l) => [...l, entry]), []);

  const iframeRef = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    document.documentElement.dataset["theme"] = theme;
    bridge.current?.sendHostContextChange({ theme });
  }, [theme]);

  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe) return;
    let cancelled = false;
    const session = sessionFor(fixture, store.current);
    setSnapshot(session);

    const host = new AppBridge(
      null,
      { name: "pare-harness", version: "0.1.0" },
      {
        openLinks: {},
        serverTools: {},
        logging: {},
        updateModelContext: { text: {} },
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
      const name = request.name;
      const args = request.arguments ?? {};
      pushLog({ kind: "tool", text: `${name} ${JSON.stringify(args)}` });
      if (name === "pare-load") {
        const input = LoadInputSchema.parse(args);
        const found = store.current.get(input.session_id);
        if (!found) return { content: [{ type: "text", text: "not found" }], isError: true };
        return { content: [{ type: "text", text: "ok" }], structuredContent: { session: found } };
      }
      if (name === "pare-record") {
        await new Promise((r) => setTimeout(r, 120));
        if (failRef.current) {
          return { content: [{ type: "text", text: "simulated save failure" }], isError: true };
        }
        const input = RecordInputSchema.parse(args);
        const current = store.current.get(input.session_id);
        if (!current) return { content: [{ type: "text", text: "not found" }], isError: true };
        const next = applyRecord(current, input, new Date().toISOString());
        store.current.set(next.id, next);
        writeStore(store.current);
        setSnapshot(next);
        const results = toResults(next);
        return {
          content: [{ type: "text", text: "saved" }],
          structuredContent: {
            version: next.version,
            decided: results.decided,
            total: results.total,
            status: next.status,
          },
        };
      }
      return { content: [{ type: "text", text: `unknown tool ${name}` }], isError: true };
    };
    // oxlint-disable-next-line unicorn/prefer-add-event-listener -- AppBridge request handlers are setters
    host.onmessage = async (message) => {
      const text = message.content
        .map((block) => (block.type === "text" ? block.text : `[${block.type}]`))
        .join("\n");
      pushLog({ kind: "message", text });
      return {};
    };
    host.onupdatemodelcontext = async (update) => {
      const text = (update.content ?? [])
        .map((block) => (block.type === "text" ? block.text : `[${block.type}]`))
        .join("\n");
      pushLog({ kind: "context", text });
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
      void host.sendToolInput({ arguments: session.config });
      void host.sendToolResult({
        content: [{ type: "text", text: `Opened pare session ${session.id}` }],
        structuredContent: {
          session_id: session.id,
          title: session.config.title,
          total: session.config.items.length,
        },
      });
    };

    (async () => {
      const win = iframe.contentWindow;
      if (!win) return;
      await host.connect(new PostMessageTransport(win, win));
      if (cancelled) return;
      if (src === "dist") {
        const response = await fetch("/dist/index.html");
        if (!response.ok) {
          pushLog({ kind: "tool", text: "dist/index.html missing: run pnpm ui:build" });
          return;
        }
        iframe.srcdoc = await response.text();
      } else {
        iframe.src = "/index.html";
      }
    })();

    return () => {
      cancelled = true;
      void host.close();
      bridge.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fixture, src, mountKey]);

  const restart = () => {
    store.current.delete(`harness-${fixture}`);
    writeStore(store.current);
    setLog([]);
    setMountKey((k) => k + 1);
  };

  const results = snapshot ? toResults(snapshot) : null;

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
          <select value={src} onChange={(e) => setSrc(e.target.value === "dev" ? "dev" : "dist")}>
            <option value="dist">dist/index.html (srcdoc, like a host)</option>
            <option value="dev">live dev server</option>
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
        <label className="harness__check">
          <input
            type="checkbox"
            checked={failSaves}
            onChange={(e) => setFailSaves(e.target.checked)}
            data-testid="fail-saves"
          />
          Fail saves
        </label>
        <div className="harness__buttons">
          <button type="button" onClick={() => setMountKey((k) => k + 1)} data-testid="remount">
            Remount iframe
          </button>
          <button type="button" onClick={restart} data-testid="restart">
            Restart session
          </button>
        </div>

        <h2>Store</h2>
        <div className="harness__store" data-testid="store">
          {results ? (
            <>
              <div data-testid="store-decided">
                {results.decided} of {results.total} decided · v{snapshot?.version} ·{" "}
                {results.status}
              </div>
              <ul data-testid="store-list">
                {results.decisions.map((d) => (
                  <li key={d.item_id} data-item-id={d.item_id} data-action={d.action}>
                    {d.title}: {d.label}
                    {d.note ? ` (${d.note})` : ""}
                  </li>
                ))}
              </ul>
              <div data-testid="store-queue">queue: {snapshot?.queue.join(", ")}</div>
            </>
          ) : (
            "empty"
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
  .harness__check { justify-content: flex-start !important; }
  .harness__buttons { display: flex; gap: 6px; margin-top: 6px; }
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
