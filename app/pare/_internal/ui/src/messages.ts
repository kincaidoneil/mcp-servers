// Text the app sends back to the chat, over two channels.
//
// `updateModelContext` after every change: quiet, does not make the model
// reply, and the host keeps only the latest one, so each update carries the
// whole session. The host holds it until the next turn, which makes it the
// model's working copy of where the triage has got to.
//
// `sendMessage` when the user hands the results over: it posts as the user,
// starts a turn, and stays in the transcript. That permanence is why the
// decisions are written into the message itself rather than left to the
// context update, which the next one replaces.

import { actionLabel, countDecisions, type Session } from "../../schema";

// What either channel will spend on the list, about 10k tokens. An item id
// and its action cost around 24 characters, so the 500 items a session may
// hold always fit and a decision is never lost; what is left over pays for
// the titles and the notes, in that order.
const LIST_BUDGET = 40_000;
// A note trimmed shorter than this says nothing, so below it they all go.
const NOTE_FLOOR = 24;

function tally(session: Session): string {
  return [...countDecisions(session)]
    .filter(([, n]) => n > 0)
    .map(([id, n]) => `${n} ${actionLabel(session.config, id).toLowerCase()}`)
    .join(", ");
}

const length = (lines: string[]) => lines.reduce((n, line) => n + line.length + 1, 0);

function inOrder(session: Session) {
  return Object.values(session.decisions).toSorted((a, b) =>
    (a.decided_at ?? "").localeCompare(b.decided_at ?? ""),
  );
}

// The notes, sized to whatever room is left. They are the one thing in a
// session the model did not write itself, so they are shared out and cut
// short rather than dropped whole.
type Notes = { text: (itemId: string) => string; gave_up: string };

function notesWithin(session: Session, room: number): Notes {
  const noted = inOrder(session).filter((decision) => decision.note);
  const wanted = noted.reduce((n, decision) => n + decision.note!.length + 10, 0);
  const each = Math.floor(room / Math.max(1, noted.length)) - 10;
  const keep = noted.length === 0 || wanted <= room ? Infinity : each >= NOTE_FLOOR ? each : 0;
  const by = new Map(noted.map((decision) => [decision.item_id, decision.note!]));
  return {
    text: (itemId) => {
      const note = by.get(itemId);
      if (!note || keep === 0) return "";
      return note.length <= keep ? ` (note: ${note})` : ` (note: ${note.slice(0, keep)}…)`;
    },
    gave_up: keep === Infinity ? "" : keep === 0 ? "notes dropped" : "notes cut short",
  };
}

// Cut whole lines, never through one, and say exactly how many are missing.
// A message that stops mid-id reads as if the decision was something else.
function fit(lines: string[], room: number): string {
  const kept: string[] = [];
  let used = 0;
  for (const line of lines) {
    if (used + line.length + 1 > room) break;
    kept.push(line);
    used += line.length + 1;
  }
  const dropped = lines.length - kept.length;
  return dropped === 0 ? kept.join("\n") : `${kept.join("\n")}\n(${dropped} more not listed)`;
}

export interface ContextUpdate {
  text: string;
  structured: Record<string, unknown>;
}

// Everything the model needs to act on the session so far, or to reopen it in
// a later conversation via pare-start.
export function contextUpdate(session: Session): ContextUpdate {
  const { config } = session;
  const decided = Object.keys(session.decisions).length;
  const total = config.items.length;
  const state =
    session.status === "done"
      ? "The user marked the session finished."
      : "In progress; the user has not sent results yet, so do not act on these unless asked.";
  const legend = [
    `keep = ${config.keep.label}`,
    `dispose = ${config.dispose.label}`,
    ...config.extra_actions.map((a) => `${a.id} = ${a.label}`),
  ].join(", ");
  const bare = inOrder(session).map((decision) => `${decision.item_id}: ${decision.action}`);
  const notes = notesWithin(session, LIST_BUDGET - length(bare));
  const list = fit(
    inOrder(session).map(
      (decision) => `${decision.item_id}: ${decision.action}${notes.text(decision.item_id)}`,
    ),
    LIST_BUDGET,
  );
  const text =
    `Pare session ${session.id} "${config.title}": ${decided} of ${total} decided` +
    (decided ? ` (${tally(session)}).` : ".") +
    ` ${state}\n` +
    (decided ? `Decisions so far (item id: action), where ${legend}:\n${list}\n` : "") +
    (notes.gave_up ? `(${notes.gave_up}: the list was too long.)\n` : "") +
    `To reopen this session later, call pare-start with the same items, session_id "${session.id}", ` +
    "and these decisions.";
  return {
    text,
    structured: {
      session_id: session.id,
      title: config.title,
      status: session.status,
      total,
      decided,
      decisions: Object.values(session.decisions),
    },
  };
}

export function resultsMessage(session: Session, final: boolean): string {
  const { config } = session;
  const decided = Object.keys(session.decisions).length;
  const total = config.items.length;
  const undecided = session.queue.length;
  const byId = new Map(config.items.map((item) => [item.id, item]));

  const head = final
    ? `Finished triaging "${config.title}" in pare (session ${session.id}): ${tally(session) || "no decisions"}` +
      (undecided ? `, ${undecided} left undecided.` : ".")
    : `Progress on "${config.title}" in pare (session ${session.id}): ${decided} of ${total} decided` +
      (decided ? ` (${tally(session)}).` : ".") +
      " I am still going; act on these when it helps.";

  // The decisions themselves are reserved first: an id and an action for
  // every item, which always fits. The titles come next, and the model wrote
  // those, so they are the first thing given up. The notes are last, and are
  // cut short before any of them is dropped.
  const build = (withTitles: boolean, notes: Notes) => {
    const sections: string[] = [];
    for (const actionId of countDecisions(session).keys()) {
      const lines = config.items
        .filter((item) => session.decisions[item.id]?.action === actionId)
        .map(
          (item) =>
            (withTitles ? `- ${item.title} (id: ${item.id})` : `- ${item.id}`) +
            notes.text(item.id),
        );
      if (lines.length === 0) continue;
      sections.push(`${actionLabel(config, actionId)} (${lines.length}):\n${lines.join("\n")}`);
    }
    if (undecided > 0) {
      const lines = session.queue
        .map((id) => byId.get(id))
        .filter((item) => item !== undefined)
        .map((item) => (withTitles ? `- ${item.title} (id: ${item.id})` : `- ${item.id}`));
      sections.push(`Undecided (${undecided}):\n${lines.join("\n")}`);
    }
    return sections.join("\n\n");
  };

  const room = LIST_BUDGET - head.length;
  const full = build(true, notesWithin(session, room));
  if (full.length <= room) return `${head}\n\n${full}`.trim();

  const floor = length(config.items.map((item) => `- ${item.id}`)) + 200;
  const notes = notesWithin(session, room - floor);
  const body = fit(build(false, notes).split("\n"), room - 120);
  const gave = ["item titles", notes.gave_up].filter(Boolean).join(", ");
  return `${head}\n\n${body}\n\n(Dropped to fit: ${gave}.)`.trim();
}
