import path from "node:path";
import { loadOAuthConfigFromEnv } from "@/lib/oauth-as";
import type { OAuthConfig } from "@/lib/oauth-as";

const SERVICE_PATH = "/pare";

// Sessions live this long after their last update. Long enough that a
// triage started and abandoned still resumes months later.
const SESSION_TTL_SECONDS = 90 * 24 * 60 * 60;

export type StoreConfig = { kind: "redis"; url: string; token: string } | { kind: "memory" };

export interface PareConfig {
  oauth: OAuthConfig;
  // User name -> access code. The name is the session owner.
  accessCodes: Map<string, string>;
  ui: { htmlPath: string };
  store: StoreConfig;
  sessionTtlSeconds: number;
}

let cached: PareConfig | null = null;

export function getConfig(): PareConfig {
  if (cached) return cached;
  cached = loadConfig();
  return cached;
}

export function resetConfigCacheForTesting() {
  cached = null;
}

function loadConfig(): PareConfig {
  const accessCodes = parseAccessCodes(process.env["PARE_ACCESS_CODES"]);
  if (accessCodes.size === 0) {
    throw new Error("PARE_ACCESS_CODES must be set (comma-separated name:code pairs).");
  }
  const store = loadStoreConfig();
  if (store.kind === "memory" && process.env["NODE_ENV"] === "production") {
    // oxlint-disable-next-line no-console
    console.warn(
      "pare: no Upstash Redis configured; sessions are held in memory and will not survive a cold start.",
    );
  }
  return {
    oauth: loadOAuthConfigFromEnv(SERVICE_PATH),
    accessCodes,
    ui: {
      htmlPath:
        process.env["PARE_UI_HTML_PATH"] ??
        path.join(process.cwd(), "app", "pare", "_internal", "ui", "dist", "index.html"),
    },
    store,
    sessionTtlSeconds: SESSION_TTL_SECONDS,
  };
}

// "kincaid:abc123,guest:def456". Split each pair on the first colon so a
// code may itself contain colons.
export function parseAccessCodes(raw: string | undefined): Map<string, string> {
  const codes = new Map<string, string>();
  for (const pair of (raw ?? "").split(",")) {
    const colon = pair.indexOf(":");
    if (colon < 0) continue;
    const name = pair.slice(0, colon).trim();
    const code = pair.slice(colon + 1).trim();
    if (name.length === 0 || code.length === 0) continue;
    codes.set(name, code);
  }
  return codes;
}

// The Vercel Marketplace Upstash integration sets KV_REST_API_*; a manually
// configured Upstash database uses UPSTASH_REDIS_REST_*.
function loadStoreConfig(): StoreConfig {
  const pairs: [string, string][] = [
    ["UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN"],
    ["KV_REST_API_URL", "KV_REST_API_TOKEN"],
  ];
  for (const [urlName, tokenName] of pairs) {
    const url = process.env[urlName];
    const token = process.env[tokenName];
    if (url && token) return { kind: "redis", url, token };
  }
  return { kind: "memory" };
}
