import { decryptJwe } from "./jwt";
import type { AccessTokenClaims, OAuthConfig } from "./types";

export interface VerifiedAccessToken {
  clientId: string;
  upstreamAccessToken: string;
  identity: Record<string, unknown>;
  scopes: string[];
}

export async function verifyAccessToken(
  bearer: string,
  config: OAuthConfig,
): Promise<VerifiedAccessToken | undefined> {
  const decoded = await decryptJwe<AccessTokenClaims>(bearer, config.signingKey, "access");
  if (!decoded.ok) return undefined;
  const c = decoded.payload;
  return {
    clientId: c.client_id,
    upstreamAccessToken: c.upstream_access_token,
    identity: c.identity,
    scopes: c.scope ? c.scope.split(/\s+/).filter(Boolean) : [],
  };
}
