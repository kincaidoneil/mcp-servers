import { http, HttpResponse, type HttpHandler } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll } from "vitest";

export function setupNotionMockServer(initialHandlers: HttpHandler[] = []) {
  const server = setupServer(...initialHandlers);
  beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
  afterEach(() => server.resetHandlers());
  afterAll(() => server.close());
  return server;
}

export const NOTION_BASE = "https://api.notion.com/v1";

export function pageFixture(opts: {
  id: string;
  title?: string;
  url?: string;
  created_time?: string;
  last_edited_time?: string;
  properties?: Record<string, unknown>;
}) {
  return {
    object: "page",
    id: opts.id,
    url: opts.url ?? `https://www.notion.so/${opts.id.replace(/-/g, "")}`,
    created_time: opts.created_time ?? "2026-05-01T00:00:00.000Z",
    last_edited_time: opts.last_edited_time ?? "2026-05-27T00:00:00.000Z",
    in_trash: false,
    archived: false,
    properties: {
      Name: { type: "title", title: [{ plain_text: opts.title ?? "Untitled" }] },
      ...opts.properties,
    },
  };
}

export { http, HttpResponse };
