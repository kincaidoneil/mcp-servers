import path from "node:path";

export interface PareConfig {
  ui: { htmlPath: string };
}

let cached: PareConfig | null = null;

export function getConfig(): PareConfig {
  if (cached) return cached;
  cached = {
    ui: {
      // PARE_UI_HTML_PATH lets tests point at a stand-in file.
      htmlPath:
        process.env["PARE_UI_HTML_PATH"] ??
        path.join(process.cwd(), "app", "pare", "_internal", "ui", "dist", "index.html"),
    },
  };
  return cached;
}

export function resetConfigCacheForTesting() {
  cached = null;
}
