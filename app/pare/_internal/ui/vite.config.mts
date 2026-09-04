// Builds the pare app into one self-contained HTML file. MCP hosts load the
// app from a resource string into a sandboxed iframe with no same-origin
// server, so every script and stylesheet has to be inlined.
//
// `harness.html` (the local host used for development and E2E) is served by
// the dev server only; the production build emits `dist/index.html` alone.

import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { viteSingleFile } from "vite-plugin-singlefile";

const root = import.meta.dirname;
const repoRoot = path.resolve(root, "../../../..");
// Override so parallel checkouts can run their own harness.
const port = Number(process.env["PARE_UI_PORT"] ?? 5173);

export default defineConfig({
  root,
  plugins: [react(), viteSingleFile()],
  resolve: { alias: { "@": repoRoot } },
  build: {
    outDir: path.join(root, "dist"),
    emptyOutDir: true,
    target: "es2022",
    rollupOptions: { input: path.join(root, "index.html") },
  },
  server: {
    port,
    strictPort: true,
    fs: { allow: [repoRoot] },
  },
  preview: { port, strictPort: true },
});
