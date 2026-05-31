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
  const apex = stripTrailingSlash(required("PUBLIC_BASE_URL"));
  const baseUrl = `${apex}${SERVICE_PATH}`;
  const signingKey = decodeSigningKey(required("JWT_SIGNING_KEY"));

  const emails = parseList(process.env["ALLOWED_NOTION_EMAILS"]).map((s) => s.toLowerCase());
  const workspaceIds = parseList(process.env["ALLOWED_NOTION_WORKSPACE_IDS"]);
  if (emails.length === 0 && workspaceIds.length === 0) {
    throw new Error(
      "At least one of ALLOWED_NOTION_EMAILS or ALLOWED_NOTION_WORKSPACE_IDS must be set.",
    );
  }

  return {
    oauth: { baseUrl, signingKey },
    notion: {
      clientId: required("NOTION_OAUTH_CLIENT_ID"),
      clientSecret: required("NOTION_OAUTH_CLIENT_SECRET"),
      redirectUri: `${baseUrl}/oauth/notion-callback`,
    },
    allowlist: { emails, workspaceIds },
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
