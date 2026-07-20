import { loadOAuthConfigFromEnv, parseList, requiredEnv } from "@/lib/oauth-as";
import type { OAuthConfig } from "@/lib/oauth-as";

// This service's URL path under the apex domain. Each service declares its
// own (e.g. "/strava") in its own config module. The apex (PUBLIC_BASE_URL)
// is shared across every service in this deployment.
const SERVICE_PATH = "/notion";

export interface NotionConfig {
  oauth: OAuthConfig;
  notion: {
    clientId: string;
    clientSecret: string;
    redirectUri: string;
  };
  allowlist: {
    emails: string[];
    workspaceIds: string[];
  };
}

let cached: NotionConfig | null = null;

export function getConfig(): NotionConfig {
  if (cached) return cached;
  cached = loadConfig();
  return cached;
}

// Test/dev hook — forget cached config to force a re-read of env on the next call.
export function resetConfigCacheForTesting() {
  cached = null;
}

function loadConfig(): NotionConfig {
  const oauth = loadOAuthConfigFromEnv(SERVICE_PATH);

  const emails = parseList(process.env["ALLOWED_NOTION_EMAILS"]).map((s) => s.toLowerCase());
  const workspaceIds = parseList(process.env["ALLOWED_NOTION_WORKSPACE_IDS"]);
  if (emails.length === 0 && workspaceIds.length === 0) {
    throw new Error(
      "At least one of ALLOWED_NOTION_EMAILS or ALLOWED_NOTION_WORKSPACE_IDS must be set.",
    );
  }

  return {
    oauth,
    notion: {
      clientId: requiredEnv("NOTION_OAUTH_CLIENT_ID"),
      clientSecret: requiredEnv("NOTION_OAUTH_CLIENT_SECRET"),
      redirectUri: `${oauth.baseUrl}/oauth/notion-callback`,
    },
    allowlist: { emails, workspaceIds },
  };
}
