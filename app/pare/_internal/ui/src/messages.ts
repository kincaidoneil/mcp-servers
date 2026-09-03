// Text the app sends back to the chat. Two channels: `updateModelContext`
// (quiet, replaces the previous update, read on the model's next turn) and
// `sendMessage` (posts as the user and triggers a reply).

import { actionLabel, DISPOSE, KEEP, type Session } from "../../schema";

const MESSAGE_LIMIT = 12_000;

function actionOrder(session: Session): string[] {
  return [DISPOSE, KEEP, ...session.config.extra_actions.map((a) => a.id)];
}

function counts(session: Session): Map<string, number> {
  const out = new Map<string, number>();
  for (const id of actionOrder(session)) out.set(id, 0);
  for (const decision of Object.values(session.decisions)) {
    out.set(decision.action, (out.get(decision.action) ?? 0) + 1);
  }
  return out;
}

function countsLine(session: Session): string {
  return [...counts(session)]
    .filter(([, n]) => n > 0)
    .map(([id, n]) => `${n} ${actionLabel(session.config, id).toLowerCase()}`)
    .join(", ");
}

export function progressContext(session: Session): string {
  const decided = Object.keys(session.decisions).length;
  const total = session.config.items.length;
  const tally = countsLine(session);
  const state =
    session.status === "done"
      ? "Finished."
      : `Still in progress; the user has not sent results yet.`;
  return (
    `Pare session ${session.id} "${session.config.title}": ${decided} of ${total} decided` +
    (tally ? ` (${tally}).` : ".") +
    ` ${state} Call pare-get-results for the full list.`
  );
}

export function resultsMessage(session: Session, final: boolean): string {
  const decided = Object.keys(session.decisions).length;
  const total = session.config.items.length;
  const undecided = session.queue.length;
  const byId = new Map(session.config.items.map((item) => [item.id, item]));

  const head = final
    ? `Finished triaging "${session.config.title}" in pare (session ${session.id}): ${countsLine(session) || "no decisions"}` +
      (undecided ? `, ${undecided} left undecided.` : ".")
    : `Progress on "${session.config.title}" in pare (session ${session.id}): ${decided} of ${total} decided` +
      (countsLine(session) ? ` (${countsLine(session)}).` : ".") +
      " I am still going; act on these when it helps.";

  const sections: string[] = [];
  for (const actionId of actionOrder(session)) {
    const lines = session.config.items
      .filter((item) => session.decisions[item.id]?.action === actionId)
      .map((item) => {
        const decision = session.decisions[item.id]!;
        return (
          `- ${item.title} (id: ${item.id})` + (decision.note ? ` — note: ${decision.note}` : "")
        );
      });
    if (lines.length === 0) continue;
    sections.push(
      `${actionLabel(session.config, actionId)} (${lines.length}):\n${lines.join("\n")}`,
    );
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
    body =
      "The list is long, so it is not repeated here. Call pare-get-results with session id " +
      `${session.id} for every decision with ids and notes.`;
  }
  return `${head}\n\n${body}`.trim();
}
