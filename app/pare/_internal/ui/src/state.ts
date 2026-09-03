// Triage state for one session: the canonical session plus an undo stack and
// the batch of changes not yet flushed to the server. Pure functions so the
// mechanics can be tested without React.

import type { Decision, RecordInput, Session, SessionStatus } from "../../schema";

export interface PendingBatch {
  decisions: Record<string, Decision>;
  undo: Set<string>;
  status?: SessionStatus;
  // Set when only the queue order changed (a skip), so it still gets saved.
  queueDirty?: boolean;
}

type HistoryEntry =
  | { kind: "decide"; itemId: string; previousQueue: string[] }
  | { kind: "skip"; previousQueue: string[] };

export interface TriageState {
  session: Session;
  history: HistoryEntry[];
  pending: PendingBatch;
}

export function emptyPending(): PendingBatch {
  return { decisions: {}, undo: new Set() };
}

export function initialState(session: Session): TriageState {
  return { session, history: [], pending: emptyPending() };
}

export function hasPending(pending: PendingBatch): boolean {
  return (
    Object.keys(pending.decisions).length > 0 ||
    pending.undo.size > 0 ||
    pending.status !== undefined ||
    pending.queueDirty === true
  );
}

export function decide(
  state: TriageState,
  itemId: string,
  action: string,
  note: string,
  now: string,
): TriageState {
  const { session } = state;
  if (!session.queue.includes(itemId)) return state;
  const trimmed = note.trim();
  const decision: Decision = {
    item_id: itemId,
    action,
    decided_at: now,
    ...(trimmed ? { note: trimmed } : {}),
  };
  const pendingUndo = new Set(state.pending.undo);
  pendingUndo.delete(itemId);
  return {
    session: {
      ...session,
      decisions: { ...session.decisions, [itemId]: decision },
      queue: session.queue.filter((id) => id !== itemId),
    },
    history: [...state.history, { kind: "decide", itemId, previousQueue: session.queue }],
    pending: {
      ...state.pending,
      decisions: { ...state.pending.decisions, [itemId]: decision },
      undo: pendingUndo,
    },
  };
}

// Move the item to the end of the stack. A single remaining item is a no-op.
export function skip(state: TriageState, itemId: string): TriageState {
  const { session } = state;
  if (session.queue.length < 2 || !session.queue.includes(itemId)) return state;
  return {
    session: { ...session, queue: [...session.queue.filter((id) => id !== itemId), itemId] },
    history: [...state.history, { kind: "skip", previousQueue: session.queue }],
    pending: { ...state.pending, queueDirty: true },
  };
}

export function canUndo(state: TriageState): boolean {
  return state.history.length > 0;
}

export function undo(state: TriageState): TriageState {
  const entry = state.history[state.history.length - 1];
  if (!entry) return state;
  const history = state.history.slice(0, -1);
  if (entry.kind === "skip") {
    return {
      history,
      session: { ...state.session, queue: entry.previousQueue },
      pending: { ...state.pending, queueDirty: true },
    };
  }
  return { ...unDecide(state, entry.itemId, entry.previousQueue), history };
}

// Put a decided item back on top of the stack, from the summary screen.
export function revisit(state: TriageState, itemId: string): TriageState {
  if (!state.session.decisions[itemId]) return state;
  return {
    ...unDecide(state, itemId, [itemId, ...state.session.queue]),
    // The summary is a fresh start for the undo stack: undoing a revisit
    // would re-decide an item the user just chose to look at again.
    history: [],
  };
}

function unDecide(state: TriageState, itemId: string, queue: string[]): TriageState {
  const decisions = { ...state.session.decisions };
  delete decisions[itemId];
  const pendingDecisions = { ...state.pending.decisions };
  delete pendingDecisions[itemId];
  const pendingUndo = new Set(state.pending.undo);
  pendingUndo.add(itemId);
  return {
    ...state,
    session: { ...state.session, decisions, queue, status: "open" },
    pending: {
      ...state.pending,
      decisions: pendingDecisions,
      undo: pendingUndo,
      status: state.session.status === "done" ? "open" : state.pending.status,
    },
  };
}

export function decideAllRemaining(state: TriageState, action: string, now: string): TriageState {
  return state.session.queue.reduce((acc, id) => decide(acc, id, action, "", now), state);
}

export function setStatus(state: TriageState, status: SessionStatus): TriageState {
  if (state.session.status === status) return state;
  return {
    ...state,
    session: { ...state.session, status },
    pending: { ...state.pending, status },
  };
}

// Pull the pending batch out as a pare-record input and clear it. The queue
// always rides along: it is cheap and it makes skip order durable.
export function takePending(state: TriageState): { state: TriageState; input: RecordInput } {
  const { pending, session } = state;
  const input: RecordInput = {
    session_id: session.id,
    decisions: Object.values(pending.decisions),
    undo: [...pending.undo],
    queue: session.queue,
    ...(pending.status ? { status: pending.status } : {}),
  };
  return { state: { ...state, pending: emptyPending() }, input };
}

// A flush failed: put its changes back unless newer local changes for the
// same item exist, in which case the newer change already covers it.
export function restorePending(state: TriageState, failed: RecordInput): TriageState {
  const decisions = { ...state.pending.decisions };
  const undoSet = new Set(state.pending.undo);
  const touched = (id: string) => id in decisions || undoSet.has(id);
  for (const decision of failed.decisions ?? []) {
    if (!touched(decision.item_id) && state.session.decisions[decision.item_id]) {
      decisions[decision.item_id] = decision;
    }
  }
  for (const id of failed.undo ?? []) {
    if (!touched(id) && !state.session.decisions[id]) undoSet.add(id);
  }
  const status =
    state.pending.status ??
    (failed.status && failed.status === state.session.status ? failed.status : undefined);
  return {
    ...state,
    pending: { decisions, undo: undoSet, ...(status ? { status } : {}) },
  };
}

export function progress(session: Session): { decided: number; total: number } {
  return { decided: Object.keys(session.decisions).length, total: session.config.items.length };
}
