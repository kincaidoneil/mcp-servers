// The pare app. Connects to the MCP host, loads the session named by the
// tool result, then runs the triage loop: keyboard, gestures, batched saves,
// and the summary that pushes decisions back to the chat.

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { applyDocumentTheme, type McpUiDisplayMode } from "@modelcontextprotocol/ext-apps";
import { useApp } from "@modelcontextprotocol/ext-apps/react";
import { DISPOSE, KEEP, StartResultSchema, actionLabel, type Item } from "../../schema";
import { createHostBridge, type HostBridge } from "./host";
import { progressContext, resultsMessage } from "./messages";
import * as S from "./state";
import { ActionBar, Legend } from "./components/ActionBar";
import { CardStack, type StackApi } from "./components/CardStack";
import { Header, Menu, type SaveState } from "./components/Header";
import { NoteField } from "./components/NoteField";
import { Summary } from "./components/Summary";

type Phase =
  | { kind: "connecting" }
  | { kind: "waiting" }
  | { kind: "loading" }
  | { kind: "ready" }
  | { kind: "error"; message: string };

const FLUSH_DELAY = 450;
const RETRY_DELAY = 3000;

export function App() {
  const [phase, setPhase] = useState<Phase>({ kind: "connecting" });
  const [toolResult, setToolResult] = useState<
    { ok: true; sessionId: string } | { ok: false; message: string } | null
  >(null);
  const [displayMode, setDisplayMode] = useState<McpUiDisplayMode>("inline");
  const [safeBottom, setSafeBottom] = useState(0);

  const { app, isConnected, error } = useApp({
    appInfo: { name: "pare", version: "0.1.0" },
    capabilities: { availableDisplayModes: ["inline", "fullscreen"] },
    onAppCreated(created) {
      created.ontoolresult = (result) => {
        if (result.isError) {
          const text = (result.content ?? [])
            .map((block) => (block.type === "text" ? block.text : ""))
            .join("\n");
          setToolResult({ ok: false, message: text || "The tool call failed." });
          return;
        }
        const parsed = StartResultSchema.safeParse(result.structuredContent);
        setToolResult(
          parsed.success
            ? { ok: true, sessionId: parsed.data.session_id }
            : { ok: false, message: "The tool result did not name a session." },
        );
      };
      created.onhostcontextchanged = (ctx) => {
        if (ctx.theme) applyDocumentTheme(ctx.theme);
        if (ctx.displayMode) setDisplayMode(ctx.displayMode);
        if (ctx.safeAreaInsets) setSafeBottom(ctx.safeAreaInsets.bottom);
      };
    },
  });

  const host = useMemo(
    () => (app && isConnected ? createHostBridge(app) : null),
    [app, isConnected],
  );

  useEffect(() => {
    if (!app || !isConnected) return;
    const ctx = app.getHostContext();
    applyDocumentTheme(
      ctx?.theme ?? (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"),
    );
    if (ctx?.displayMode) setDisplayMode(ctx.displayMode);
    if (ctx?.safeAreaInsets) setSafeBottom(ctx.safeAreaInsets.bottom);
  }, [app, isConnected]);

  useEffect(() => {
    if (error)
      setPhase({ kind: "error", message: `Could not connect to the host: ${error.message}` });
    else if (!isConnected) setPhase({ kind: "connecting" });
    else if (!toolResult) setPhase({ kind: "waiting" });
  }, [error, isConnected, toolResult]);

  if (phase.kind === "error") {
    return <Status error>{phase.message}</Status>;
  }
  if (!host || !toolResult) {
    return (
      <Status>{phase.kind === "connecting" ? "Connecting…" : "Waiting for the session…"}</Status>
    );
  }
  if (!toolResult.ok) {
    return <Status error>{toolResult.message}</Status>;
  }
  return (
    <Triage
      key={toolResult.sessionId}
      host={host}
      sessionId={toolResult.sessionId}
      displayMode={displayMode}
      onDisplayMode={setDisplayMode}
      safeBottom={safeBottom}
    />
  );
}

function Status({ children, error = false }: { children: React.ReactNode; error?: boolean }) {
  return (
    <div
      className={"pare-status" + (error ? " pare-status--error" : "")}
      role={error ? "alert" : "status"}
    >
      {children}
    </div>
  );
}

interface TriageProps {
  host: HostBridge;
  sessionId: string;
  displayMode: McpUiDisplayMode;
  onDisplayMode: (mode: McpUiDisplayMode) => void;
  safeBottom: number;
}

function Triage({ host, sessionId, displayMode, onDisplayMode, safeBottom }: TriageProps) {
  // The triage state lives in a ref and re-renders are requested explicitly,
  // so a burst of keypresses and the save loop both see the latest state
  // synchronously instead of racing through React's batching.
  const stateRef = useRef<S.TriageState | null>(null);
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  const update = useCallback((fn: (state: S.TriageState) => S.TriageState) => {
    if (!stateRef.current) return;
    stateRef.current = fn(stateRef.current);
    rerender();
  }, []);

  const [loadError, setLoadError] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const noteRef = useRef("");
  noteRef.current = note;
  const [expanded, setExpanded] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState<"final" | "progress" | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const stackApi = useRef<StackApi | null>(null);
  const noteInput = useRef<HTMLTextAreaElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const inFlight = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Load the session, including decisions saved by an earlier mount.
  useEffect(() => {
    let cancelled = false;
    host.loadSession(sessionId).then((result) => {
      if (cancelled) return;
      if (result.ok) {
        stateRef.current = S.initialState(result.value);
        rerender();
      } else {
        setLoadError(result.message);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [host, sessionId]);

  const state = stateRef.current;

  // ---- Saving ---------------------------------------------------------------

  const flush = useCallback(async (): Promise<void> => {
    const current = stateRef.current;
    if (!current || inFlight.current || !S.hasPending(current.pending)) return;
    const { state: cleared, input } = S.takePending(current);
    stateRef.current = cleared;
    inFlight.current = true;
    setSaveState("saving");
    const result = await host.record(input);
    inFlight.current = false;
    if (result.ok) {
      setSaveState("saved");
      const latest = stateRef.current;
      if (latest) void host.updateModelContext(progressContext(latest.session));
    } else {
      setSaveState("error");
      update((s) => S.restorePending(s, input));
      scheduleFlush(RETRY_DELAY);
    }
    if (stateRef.current && S.hasPending(stateRef.current.pending)) scheduleFlush(FLUSH_DELAY);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [host]);

  const scheduleFlush = useCallback(
    (delay: number) => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        timer.current = null;
        void flush();
      }, delay);
    },
    [flush],
  );

  const commit = useCallback(
    (fn: (state: S.TriageState) => S.TriageState, flushDelay = FLUSH_DELAY) => {
      update(fn);
      if (stateRef.current && S.hasPending(stateRef.current.pending)) scheduleFlush(flushDelay);
    },
    [update, scheduleFlush],
  );

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  // ---- Decisions ------------------------------------------------------------

  // Keyboard shortcuts need focus inside the iframe. The note field takes it
  // when there is one; otherwise the app root does.
  const focusNote = () => (noteInput.current ?? rootRef.current)?.focus({ preventScroll: true });

  const act = useCallback(
    (actionId: string, viaSwipe = false) => {
      const current = stateRef.current;
      const item = current && itemById(current, current.session.queue[0]);
      if (!current || !item) return;
      if (!viaSwipe) {
        const kind = actionId === KEEP ? "keep" : actionId === DISPOSE ? "dispose" : "fade";
        stackApi.current?.exit(item.id, kind, actionLabel(current.session.config, actionId));
      }
      commit((s) => S.decide(s, item.id, actionId, noteRef.current, new Date().toISOString()));
      setNote("");
      setExpanded(false);
      setSent((prev) => (prev === "final" ? null : prev));
      focusNote();
    },
    [commit],
  );

  const skipTop = useCallback(() => {
    const current = stateRef.current;
    const item = current && itemById(current, current.session.queue[0]);
    if (!current || !item || current.session.queue.length < 2) return;
    stackApi.current?.exit(item.id, "skip", "Later");
    commit((s) => S.skip(s, item.id));
    setNote("");
    setExpanded(false);
    focusNote();
  }, [commit]);

  const undo = useCallback(() => {
    const current = stateRef.current;
    if (!current || !S.canUndo(current)) return;
    commit((s) => S.undo(s));
    setNote("");
    setExpanded(false);
    focusNote();
  }, [commit]);

  const revisit = useCallback(
    (itemId: string) => {
      commit((s) => S.revisit(s, itemId));
      setSent(null);
      setSendError(null);
      setTimeout(focusNote, 0);
    },
    [commit],
  );

  const send = useCallback(
    async (final: boolean) => {
      const current = stateRef.current;
      if (!current) return;
      setSending(true);
      setSendError(null);
      if (final) update((s) => S.setStatus(s, "done"));
      if (timer.current) clearTimeout(timer.current);
      await flush();
      const latest = stateRef.current ?? current;
      const result = await host.sendMessage(resultsMessage(latest.session, final));
      if (result.ok) setSent(final ? "final" : "progress");
      else setSendError(result.message);
      setSending(false);
    },
    [flush, host, update],
  );

  const toggleFullscreen = useCallback(async () => {
    const mode = await host.requestDisplayMode(
      displayMode === "fullscreen" ? "inline" : "fullscreen",
    );
    onDisplayMode(mode);
    focusNote();
  }, [displayMode, host, onDisplayMode]);

  // ---- Keyboard -------------------------------------------------------------

  const queueRef = useRef<string[]>([]);
  queueRef.current = state?.session.queue ?? [];

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const current = stateRef.current;
      if (!current || current.session.queue.length === 0) return;
      const target = e.target as HTMLElement | null;
      const inField = target === noteInput.current;
      const typing =
        !inField && target instanceof HTMLElement && ["INPUT", "TEXTAREA"].includes(target.tagName);
      if (typing) return;
      const empty = noteRef.current.trim().length === 0;
      const free = !inField || empty;
      const mod = e.metaKey || e.ctrlKey;
      const config = current.session.config;
      const top = itemById(current, current.session.queue[0]);

      const handle = (fn: () => void) => {
        e.preventDefault();
        fn();
      };

      if (e.key === "ArrowRight" && (mod || free)) return handle(() => act(KEEP));
      if (e.key === "ArrowLeft" && (mod || free)) return handle(() => act(DISPOSE));
      if (e.key === "Enter" && !e.shiftKey) {
        return handle(() => act(top?.suggestion?.action ?? KEEP));
      }
      if (e.key === "ArrowDown" && (mod || free) && config.skip) return handle(skipTop);
      if (e.key === "ArrowUp" && free) return handle(() => setExpanded((v) => !v));
      if ((e.key === "z" || e.key === "Z") && mod && !e.shiftKey && free) return handle(undo);
      if (e.key === "Escape" && expanded) return handle(() => setExpanded(false));
      if (!mod && !e.altKey && free && e.key.length === 1) {
        const extra = config.extra_actions.find((a) => a.key === e.key.toLowerCase());
        if (extra) return handle(() => act(extra.id));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [act, skipTop, undo, expanded]);

  // Autofocus the note once the deck is on screen.
  const ready = state !== null;
  useEffect(() => {
    if (ready) focusNote();
  }, [ready]);

  // ---- Render ---------------------------------------------------------------

  if (loadError) return <Status error>{loadError}</Status>;
  if (!state) return <Status>Loading the session…</Status>;

  const { session } = state;
  const { config } = session;
  const queueItems = session.queue
    .map((id) => itemById(state, id))
    .filter((item): item is Item => item !== undefined);
  const top = queueItems[0];
  const { decided, total } = S.progress(session);
  const fullscreen = displayMode === "fullscreen";
  const remaining = session.queue.length;
  const enterLabel = top?.suggestion
    ? `${actionLabel(config, top.suggestion.action)} (suggested)`
    : config.keep.label;

  const menu = (
    <Menu
      items={[
        {
          label: "Send progress to chat",
          disabled: decided === 0 || sending || !host.canSendMessage(),
          onSelect: () => void send(false),
        },
        {
          label: `${config.keep.label} all remaining (${remaining})`,
          disabled: remaining === 0,
          confirm: `${config.keep.label} ${remaining} remaining?`,
          onSelect: () => commit((s) => S.decideAllRemaining(s, KEEP, new Date().toISOString())),
        },
        {
          label: `${config.dispose.label} all remaining (${remaining})`,
          disabled: remaining === 0,
          confirm: `${config.dispose.label} ${remaining} remaining?`,
          onSelect: () => commit((s) => S.decideAllRemaining(s, DISPOSE, new Date().toISOString())),
        },
      ]}
    />
  );

  return (
    <div
      ref={rootRef}
      tabIndex={-1}
      className={"pare" + (fullscreen ? " pare--fullscreen" : "")}
      style={safeBottom ? { paddingBottom: safeBottom + 12 } : undefined}
      data-testid="pare"
    >
      <Header
        title={config.title}
        description={config.description}
        decided={decided}
        total={total}
        saveState={saveState}
        canUndo={S.canUndo(state)}
        onUndo={undo}
        fullscreen={fullscreen}
        canFullscreen={host.availableDisplayModes().includes("fullscreen")}
        onToggleFullscreen={() => void toggleFullscreen()}
        menu={menu}
      />

      {top ? (
        <>
          <CardStack
            items={queueItems}
            config={config}
            expanded={expanded}
            onToggleExpanded={() => {
              setExpanded((v) => !v);
              focusNote();
            }}
            onSwipe={(itemId, action) => {
              if (itemId === queueRef.current[0]) act(action, true);
            }}
            onOpenLink={(url) => void host.openLink(url)}
            apiRef={stackApi}
          />
          {config.notes && (
            <NoteField
              value={note}
              onChange={setNote}
              enterLabel={enterLabel}
              inputRef={noteInput}
            />
          )}
          <ActionBar
            config={config}
            canSkip={remaining > 1}
            onAction={(id) => act(id)}
            onSkip={skipTop}
          />
          <Legend notes={config.notes} />
        </>
      ) : (
        <Summary
          session={session}
          sent={sent}
          sending={sending}
          sendError={sendError}
          canSend={host.canSendMessage()}
          onRevisit={revisit}
          onSend={() => void send(true)}
        />
      )}
    </div>
  );
}

function itemById(state: S.TriageState, id: string | undefined): Item | undefined {
  return id === undefined ? undefined : state.session.config.items.find((item) => item.id === id);
}
