// MCP-endpoint auth wiring shared by every bridge: verify the bearer JWE and
// expose the upstream credential to tool handlers.

import { withMcpAuth } from "mcp-handler";
import { verifyAccessToken } from "./verify";
import type { OAuthConfig } from "./types";

type McpHandler = (req: Request) => Promise<Response>;

// Wrap a createMcpHandler result so every request must carry a valid access
// token; the embedded upstream credential lands in authInfo.extra.
export function protectMcpHandler(
  handler: McpHandler,
  servicePath: string,
  getOAuthConfig: () => OAuthConfig,
): McpHandler {
  return withMcpAuth(
    handler,
    async (_req, bearer) => {
      if (!bearer) return undefined;
      const verified = await verifyAccessToken(bearer, getOAuthConfig());
      if (!verified) return undefined;
      return {
        token: bearer,
        clientId: verified.clientId,
        scopes: verified.scopes,
        extra: {
          upstreamAccessToken: verified.upstreamAccessToken,
          identity: verified.identity,
        },
      };
    },
    {
      required: true,
      resourceMetadataPath: `${servicePath}/.well-known/oauth-protected-resource`,
    },
  );
}

interface MaybeAuthInfo {
  authInfo?: { extra?: { upstreamAccessToken?: unknown } };
}

// Pull the upstream credential out of a tool handler's `extra` argument.
// `label` names the credential in the failure message (e.g. "Hevy API key").
export function extractUpstreamToken(extra: unknown, label: string): string {
  const authInfo = (extra as MaybeAuthInfo).authInfo;
  const token = authInfo?.extra?.upstreamAccessToken;
  if (typeof token !== "string" || token.length === 0) {
    throw new Error(`missing upstream ${label} in auth context`);
  }
  return token;
}
