// The contract shared by the pare MCP tools (server) and the pare app (UI).
// Both sides parse with these schemas: the server validates tool input, the
// app validates what comes back from the host. Tool-facing field names are
// snake_case to match the other bridges.

import { z } from "zod";

// The two primary actions have fixed ids so the UI's left/right mechanics and
// the model's reading of results stay stable across sessions. Only their
// labels change per session ("Unsubscribe" vs "Delete" vs "Drop").
export const KEEP = "keep";
export const DISPOSE = "dispose";
export const SKIP = "skip";
const RESERVED_ACTION_IDS = new Set([KEEP, DISPOSE, SKIP]);

export const ActionLabelSchema = z.object({
  label: z.string().min(1).max(24).describe("Button label, e.g. 'Unsubscribe'."),
  hint: z
    .string()
    .max(120)
    .optional()
    .describe("One line under the label explaining the consequence."),
});
export type ActionLabel = z.infer<typeof ActionLabelSchema>;

export const ExtraActionSchema = z.object({
  id: z
    .string()
    .regex(/^[a-z][a-z0-9_-]{0,31}$/, "lowercase id, e.g. 'snooze'")
    .refine((id) => !RESERVED_ACTION_IDS.has(id), "keep, dispose, and skip are reserved"),
  label: z.string().min(1).max(24),
  hint: z.string().max(120).optional(),
  key: z
    .string()
    .length(1)
    .regex(/^[a-z0-9]$/)
    .optional()
    .describe("Single-character keyboard shortcut, active while the note field is empty."),
});
export type ExtraAction = z.infer<typeof ExtraActionSchema>;

export const ItemMetaSchema = z.object({
  label: z.string().min(1).max(40),
  value: z.string().min(1).max(200),
});

export const ItemSchema = z.object({
  id: z.string().min(1).max(200).describe("Stable id the caller can map back, e.g. a message id."),
  title: z.string().min(1).max(200),
  subtitle: z.string().max(200).optional().describe("Second line, e.g. sender or project."),
  body: z.string().max(6000).optional().describe("Plain text. Paragraphs split on blank lines."),
  meta: z
    .array(ItemMetaSchema)
    .max(8)
    .optional()
    .describe("Label/value pairs, e.g. Last opened: 14 months ago."),
  tags: z.array(z.string().min(1).max(32)).max(8).optional(),
  url: z.url().optional().describe("Opens in the host browser from the card."),
  suggestion: z
    .object({
      action: z.string().min(1).max(32).describe("keep, dispose, or an extra action id."),
      reason: z.string().max(200).optional(),
    })
    .optional()
    .describe("The agent's recommendation, shown on the card. The user still decides."),
});
export type Item = z.infer<typeof ItemSchema>;

export const SessionConfigSchema = z
  .object({
    title: z
      .string()
      .min(1)
      .max(120)
      .describe("What is being triaged, e.g. 'Newsletter subscriptions'."),
    description: z.string().max(300).optional().describe("One sentence framing the decision."),
    keep: ActionLabelSchema.default({ label: "Keep" }).describe("The right-swipe action."),
    dispose: ActionLabelSchema.default({ label: "Dispose" }).describe("The left-swipe action."),
    extra_actions: z
      .array(ExtraActionSchema)
      .max(4)
      .default([])
      .describe("Secondary buckets beyond keep/dispose, e.g. Snooze or Delegate."),
    notes: z
      .boolean()
      .default(true)
      .describe("Show the note field so the user can add commentary."),
    skip: z.boolean().default(true).describe("Allow deferring an item to the end of the stack."),
    items: z.array(ItemSchema).min(1).max(500),
  })
  .superRefine((config, ctx) => {
    const ids = new Set<string>();
    for (const [i, item] of config.items.entries()) {
      if (ids.has(item.id)) {
        ctx.addIssue({
          code: "custom",
          path: ["items", i, "id"],
          message: `duplicate item id ${item.id}`,
        });
      }
      ids.add(item.id);
    }
    const actionIds = new Set<string>([KEEP, DISPOSE]);
    for (const [i, action] of config.extra_actions.entries()) {
      if (actionIds.has(action.id)) {
        ctx.addIssue({
          code: "custom",
          path: ["extra_actions", i, "id"],
          message: `duplicate action id ${action.id}`,
        });
      }
      actionIds.add(action.id);
    }
    for (const [i, item] of config.items.entries()) {
      if (item.suggestion && !actionIds.has(item.suggestion.action)) {
        ctx.addIssue({
          code: "custom",
          path: ["items", i, "suggestion", "action"],
          message: `unknown action ${item.suggestion.action}`,
        });
      }
    }
  });
