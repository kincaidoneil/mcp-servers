// The pare app. Connects to the MCP host, builds the session from the
// pare-start input the host replays, restores any cached progress, then runs
// the triage loop: keyboard, gestures, a context update after every change,
// and the summary that pushes decisions back to the chat.

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { applyDocumentTheme, type McpUiDisplayMode } from "@modelcontextprotocol/ext-apps";
import { useApp } from "@modelcontextprotocol/ext-apps/react";
import { z } from "zod";
import {
  DISPOSE,
  KEEP,
  StartInputSchema,
  StartResultSchema,
  actionLabel,
  buildSession,
  type Item,
  type Session,
} from "../../schema";
import { createHostBridge, type HostBridge } from "./host";
import { contextUpdate, resultsMessage } from "./messages";
import * as S from "./state";
import { loadCached, mergeCached, saveCached } from "./storage";
import { ActionBar, Legend } from "./components/ActionBar";
import { CardStack, type StackApi } from "./components/CardStack";
import { Header, Menu } from "./components/Header";
import { NoteField } from "./components/NoteField";
import { Summary } from "./components/Summary";

const CONTEXT_DELAY = 250;

type ToolResult = { ok: true; sessionId: string } | { ok: false; message: string };

export function App() {
  const [toolInput, setToolInput] = useState<unknown>(undefined);
  const [toolResult, setToolResult] = useState<ToolResult | null>(null);
  const [displayMode, setDisplayMode] = useState<McpUiDisplayMode>("inline");
  const [safeBottom, setSafeBottom] = useState(0);

  const { app, isConnected, error } = useApp({
    appInfo: { name: "pare", version: "0.2.0" },
    capabilities: { availableDisplayModes: ["inline", "fullscreen"] },
    onAppCreated(created) {
      created.ontoolinput = ({ arguments: args }) => setToolInput(args ?? {});
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

  // The session is built once, from the tool input and the cache.
  const session = useMemo<Session | { error: string } | null>(() => {
    if (!toolResult || toolInput === undefined) return null;
    if (!toolResult.ok) return { error: toolResult.message };
    const parsed = StartInputSchema.safeParse(toolInput);
    if (!parsed.success) return { error: `Invalid session: ${z.prettifyError(parsed.error)}` };
    const fresh = buildSession(parsed.data, toolResult.sessionId, new Date().toISOString());
    return mergeCached(fresh, loadCached(fresh.id));
  }, [toolInput, toolResult]);

  if (error) return <Status error>Could not connect to the host: {error.message}</Status>;
  if (!host) return <Status>Connecting…</Status>;
  if (!session) return <Status>Waiting for the session…</Status>;
  if ("error" in session) return <Status error>{session.error}</Status>;
  return (
    <Triage
      key={session.id}
      host={host}
      initial={session}
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
  initial: Session;
  displayMode: McpUiDisplayMode;
  onDisplayMode: (mode: McpUiDisplayMode) => void;
  safeBottom: number;
}

const now = () => new Date().toISOString();

function Triage({ host, initial, displayMode, onDisplayMode, safeBottom }: TriageProps) {
  // The triage state lives in a ref and re-renders are requested explicitly,
  // so a burst of keypresses sees the latest state synchronously instead of
  // racing through React's batching.
  const stateRef = useRef<S.TriageState>(S.initialState(initial));
  const [, rerender] = useReducer((n: number) => n + 1, 0);

  const [note, setNote] = useState("");
  const noteRef = useRef("");
  noteRef.current = note;
  // The note field appears on the first typed letter and stays until the
  // card is decided, so the deck keeps keyboard focus the rest of the time.
  const [noteOpen, setNoteOpen] = useState(false);
  const noteOpenRef = useRef(false);
  noteOpenRef.current = noteOpen;
  const [expanded, setExpanded] = useState(false);
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState<"final" | "progress" | null>(
    initial.status === "done" ? "final" : null,
  );
  const [sendError, setSendError] = useState<string | null>(null);
  const stackApi = useRef<StackApi | null>(null);
  const noteInput = useRef<HTMLTextAreaElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const contextTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ---- Persistence ----------------------------------------------------------
  // Every change goes to browser storage at once and to the model's context
  // shortly after (debounced so a fast run of keypresses sends one update).

  const pushContext = useCallback(() => {
    const update = contextUpdate(stateRef.current.session);
    return host.updateModelContext(update.text, update.structured);
  }, [host]);

  const commit = useCallback(
    (fn: (state: S.TriageState) => S.TriageState) => {
      stateRef.current = fn(stateRef.current);
      rerender();
      saveCached(stateRef.current.session);
      if (contextTimer.current) clearTimeout(contextTimer.current);
      contextTimer.current = setTimeout(() => {
        contextTimer.current = null;
        void pushContext();
      }, CONTEXT_DELAY);
    },
    [pushContext],
  );

  useEffect(
    () => () => {
      if (contextTimer.current) clearTimeout(contextTimer.current);
    },
    [],
  );

  // ---- Decisions ------------------------------------------------------------

  // Keyboard shortcuts need focus inside the iframe; the app root holds it.
  const focusRoot = () => rootRef.current?.focus({ preventScroll: true });
  const focusNoteEnd = () => {
    const el = noteInput.current;
    if (!el) return;
    el.focus({ preventScroll: true });
    el.setSelectionRange(el.value.length, el.value.length);
  };
  const resetCard = () => {
    setNote("");
    setNoteOpen(false);
    setExpanded(false);
    focusRoot();
  };
  const openNote = (text: string) => {
    if (noteOpenRef.current) {
      // Letters can land before the field takes focus; append them.
      setNote((n) => n + text);
    } else {
      setNoteOpen(true);
      setNote(text);
    }
    setTimeout(focusNoteEnd, 0);
  };

  const act = useCallback(
    (actionId: string, viaSwipe = false) => {
      const current = stateRef.current;
      const item = itemById(current, current.session.queue[0]);
      if (!item) return;
      if (!viaSwipe) {
        const kind = actionId === KEEP ? "keep" : actionId === DISPOSE ? "dispose" : "fade";
        stackApi.current?.exit(item.id, kind, actionLabel(current.session.config, actionId));
      }
      commit((s) => S.decide(s, item.id, actionId, noteRef.current, now()));
      setSent((prev) => (prev === "final" ? null : prev));
      resetCard();
    },
    [commit],
  );

  const skipTop = useCallback(() => {
    const current = stateRef.current;
    const item = itemById(current, current.session.queue[0]);
    if (!item || current.session.queue.length < 2) return;
    stackApi.current?.exit(item.id, "skip", "Later");
    commit((s) => S.skip(s, item.id, now()));
    resetCard();
  }, [commit]);

  const undo = useCallback(() => {
    if (!S.canUndo(stateRef.current)) return;
    commit((s) => S.undo(s, now()));
    resetCard();
  }, [commit]);

  const revisit = useCallback(
    (itemId: string) => {
      commit((s) => S.revisit(s, itemId, now()));
      setSent(null);
      setSendError(null);
      setTimeout(focusRoot, 0);
    },
    [commit],
  );

  const send = useCallback(
    async (final: boolean) => {
      setSending(true);
      setSendError(null);
      if (final) commit((s) => S.setStatus(s, "done", now()));
      if (contextTimer.current) clearTimeout(contextTimer.current);
      await pushContext();
      const result = await host.sendMessage(resultsMessage(stateRef.current.session, final));
      if (result.ok) setSent(final ? "final" : "progress");
      else setSendError(result.message);
      setSending(false);
    },
    [commit, host, pushContext],
  );

  const toggleFullscreen = useCallback(async () => {
    const mode = await host.requestDisplayMode(
      displayMode === "fullscreen" ? "inline" : "fullscreen",
    );
    onDisplayMode(mode);
    focusRoot();
  }, [displayMode, host, onDisplayMode]);

  // ---- Keyboard -------------------------------------------------------------
  // With the deck focused: arrows and Enter decide, digits pick extra actions,
  // any other printable key opens the note. Inside the note: Enter decides,
  // modifier plus arrow decides, Escape returns to the deck.

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const current = stateRef.current;
      if (current.session.queue.length === 0) return;
      const target = e.target as HTMLElement | null;
      const inNote = target === noteInput.current;
      const typingElsewhere =
        !inNote && target instanceof HTMLElement && ["INPUT", "TEXTAREA"].includes(target.tagName);
      if (typingElsewhere) return;
      const mod = e.metaKey || e.ctrlKey;
      const config = current.session.config;
      const top = itemById(current, current.session.queue[0]);
      const confirmAction = top?.suggestion?.action ?? KEEP;
      const handle = (fn: () => void) => {
        e.preventDefault();
        fn();
      };

      if (inNote) {
        if (e.key === "Enter" && !e.shiftKey) return handle(() => act(confirmAction));
        if (e.key === "ArrowRight" && mod) return handle(() => act(KEEP));
        if (e.key === "ArrowLeft" && mod) return handle(() => act(DISPOSE));
        if (e.key === "ArrowDown" && mod && config.skip) return handle(skipTop);
        if (e.key === "Escape") {
          return handle(() => {
            if (noteRef.current.trim().length === 0) setNoteOpen(false);
            focusRoot();
          });
        }
        return;
      }

      if (e.key === "ArrowRight") return handle(() => act(KEEP));
      if (e.key === "ArrowLeft") return handle(() => act(DISPOSE));
      if (e.key === "Enter") return handle(() => act(confirmAction));
      if (e.key === "ArrowDown" && config.skip) return handle(skipTop);
      if (e.key === "ArrowUp") {
        return handle(() => {
          if (expanded || stackApi.current?.canExpand()) setExpanded((v) => !v);
        });
      }
      if ((e.key === "z" || e.key === "Z") && mod && !e.shiftKey) return handle(undo);
      if (e.key === "Escape") return handle(() => setExpanded(false));
      if (mod || e.altKey || e.key.length !== 1) return;
      if (/^[1-4]$/.test(e.key)) {
        const extra = config.extra_actions[Number(e.key) - 1];
        if (extra) return handle(() => act(extra.id));
        return;
      }
      // A space alone does not open a note, but once one is open every
      // printable key belongs to it, even before the field takes focus.
      if (config.notes && (e.key !== " " || noteOpenRef.current)) {
        return handle(() => openNote(e.key));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [act, skipTop, undo, expanded]);

  // Focus the deck once it is on screen.
  useEffect(() => {
    focusRoot();
  }, []);

  // ---- Render ---------------------------------------------------------------

  const state = stateRef.current;
  const { session } = state;
  const { config } = session;
  const queueItems = session.queue
    .map((id) => itemById(state, id))
    .filter((item): item is Item => item !== undefined);
  const top = queueItems[0];
  const { decided, total } = S.progress(session);
  const fullscreen = displayMode === "fullscreen";
  const remaining = session.queue.length;
  const enterLabel = actionLabel(config, top?.suggestion?.action ?? KEEP);

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
          onSelect: () => commit((s) => S.decideAllRemaining(s, KEEP, now())),
        },
        {
          label: `${config.dispose.label} all remaining (${remaining})`,
          disabled: remaining === 0,
          confirm: `${config.dispose.label} ${remaining} remaining?`,
          onSelect: () => commit((s) => S.decideAllRemaining(s, DISPOSE, now())),
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
              focusRoot();
            }}
            onSwipe={(itemId, action) => {
              if (itemId === stateRef.current.session.queue[0]) act(action, true);
            }}
            onOpenLink={(url) => void host.openLink(url)}
            apiRef={stackApi}
          />
          {config.notes &&
            (noteOpen ? (
              <NoteField
                value={note}
                onChange={setNote}
                enterLabel={enterLabel}
                inputRef={noteInput}
              />
            ) : (
              <button
                type="button"
                className="pare-note-open"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => openNote("")}
                data-testid="note-open"
              >
                Type to add a note
              </button>
            ))}
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
