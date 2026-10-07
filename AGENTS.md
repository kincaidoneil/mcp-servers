<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.

<!-- END:nextjs-agent-rules -->

# Workouts (MCP events)

`app/workouts/` is one MCP server over Hevy and Intervals.icu that publishes `workout.completed` events the way ChatGPT consumes them (MCP Events: `events/list`, `events/subscribe`, `events/unsubscribe`, then signed webhook POSTs to the subscriber's callback). Events need MCP 2.0 (`2026-07-28`), so this route runs on `@modelcontextprotocol/server` v2 rather than the `mcp-handler`/SDK v1 stack the other bridges use; v2 also serves 2025-era clients on the same URL.

Workouts enter from three places, all funnelling into `emit` in `_internal/events/dispatch.ts`: the Hevy webhook (registered programmatically on subscribe), the Intervals webhook (needs an Intervals OAuth app), and Intervals polling in `/workouts/tick`. The tick also retries the delivery outbox. A QStash schedule drives it (`pnpm schedule:workouts`) because Vercel Hobby crons run daily.

`_internal/tests/e2e.test.ts` drives the whole path through the real route handlers with Hevy and Intervals mocked; extend it rather than adding narrow tests. Outbound callbacks go through `createSafeCallbackFetch`, which pins connections to vetted public addresses; tests swap it via `setDepsForTesting`. `NETWORK_TESTS=1 pnpm test` adds the one test that needs real DNS.
