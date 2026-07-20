import { loadOAuthConfigFromEnv, parseList } from "@/lib/oauth-as";
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
  const userIds = parseList(process.env["ALLOWED_HEVY_USER_IDS"]);
  if (userIds.length === 0) {
    throw new Error("ALLOWED_HEVY_USER_IDS must be set.");
  }

  return {
    oauth: loadOAuthConfigFromEnv(SERVICE_PATH),
    allowlist: { userIds },
    // Hevy's API is metric UTC and carries no timezone anywhere (workouts and
    // user info alike), so display preferences have to live on our side.
    display: { timeZone: "America/New_York", units: "imperial" },
  };
}
