// The pare app. Connects to the MCP host, builds the session from the
// pare-start input the host replays, restores any cached progress, then runs
// the triage loop: keyboard, gestures, a context update after every change,
// and the summary that pushes decisions back to the chat.

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { applyDocumentTheme, type McpUiDisplayMode } from "@modelcontextprotocol/ext-apps";
import { useApp } from "@modelcontextprotocol/ext-apps/react";
import { animate, motion, useMotionValue, useTransform } from "motion/react";
import { z } from "zod";
import {
  DISPOSE,
  KEEP,
  StartInputSchema,
  StartResultSchema,
  buildSession,
  type Item,
  type Session,
} from "../../schema";
import { createHostBridge, type HostBridge } from "./host";
import { contextUpdate, resultsMessage } from "./messages";
import * as S from "./state";
import { loadCached, mergeCached, saveCached } from "./storage";
import { ExtraActions, SideAction } from "./components/ActionBar";
import { CardStack, type StackApi } from "./components/CardStack";
import { StatusBar, Menu } from "./components/Header";
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
  // How far the card is pulled toward a side, written by the stack and read
  // by the side actions.
  const pull = useMotionValue(0);
  const keepPull = useTransform(pull, [0, 1], [0, 1]);
  const disposePull = useTransform(pull, [-1, 0], [1, 0]);
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

  // Keyboard shortcuts need focus inside the iframe. The note field holds it
  // when there is one, so typing is commenting; otherwise the app root does.
  const focusRoot = () => (noteInput.current ?? rootRef.current)?.focus({ preventScroll: true });
  const resetCard = () => {
    setNote("");
    focusRoot();
  };

  // A decision made from the keyboard or a button lights the same side of the
  // table that a drag would.
  const flashGlow = useCallback(
    (actionId: string) => {
      const direction = actionId === KEEP ? 1 : actionId === DISPOSE ? -1 : 0;
      if (direction === 0) return;
      pull.set(direction * 0.9);
      animate(pull, 0, { duration: 0.5, ease: [0.2, 0, 0, 1] });
    },
    [pull],
  );

  const act = useCallback(
    (actionId: string, viaSwipe = false) => {
      const current = stateRef.current;
      const item = itemById(current, current.session.queue[0]);
      if (!item) return;
      if (!viaSwipe) {
        const kind = actionId === KEEP ? "keep" : actionId === DISPOSE ? "dispose" : "fade";
        stackApi.current?.exit(item.id, kind);
        flashGlow(actionId);
      }
      commit((s) => S.decide(s, item.id, actionId, noteRef.current, now()));
      setSent((prev) => (prev === "final" ? null : prev));
      resetCard();
    },
    [commit, flashGlow],
  );

  const skipTop = useCallback(() => {
    const current = stateRef.current;
    const item = itemById(current, current.session.queue[0]);
    if (!item || current.session.queue.length < 2) return;
    stackApi.current?.exit(item.id, "skip");
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
  // "Yes, no, comment": right arrow or Enter keeps, left arrow disposes, and
  // typing is the comment. While the note has text, bare arrows and digits
  // belong to the text and the modifier makes them decide.

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const current = stateRef.current;
      if (current.session.queue.length === 0) return;
      const target = e.target as HTMLElement | null;
      const inNote = target === noteInput.current;
      const typingElsewhere =
        !inNote && target instanceof HTMLElement && ["INPUT", "TEXTAREA"].includes(target.tagName);
      if (typingElsewhere) return;
      const empty = noteRef.current.length === 0;
      const free = !inNote || empty;
      const mod = e.metaKey || e.ctrlKey;
      const config = current.session.config;
      const handle = (fn: () => void) => {
        e.preventDefault();
        fn();
      };

      if (e.key === "ArrowRight" && (mod || free)) return handle(() => act(KEEP));
      if (e.key === "ArrowLeft" && (mod || free)) return handle(() => act(DISPOSE));
      if (e.key === "Enter" && !e.shiftKey) return handle(() => act(KEEP));
      if (e.key === "ArrowDown" && (mod || free) && config.skip) return handle(skipTop);
      if ((e.key === "z" || e.key === "Z") && mod && !e.shiftKey && free) return handle(undo);
      if (e.key === "Escape" && inNote && !empty) return handle(() => setNote(""));
      if (!mod && !e.altKey && free && /^[1-4]$/.test(e.key)) {
        const extra = config.extra_actions[Number(e.key) - 1];
        if (extra) return handle(() => act(extra.id));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [act, skipTop, undo]);

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
  const suggested = top?.suggestion?.action;

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
      {top ? (
        <>
          <motion.div className="pare-glow pare-glow--dispose" style={{ opacity: disposePull }} />
          <motion.div className="pare-glow pare-glow--keep" style={{ opacity: keepPull }} />
          <div className="pare-deck">
            <CardStack
              items={queueItems}
              pull={pull}
              onSwipe={(itemId, action) => {
                if (itemId === stateRef.current.session.queue[0]) act(action, true);
              }}
              onOpenLink={(url) => void host.openLink(url)}
              apiRef={stackApi}
            />
            <div className="pare-actions">
              <SideAction
                kind="dispose"
                config={config}
                suggested={suggested === DISPOSE}
                pull={disposePull}
                onAction={(id) => act(id)}
              />
              {config.notes && <NoteField value={note} onChange={setNote} inputRef={noteInput} />}
              <SideAction
                kind="keep"
                config={config}
                suggested={suggested === KEEP}
                pull={keepPull}
                onAction={(id) => act(id)}
              />
            </div>
            <ExtraActions
              config={config}
              canSkip={remaining > 1}
              suggestedAction={suggested}
              onAction={(id) => act(id)}
              onSkip={skipTop}
            />
          </div>
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
      <StatusBar
        decided={decided}
        total={total}
        canUndo={S.canUndo(state)}
        onUndo={undo}
        fullscreen={fullscreen}
        canFullscreen={host.availableDisplayModes().includes("fullscreen")}
        onToggleFullscreen={() => void toggleFullscreen()}
        menu={menu}
      />
    </div>
  );
}

function itemById(state: S.TriageState, id: string | undefined): Item | undefined {
  return id === undefined ? undefined : state.session.config.items.find((item) => item.id === id);
}
