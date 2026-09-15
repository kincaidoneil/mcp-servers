// Triage state for one session: the session plus an undo stack. Pure
// functions so the mechanics can be tested without React.

import type { Decision, Session, SessionStatus } from "../../schema";

type HistoryEntry =
  | { kind: "decide"; itemId: string; previousQueue: string[] }
  | { kind: "skip"; previousQueue: string[] }
  // Deciding the rest at once is one act, so it comes back as one.
  | { kind: "bulk"; previous: Session };

export interface TriageState {
  session: Session;
  history: HistoryEntry[];
}

export function initialState(session: Session): TriageState {
  return { session, history: [] };
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
  return {
    session: {
      ...session,
      decisions: { ...session.decisions, [itemId]: decision },
      queue: session.queue.filter((id) => id !== itemId),
      cleared: session.cleared.filter((id) => id !== itemId),
      updated_at: now,
    },
    history: [...state.history, { kind: "decide", itemId, previousQueue: session.queue }],
  };
}

// Move the item to the end of the stack. A single remaining item is a no-op.
export function skip(state: TriageState, itemId: string, now: string): TriageState {
  const { session } = state;
  if (session.queue.length < 2 || !session.queue.includes(itemId)) return state;
  return {
    session: {
      ...session,
      queue: [...session.queue.filter((id) => id !== itemId), itemId],
      updated_at: now,
    },
    history: [...state.history, { kind: "skip", previousQueue: session.queue }],
  };
}

export function canUndo(state: TriageState): boolean {
  return state.history.length > 0;
}

// The note that went with the decision an undo would take back, so the field
// can be handed the text back with it.
export function undoNote(state: TriageState): string {
  const entry = state.history[state.history.length - 1];
  if (entry?.kind !== "decide") return "";
  return state.session.decisions[entry.itemId]?.note ?? "";
}

export function undo(state: TriageState, now: string): TriageState {
  const entry = state.history[state.history.length - 1];
  if (!entry) return state;
  const history = state.history.slice(0, -1);
  if (entry.kind === "bulk") {
    return { history, session: { ...entry.previous, updated_at: now } };
  }
  if (entry.kind === "skip") {
    return { history, session: { ...state.session, queue: entry.previousQueue, updated_at: now } };
  }
  return { history, session: unDecide(state.session, entry.itemId, entry.previousQueue, now) };
}

// Put a decided item back on top of the stack, from the summary screen. The
// undo stack resets: undoing a revisit would re-decide an item the user just
// chose to look at again.
export function revisit(state: TriageState, itemId: string, now: string): TriageState {
  if (!state.session.decisions[itemId]) return state;
  return {
    history: [],
    session: unDecide(state.session, itemId, [itemId, ...state.session.queue], now),
  };
}

function unDecide(session: Session, itemId: string, queue: string[], now: string): Session {
  const decisions = { ...session.decisions };
  delete decisions[itemId];
  const cleared = session.cleared.includes(itemId) ? session.cleared : [...session.cleared, itemId];
  return { ...session, decisions, cleared, queue, status: "open", updated_at: now };
}

export function decideAllRemaining(state: TriageState, action: string, now: string): TriageState {
  const decided = state.session.queue.reduce((acc, id) => decide(acc, id, action, "", now), state);
  return {
    session: decided.session,
    history: [...state.history, { kind: "bulk", previous: state.session }],
  };
}

export function setStatus(state: TriageState, status: SessionStatus, now: string): TriageState {
  if (state.session.status === status) return state;
  return { ...state, session: { ...state.session, status, updated_at: now } };
}

// The results reached the chat. Only a send that came back clean may set this.
export function markSent(state: TriageState, now: string): TriageState {
  return { ...state, session: { ...state.session, status: "done", sent: true, updated_at: now } };
}

// Back to an item from the summary without changing what it was: for one that
// was never decided.
export function resume(state: TriageState, itemId: string, now: string): TriageState {
  const { session } = state;
  if (!session.queue.includes(itemId)) return state;
  return {
    ...state,
    session: {
      ...session,
      queue: [itemId, ...session.queue.filter((id) => id !== itemId)],
      status: "open",
      updated_at: now,
    },
  };
}

export function progress(session: Session): { decided: number; total: number } {
  return { decided: Object.keys(session.decisions).length, total: session.config.items.length };
}
