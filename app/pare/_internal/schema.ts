// The contract shared by the pare MCP tool (server) and the pare app (UI).
// Both sides parse with these schemas: the server validates tool input, the
// app validates the tool input the host replays to it. Tool-facing field
// names are snake_case to match the other bridges.
//
// Pare holds no server state. A session lives in the app's browser storage
// and in the context updates the app sends the model after every decision;
// the model can reopen a session by calling pare-start again with the same
// session_id and the decisions it has seen.

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
});
export type ActionLabel = z.infer<typeof ActionLabelSchema>;

export const ExtraActionSchema = z.object({
  id: z
    .string()
    .regex(/^[a-z][a-z0-9_-]{0,31}$/, "lowercase id, e.g. 'snooze'")
    .refine((id) => !RESERVED_ACTION_IDS.has(id), "keep, dispose, and skip are reserved"),
  label: z.string().min(1).max(24),
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
  body: z
    .string()
    .max(600)
    .optional()
    .describe(
      "One to three short sentences. The card shows four lines at most; there is no expand.",
    ),
  meta: z
    .array(ItemMetaSchema)
    .max(3)
    .optional()
    .describe("Up to three label/value facts, shown on one line, e.g. Last opened / 7 months ago."),
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

export const DecisionSchema = z.object({
  item_id: z.string().min(1),
  action: z.string().min(1).describe("keep, dispose, or an extra action id."),
  note: z.string().max(2000).optional(),
  decided_at: z.iso.datetime().optional().describe("Set by the app; omit when restoring."),
});
export type Decision = z.infer<typeof DecisionSchema>;

const SessionConfigBaseSchema = z.object({
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
    .describe(
      "Secondary buckets beyond keep/dispose, e.g. Snooze or Delegate. Keys 1 to 4 in the app.",
    ),
  notes: z.boolean().default(true).describe("Show the note field so the user can add commentary."),
  skip: z.boolean().default(true).describe("Allow deferring an item to the end of the stack."),
  items: z.array(ItemSchema).min(1).max(500),
});

type ConfigShape = z.infer<typeof SessionConfigBaseSchema>;

function actionIdsOf(config: ConfigShape): Set<string> {
  return new Set([KEEP, DISPOSE, ...config.extra_actions.map((a) => a.id)]);
}

function refineConfig(config: ConfigShape, ctx: z.RefinementCtx) {
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
}

export const SessionConfigSchema = SessionConfigBaseSchema.superRefine(refineConfig);
export type SessionConfig = z.infer<typeof SessionConfigSchema>;
export type SessionConfigInput = z.input<typeof SessionConfigSchema>;

export const SessionStatusSchema = z.enum(["open", "done"]);
export type SessionStatus = z.infer<typeof SessionStatusSchema>;

// The app's session. `queue` is the undecided item ids in display order; a
// skip rotates an id to the end, an undo puts it back at the front.
export const SessionSchema = z.object({
  id: z.string().min(1),
  config: SessionConfigSchema,
  decisions: z.record(z.string(), DecisionSchema),
  queue: z.array(z.string()),
  status: SessionStatusSchema,
  updated_at: z.iso.datetime(),
});
export type Session = z.infer<typeof SessionSchema>;

// ---- pare-start ---------------------------------------------------------------

export const SESSION_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{2,39}$/;

// The un-refined shape is what the MCP SDK advertises as the input schema; the
// handler and the app parse with the refined StartInputSchema.
export const StartInputBaseSchema = SessionConfigBaseSchema.extend({
  session_id: z
    .string()
    .regex(SESSION_ID_PATTERN, "3 to 40 chars: lowercase letters, digits, - or _")
    .optional()
    .describe(
      "Continue an earlier session: pass the id from its context update. Omit to start a new one.",
    ),
  decisions: z
    .array(DecisionSchema)
    .max(500)
    .default([])
    .describe(
      "Decisions to restore when continuing a session, copied from its last context update. " +
        "Items not listed here start undecided.",
    ),
});

export const StartInputSchema = StartInputBaseSchema.superRefine((input, ctx) => {
  refineConfig(input, ctx);
  const itemIds = new Set(input.items.map((item) => item.id));
  const actionIds = actionIdsOf(input);
  for (const [i, decision] of input.decisions.entries()) {
    if (!itemIds.has(decision.item_id)) {
      ctx.addIssue({
        code: "custom",
        path: ["decisions", i, "item_id"],
        message: `no item with id ${decision.item_id}`,
      });
    }
    if (!actionIds.has(decision.action)) {
      ctx.addIssue({
        code: "custom",
        path: ["decisions", i, "action"],
        message: `unknown action ${decision.action}`,
      });
    }
  }
});
export type StartInput = z.infer<typeof StartInputSchema>;

export const StartResultSchema = z.object({
  session_id: z.string(),
  title: z.string(),
  total: z.number().int(),
  decided: z.number().int(),
});
export type StartResult = z.infer<typeof StartResultSchema>;

// ---- Helpers used on both sides -------------------------------------------

export function actionLabel(config: SessionConfig, actionId: string): string {
  if (actionId === KEEP) return config.keep.label;
  if (actionId === DISPOSE) return config.dispose.label;
  return config.extra_actions.find((a) => a.id === actionId)?.label ?? actionId;
}

// Turn validated pare-start input into a session. Restored decisions keep
// their timestamps; the queue is every item not yet decided, in order.
export function buildSession(input: StartInput, sessionId: string, now: string): Session {
  const { session_id: _ignored, decisions: seed, ...config } = input;
  const decisions: Record<string, Decision> = {};
  for (const decision of seed) decisions[decision.item_id] = decision;
  return {
    id: sessionId,
    config,
    decisions,
    queue: config.items.filter((item) => !decisions[item.id]).map((item) => item.id),
    status: "open",
    updated_at: now,
  };
}

export function countDecisions(session: Session): Map<string, number> {
  const counts = new Map<string, number>();
  for (const id of [DISPOSE, KEEP, ...session.config.extra_actions.map((a) => a.id)]) {
    counts.set(id, 0);
  }
  for (const decision of Object.values(session.decisions)) {
    counts.set(decision.action, (counts.get(decision.action) ?? 0) + 1);
  }
  return counts;
}
