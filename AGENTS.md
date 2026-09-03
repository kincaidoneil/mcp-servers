<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.

<!-- END:nextjs-agent-rules -->

# Pare (the MCP App)

`app/pare/` is a bridge like the others plus a UI. The contract between server and UI is `app/pare/_internal/schema.ts`; both sides parse with it, so change it there and nowhere else. The UI lives in `app/pare/_internal/ui/` (Vite, React, `motion`, plain CSS in `src/styles.css`) and builds to one HTML file that the server reads at `resources/read` time.

Work on the UI in the harness, not in Claude: `pnpm ui:dev`, then open `localhost:5173/harness.html`. `?src=dev` hot-reloads the source; the default `src=dist` loads the built file through `srcdoc` the way a host does, and is what `pnpm test:e2e` uses (it builds first). The harness answers `pare-load` and `pare-record` from sessionStorage and shows messages and model-context updates the app sends. Keyboard events from the Claude Code browser tool land on the harness page, not the iframe; dispatch them with `javascript_tool` or use Playwright.

`pnpm smoke:pare` exercises the real server over HTTP (OAuth, every tool, the resource read); run it after touching auth or tool wiring.
