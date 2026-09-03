// Text renderings of pare results for the model-facing content block.

import { DISPOSE, KEEP, type GetResultsResult, type SessionSummary } from "./schema";

export function renderResults(results: GetResultsResult): string {
  const lines = [
    `${results.title}: ${results.decided} of ${results.total} decided, session ${results.status}`,
  ];

  // Dispose first (the bucket the model usually acts on), then keep, then the
  // extra actions in the order they first appear.
  const order: string[] = [];
  for (const action of [DISPOSE, KEEP]) {
    if (results.decisions.some((d) => d.action === action)) order.push(action);
  }
  for (const decision of results.decisions) {
    if (!order.includes(decision.action)) order.push(decision.action);
  }
  for (const action of order) {
    const group = results.decisions.filter((d) => d.action === action);
    const label = group[0]?.label ?? action;
    lines.push(`${label} (${group.length}): ${group.map((d) => d.title).join("; ")}`);
  }

  const noted = results.decisions.filter((d) => d.note);
  if (noted.length > 0) {
    lines.push("Notes:");
    for (const d of noted) lines.push(`- ${d.title}: ${JSON.stringify(d.note)}`);
  }

  if (results.undecided.length > 0) {
    lines.push(
      `Undecided (${results.undecided.length}): ${results.undecided.map((u) => u.title).join("; ")}`,
    );
  }
  return lines.join("\n");
}

export function renderSessionList(sessions: SessionSummary[]): string {
  if (sessions.length === 0) return "No pare sessions yet.";
  const rows = sessions.map((s) => [
    s.id,
    s.title,
    `${s.decided}/${s.total}`,
    s.status,
    s.updated_at,
  ]);
  const header = ["id", "title", "decided", "status", "updated"];
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)));
  const line = (cells: string[]) =>
    cells
      .map((c, i) => c.padEnd(widths[i]!))
      .join("  ")
      .trimEnd();
  return [line(header), ...rows.map(line)].join("\n");
}