export type SessionConfig = z.infer<typeof SessionConfigSchema>;
export type SessionConfigInput = z.input<typeof SessionConfigSchema>;

export const DecisionSchema = z.object({
  item_id: z.string().min(1),
  action: z.string().min(1).describe("keep, dispose, or an extra action id."),
  note: z.string().max(2000).optional(),
  decided_at: z.iso.datetime(),
});
export type Decision = z.infer<typeof DecisionSchema>;

export const SessionStatusSchema = z.enum(["open", "done"]);
export type SessionStatus = z.infer<typeof SessionStatusSchema>;

// The persisted session. `queue` is the undecided item ids in display order;
// a skip rotates an id to the end, an undo puts it back at the front.
export const SessionSchema = z.object({
  id: z.string().min(1),
  owner: z.string().min(1),
  created_at: z.iso.datetime(),
  updated_at: z.iso.datetime(),
  version: z.number().int().nonnegative(),
  status: SessionStatusSchema,
  config: SessionConfigSchema,
  decisions: z.record(z.string(), DecisionSchema),
  queue: z.array(z.string()),
});
export type Session = z.infer<typeof SessionSchema>;

export const SessionSummarySchema = z.object({
  id: z.string(),
  title: z.string(),
  status: SessionStatusSchema,
  total: z.number().int(),
  decided: z.number().int(),
  created_at: z.iso.datetime(),
  updated_at: z.iso.datetime(),
});
export type SessionSummary = z.infer<typeof SessionSummarySchema>;

// ---- Tool inputs and outputs ------------------------------------------------

// pare-start: the model opens a session. Returns StartResult to both the model
// and the app; the app then calls pare-load for the full session so the
// model's context does not carry every item twice.
export const StartInputSchema = SessionConfigSchema;
export const StartResultSchema = z.object({
  session_id: z.string(),
  title: z.string(),
  total: z.number().int(),
});
export type StartResult = z.infer<typeof StartResultSchema>;

// pare-resume: reopen an existing session in the app.
export const ResumeInputSchema = z.object({ session_id: z.string().min(1) });
export const ResumeResultSchema = StartResultSchema.extend({
  decided: z.number().int(),
  status: SessionStatusSchema,
});
export type ResumeResult = z.infer<typeof ResumeResultSchema>;

// pare-load (app only): the full session, including saved decisions.
export const LoadInputSchema = z.object({ session_id: z.string().min(1) });
export const LoadResultSchema = z.object({ session: SessionSchema });
export type LoadResult = z.infer<typeof LoadResultSchema>;

// pare-record (app only): a batch of changes since the last flush. Decisions
// upsert by item id, `undo` removes decisions, `queue` replaces the order of
// undecided ids. The server drops queue entries that are decided or unknown
// and appends undecided ids the client forgot, so a stale client cannot
// lose items.
export const RecordInputSchema = z.object({
  session_id: z.string().min(1),
  decisions: z.array(DecisionSchema).max(500).default([]),
  undo: z.array(z.string()).max(500).default([]),
  queue: z.array(z.string()).max(500).optional(),
  status: SessionStatusSchema.optional(),
});
export type RecordInput = z.input<typeof RecordInputSchema>;
export const RecordResultSchema = z.object({
  version: z.number().int(),
  decided: z.number().int(),
  total: z.number().int(),
  status: SessionStatusSchema,
});
export type RecordResult = z.infer<typeof RecordResultSchema>;

