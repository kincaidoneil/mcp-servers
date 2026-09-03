// E2E tests for the pare app run against the local harness (a stand-in MCP
// host) served by the Vite dev server, loading the production single-file
// build the way a real host would.

import { defineConfig, devices } from "@playwright/test";

const port = 5173;

export default defineConfig({
  testDir: "app/pare/_internal/ui/e2e",
  timeout: 30_000,
  expect: { timeout: 5_000 },
  fullyParallel: true,
  forbidOnly: !!process.env["CI"],
  retries: process.env["CI"] ? 2 : 0,
  reporter: process.env["CI"] ? "github" : "list",
  use: {
    baseURL: `http://localhost:${port}`,
    viewport: { width: 1000, height: 820 },
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "pnpm ui:build && pnpm ui:dev",
    url: `http://localhost:${port}/harness.html`,
    reuseExistingServer: !process.env["CI"],
    timeout: 120_000,
  },
});
