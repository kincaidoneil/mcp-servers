import type { OAuthConfig } from "@/lib/oauth-as";

// This service's URL path under the apex domain. Each service declares its
// own in its own config module. The apex (PUBLIC_BASE_URL) is shared across
// every service in this deployment.
const SERVICE_PATH = "/hevy";

export interface HevyConfig {
  oauth: OAuthConfig;
  allowlist: {
    userIds: string[];
  };
  display: {
    timeZone: string;
    units: "metric" | "imperial";
  };
}

let cached: HevyConfig | null = null;

export function getConfig(): HevyConfig {
  if (cached) return cached;
  cached = loadConfig();
  return cached;
}

// Test/dev hook — forget cached config to force a re-read of env on the next call.
export function resetConfigCacheForTesting() {
  cached = null;
}

function loadConfig(): HevyConfig {
  const apex = stripTrailingSlash(required("PUBLIC_BASE_URL"));
  const baseUrl = `${apex}${SERVICE_PATH}`;
  const signingKey = decodeSigningKey(required("JWT_SIGNING_KEY"));

  const userIds = parseList(process.env["ALLOWED_HEVY_USER_IDS"]);
  if (userIds.length === 0) {
    throw new Error("ALLOWED_HEVY_USER_IDS must be set.");
  }

  return {
    oauth: { baseUrl, signingKey },
    allowlist: { userIds },
    // Hevy's API is metric UTC and carries no timezone anywhere (workouts and
    // user info alike), so display preferences have to live on our side.
    display: { timeZone: "America/New_York", units: "imperial" },
  };
}

function stripTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

function decodeSigningKey(raw: string): Uint8Array {
  const bytes = Buffer.from(raw, "base64");
  if (bytes.length < 32) {
    throw new Error(
      `JWT_SIGNING_KEY must be ≥32 bytes (got ${bytes.length}). Generate with: openssl rand -base64 32`,
    );
  }
  return new Uint8Array(bytes.subarray(0, 32));
}

function parseList(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}
