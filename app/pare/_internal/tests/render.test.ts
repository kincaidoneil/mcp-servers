import { describe, expect, test } from "vitest";
import { renderResults, renderSessionList } from "../render";
import type { GetResultsResult } from "../schema";

const results: GetResultsResult = {
  session_id: "abc",
  title: "Newsletter subscriptions",
  status: "open",
  total: 6,
  decided: 4,
  counts: { dispose: 2, keep: 1, snooze: 1 },
  decisions: [
    { item_id: "1", title: "Stratechery", action: "keep", label: "Stay subscribed" },
    { item_id: "2", title: "Morning Brew", action: "dispose", label: "Unsubscribe" },
    {
      item_id: "3",
      title: "The Hustle",
      action: "dispose",
      label: "Unsubscribe",
      note: "keep the Sunday edition only",
    },
    { item_id: "4", title: "Money Stuff", action: "snooze", label: "Snooze" },
  ],
  undecided: [
    { item_id: "5", title: "Platformer" },
    { item_id: "6", title: "Not Boring" },
  ],
};

describe("renderResults", () => {
  test("groups by action label with dispose first, then notes and undecided", () => {
    expect(renderResults(results)).toBe(
      [
        "Newsletter subscriptions: 4 of 6 decided, session open",
        "Unsubscribe (2): Morning Brew; The Hustle",
        "Stay subscribed (1): Stratechery",
        "Snooze (1): Money Stuff",
        "Notes:",
        '- The Hustle: "keep the Sunday edition only"',
        "Undecided (2): Platformer; Not Boring",
      ].join("\n"),
    );
  });

  test("omits empty sections", () => {
    expect(
      renderResults({
        ...results,
        status: "done",
        decided: 0,
        counts: {},
        decisions: [],
        undecided: [],
      }),
    ).toBe("Newsletter subscriptions: 0 of 6 decided, session done");
  });
});

describe("renderSessionList", () => {
  test("renders an aligned table", () => {
    const text = renderSessionList([
      {
        id: "abcdefghjkmn",
        title: "Newsletter subscriptions",
        status: "open",
        total: 42,
        decided: 30,
        created_at: "2026-09-01T00:00:00.000Z",
        updated_at: "2026-09-03T10:00:00.000Z",
      },
      {
        id: "p2q3r4s5t6u7",
        title: "Old tasks",
        status: "done",
        total: 5,
        decided: 5,
        created_at: "2026-08-01T00:00:00.000Z",
        updated_at: "2026-08-02T00:00:00.000Z",
      },
    ]);
    expect(text).toBe(
      [
        "id            title                     decided  status  updated",
        "abcdefghjkmn  Newsletter subscriptions  30/42    open    2026-09-03T10:00:00.000Z",
        "p2q3r4s5t6u7  Old tasks                 5/5      done    2026-08-02T00:00:00.000Z",
      ].join("\n"),
    );
    expect(renderSessionList([])).toBe("No pare sessions yet.");
  });
});