// pare-get-results: what the model reads back.
export const GetResultsInputSchema = z.object({ session_id: z.string().min(1) });
export const ResultDecisionSchema = z.object({
  item_id: z.string(),
  title: z.string(),
  action: z.string(),
  label: z.string(),
  note: z.string().optional(),
});
export const GetResultsResultSchema = z.object({
  session_id: z.string(),
  title: z.string(),
  status: SessionStatusSchema,
  total: z.number().int(),
  decided: z.number().int(),
  counts: z.record(z.string(), z.number().int()).describe("Decision count per action id."),
  decisions: z.array(ResultDecisionSchema),
  undecided: z.array(z.object({ item_id: z.string(), title: z.string() })),
});
export type GetResultsResult = z.infer<typeof GetResultsResultSchema>;

export const ListSessionsInputSchema = z.object({
  limit: z.number().int().min(1).max(50).default(10),
});
export const ListSessionsResultSchema = z.object({ sessions: z.array(SessionSummarySchema) });

// ---- Helpers used on both sides -------------------------------------------

export function actionLabel(config: SessionConfig, actionId: string): string {
  if (actionId === KEEP) return config.keep.label;
  if (actionId === DISPOSE) return config.dispose.label;
  return config.extra_actions.find((a) => a.id === actionId)?.label ?? actionId;
}

export function summarize(session: Session): SessionSummary {
  return {
    id: session.id,
    title: session.config.title,
    status: session.status,
    total: session.config.items.length,
    decided: Object.keys(session.decisions).length,
    created_at: session.created_at,
    updated_at: session.updated_at,
  };
}

export function toResults(session: Session): GetResultsResult {
  const byId = new Map(session.config.items.map((item) => [item.id, item]));
  const counts: Record<string, number> = {};
  const decisions = session.config.items
    .filter((item) => session.decisions[item.id])
    .map((item) => {
      const decision = session.decisions[item.id]!;
      counts[decision.action] = (counts[decision.action] ?? 0) + 1;
      const row: z.infer<typeof ResultDecisionSchema> = {
        item_id: item.id,
        title: item.title,
        action: decision.action,
        label: actionLabel(session.config, decision.action),
      };
      if (decision.note) row.note = decision.note;
      return row;
    });
  const undecided = session.queue
    .map((id) => byId.get(id))
    .filter((item): item is Item => item !== undefined)
    .map((item) => ({ item_id: item.id, title: item.title }));
  return {
    session_id: session.id,
    title: session.config.title,
    status: session.status,
    total: session.config.items.length,
    decided: decisions.length,
    counts,
    decisions,
    undecided,
  };
}

// Apply a pare-record batch to a session. Pure, so both the server and the
// app's optimistic state can share it.
export function applyRecord(
  session: Session,
  input: z.infer<typeof RecordInputSchema>,
  now: string,
): Session {
  const itemIds = new Set(session.config.items.map((item) => item.id));
  const decisions = { ...session.decisions };
  for (const id of input.undo) delete decisions[id];
  for (const decision of input.decisions) {
    if (itemIds.has(decision.item_id)) decisions[decision.item_id] = decision;
  }
  const requested = input.queue ?? session.queue;
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const id of requested) {
    if (itemIds.has(id) && !decisions[id] && !seen.has(id)) {
      seen.add(id);
      queue.push(id);
    }
  }
  for (const item of session.config.items) {
    if (!decisions[item.id] && !seen.has(item.id)) queue.push(item.id);
  }
  return {
    ...session,
    decisions,
    queue,
    status: input.status ?? session.status,
    updated_at: now,
    version: session.version + 1,
  };
}
