// Text the app sends back to the chat. Two channels: `updateModelContext`
// after every change (quiet; the host keeps only the latest, so each update
// carries the whole session state) and `sendMessage` for the final list
// (posts as the user and triggers a reply).

import { actionLabel, countDecisions, type Session } from "../../schema";

const MESSAGE_LIMIT = 12_000;
const CONTEXT_LIMIT = 24_000;

function tally(session: Session): string {
  return [...countDecisions(session)]
    .filter(([, n]) => n > 0)
    .map(([id, n]) => `${n} ${actionLabel(session.config, id).toLowerCase()}`)
    .join(", ");
}

function decisionLines(session: Session, withTitles: boolean): string[] {
  const byId = new Map(session.config.items.map((item) => [item.id, item]));
  return Object.values(session.decisions)
    .toSorted((a, b) => (a.decided_at ?? "").localeCompare(b.decided_at ?? ""))
    .map((decision) => {
      const title = withTitles ? `${byId.get(decision.item_id)?.title ?? ""} ` : "";
      const note = decision.note ? ` (note: ${decision.note})` : "";
      return withTitles
        ? `- ${title}(id: ${decision.item_id}): ${decision.action}${note}`
        : `${decision.item_id}: ${decision.action}${note}`;
    });
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
  let list = decisionLines(session, false).join("\n");
  if (list.length > CONTEXT_LIMIT) {
    list = list.slice(0, CONTEXT_LIMIT) + "\n(list truncated; the app has the rest)";
  }
  const text =
    `Pare session ${session.id} "${config.title}": ${decided} of ${total} decided` +
    (decided ? ` (${tally(session)}).` : ".") +
    ` ${state}\n` +
    (decided ? `Decisions so far (item id: action), where ${legend}:\n${list}\n` : "") +
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

  const sections: string[] = [];
  for (const actionId of countDecisions(session).keys()) {
    const lines = config.items
      .filter((item) => session.decisions[item.id]?.action === actionId)
      .map((item) => {
        const decision = session.decisions[item.id]!;
        return (
          `- ${item.title} (id: ${item.id})` + (decision.note ? ` (note: ${decision.note})` : "")
        );
      });
    if (lines.length === 0) continue;
    sections.push(`${actionLabel(config, actionId)} (${lines.length}):\n${lines.join("\n")}`);
  }
  if (undecided > 0) {
    const lines = session.queue
      .map((id) => byId.get(id))
      .filter((item) => item !== undefined)
      .map((item) => `- ${item.title} (id: ${item.id})`);
    sections.push(`Undecided (${undecided}):\n${lines.join("\n")}`);
  }

  let body = sections.join("\n\n");
  if (head.length + body.length > MESSAGE_LIMIT) {
    body = decisionLines(session, false).join("\n").slice(0, MESSAGE_LIMIT) + "\n(truncated)";
  }
  return `${head}\n\n${body}`.trim();
}
