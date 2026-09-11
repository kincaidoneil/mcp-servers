// What reaches the model. A long session is the case worth pinning: the
// message has a size limit, and what it gives up to fit must never be a
// decision, or half of an item id that reads as a different item.

import { describe, expect, test } from "vitest";
import { buildSession, StartInputSchema } from "../schema";
import { contextUpdate, resultsMessage } from "../ui/src/messages";

const NOTE =
  "kept because the Q3 thread still references it and nobody has confirmed the migration is done";

function bigSession(count: number, withNotes: boolean) {
  const items = Array.from({ length: count }, (_, i) => ({
    id: `item-${i + 1}`,
    title: `Renewal notice for vendor ${i + 1} covering the ${2020 + (i % 6)} contract`,
  }));
  const input = StartInputSchema.parse({
    title: "Vendor renewals",
    items,
    decisions: items.map((item, i) => {
      const decision: Record<string, string> = {
        item_id: item.id,
        action: i % 3 === 0 ? "dispose" : "keep",
        decided_at: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
      };
      if (withNotes) decision["note"] = NOTE;
      return decision;
    }),
  });
  return buildSession(input, "vendors", new Date(Date.UTC(2026, 0, 2)).toISOString());
}

// Every id appears exactly once, whole, with an action after it.
function named(text: string): Set<string> {
  return new Set(text.match(/item-\d+(?=[:)])/g) ?? []);
}

describe("what a long session hands back", () => {
  test("the final message names every decision, notes or not", () => {
    for (const withNotes of [false, true]) {
      const session = bigSession(200, withNotes);
      const message = resultsMessage(session, true);
      expect(named(message).size, `200 items, notes: ${withNotes}`).toBe(200);
      expect(message).not.toMatch(/\(\d+ more not listed\)/);
    }
  });

  test("the message says what it gave up to fit", () => {
    const long = resultsMessage(bigSession(200, true), true);
    expect(long).toContain("titles and notes omitted");
    const short = resultsMessage(bigSession(4, true), true);
    expect(short).toContain("Renewal notice for vendor 1");
    expect(short).toContain(NOTE);
    expect(short).not.toContain("omitted");
  });

  // The schema allows 500 items with a 2000-character note each. Even that
  // comes back whole: what gives way is the prose around the decisions.
  test("nothing is lost at the largest session the schema allows", () => {
    const session = bigSession(500, true);
    for (const decision of Object.values(session.decisions)) decision.note = "n".repeat(2000);
    const message = resultsMessage(session, true);
    expect(named(message).size).toBe(500);
    // Never a half line: every id that made it has its action.
    for (const line of message.split("\n").filter((l) => /^item-\d+/.test(l))) {
      expect(line).toMatch(/^item-\d+: (keep|dispose)$/);
    }
  });

  test("the quiet context update carries the whole list", () => {
    const { text, structured } = contextUpdate(bigSession(200, true));
    expect(named(text).size).toBe(200);
    expect((structured["decisions"] as unknown[]).length).toBe(200);
  });
});
