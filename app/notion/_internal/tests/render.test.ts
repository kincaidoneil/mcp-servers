import { describe, expect, test } from "vitest";
import { renderProperty, extractPageTitle } from "../render";

describe("renderProperty", () => {
  test("title concatenates plain_text fragments", () => {
    expect(
      renderProperty({
        type: "title",
        title: [{ plain_text: "Hello, " }, { plain_text: "world" }],
      }),
    ).toBe("Hello, world");
  });

  test("rich_text concatenates plain_text fragments", () => {
    expect(
      renderProperty({
        type: "rich_text",
        rich_text: [{ plain_text: "line one" }, { plain_text: "\nline two" }],
      }),
    ).toBe("line one\nline two");
  });

  test("number formats as string", () => {
    expect(renderProperty({ type: "number", number: 42 })).toBe("42");
    expect(renderProperty({ type: "number", number: null })).toBe("");
  });

  test("select returns option name", () => {
    expect(renderProperty({ type: "select", select: { name: "Done" } })).toBe("Done");
    expect(renderProperty({ type: "select", select: null })).toBe("");
  });

  test("status returns option name", () => {
    expect(renderProperty({ type: "status", status: { name: "In Progress" } })).toBe("In Progress");
  });

  test("multi_select joins option names with commas", () => {
    expect(
      renderProperty({
        type: "multi_select",
        multi_select: [{ name: "urgent" }, { name: "personal" }],
      }),
    ).toBe("urgent, personal");
  });

  test("date renders single start as ISO", () => {
    expect(renderProperty({ type: "date", date: { start: "2026-05-27" } })).toBe("2026-05-27");
  });

  test("date renders range with arrow", () => {
    expect(renderProperty({ type: "date", date: { start: "2026-05-27", end: "2026-05-29" } })).toBe(
      "2026-05-27 → 2026-05-29",
    );
  });

  test("checkbox renders true/false", () => {
    expect(renderProperty({ type: "checkbox", checkbox: true })).toBe("true");
    expect(renderProperty({ type: "checkbox", checkbox: false })).toBe("false");
  });

  test("url, email, phone_number render raw", () => {
    expect(renderProperty({ type: "url", url: "https://example.com" })).toBe("https://example.com");
    expect(renderProperty({ type: "email", email: "a@b.com" })).toBe("a@b.com");
    expect(renderProperty({ type: "phone_number", phone_number: "+15551234567" })).toBe(
      "+15551234567",
    );
    expect(renderProperty({ type: "url", url: null })).toBe("");
  });

  test("people joins user IDs", () => {
    expect(
      renderProperty({
        type: "people",
        people: [{ id: "u-1" }, { id: "u-2" }],
      }),
    ).toBe("u-1, u-2");
  });

  test("relation joins page IDs", () => {
    expect(
      renderProperty({
        type: "relation",
        relation: [{ id: "p-1" }, { id: "p-2" }],
      }),
    ).toBe("p-1, p-2");
  });

  test("created_time and last_edited_time render ISO directly", () => {
    expect(renderProperty({ type: "created_time", created_time: "2026-05-27T20:00:00Z" })).toBe(
      "2026-05-27T20:00:00Z",
    );
    expect(
      renderProperty({
        type: "last_edited_time",
        last_edited_time: "2026-05-27T20:00:00Z",
      }),
    ).toBe("2026-05-27T20:00:00Z");
  });

  test("created_by and last_edited_by render user ID", () => {
    expect(renderProperty({ type: "created_by", created_by: { id: "u-1" } })).toBe("u-1");
    expect(renderProperty({ type: "last_edited_by", last_edited_by: { id: "u-1" } })).toBe("u-1");
  });

  test("formula renders inner value", () => {
    expect(
      renderProperty({ type: "formula", formula: { type: "string", string: "computed" } }),
    ).toBe("computed");
    expect(renderProperty({ type: "formula", formula: { type: "number", number: 5 } })).toBe("5");
    expect(renderProperty({ type: "formula", formula: { type: "boolean", boolean: true } })).toBe(
      "true",
    );
    expect(
      renderProperty({
        type: "formula",
        formula: { type: "date", date: { start: "2026-01-01" } },
      }),
    ).toBe("2026-01-01");
  });

  test("rollup renders inner array/number/date", () => {
    expect(
      renderProperty({
        type: "rollup",
        rollup: { type: "number", number: 100 },
      }),
    ).toBe("100");
    expect(
      renderProperty({
        type: "rollup",
        rollup: {
          type: "array",
          array: [
            { type: "number", number: 1 },
            { type: "number", number: 2 },
          ],
        },
      }),
    ).toBe("1, 2");
    expect(
      renderProperty({
        type: "rollup",
        rollup: { type: "date", date: { start: "2026-01-01" } },
      }),
    ).toBe("2026-01-01");
  });

  test("files renders file names joined", () => {
    expect(
      renderProperty({
        type: "files",
        files: [{ name: "a.png" }, { name: "b.pdf" }],
      }),
    ).toBe("a.png, b.pdf");
  });

  test("unique_id renders prefix-number", () => {
    expect(renderProperty({ type: "unique_id", unique_id: { prefix: "TASK", number: 42 } })).toBe(
      "TASK-42",
    );
    expect(renderProperty({ type: "unique_id", unique_id: { prefix: null, number: 7 } })).toBe("7");
  });

  test("unknown property type returns JSON", () => {
    expect(renderProperty({ type: "future_unknown", future_unknown: { foo: "bar" } })).toBe(
      '{"foo":"bar"}',
    );
  });

  test("null/undefined property returns empty string", () => {
    expect(renderProperty(null)).toBe("");
    expect(renderProperty(undefined)).toBe("");
  });
});

describe("extractPageTitle", () => {
  test("returns the value of the first title property", () => {
    const properties = {
      Tags: { type: "multi_select", multi_select: [{ name: "a" }] },
      Name: { type: "title", title: [{ plain_text: "My page" }] },
    };
    expect(extractPageTitle(properties)).toBe("My page");
  });

  test("returns empty string when no title property exists", () => {
    expect(extractPageTitle({ Tags: { type: "multi_select", multi_select: [] } })).toBe("");
  });
});
