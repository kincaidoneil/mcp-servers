import { encryptJwe, verifyJws } from "./jwt";
import type { AsStateClaims, AuthCodeClaims, OAuthConfig } from "./types";
import { TTL } from "./types";

export type AsStateResult =
  | { ok: true; state: AsStateClaims }
  | {
      ok: false;
      reason:
        | "missing"
        | "malformed"
        | "expired"
        | "bad-signature"
        | "wrong-type"
        | "bad-encryption";
    };

export async function decodeAsState(
  asState: string | null,
  config: OAuthConfig,
): Promise<AsStateResult> {
  if (!asState) return { ok: false, reason: "missing" };
  const result = await verifyJws<AsStateClaims>(asState, config.signingKey, "as-state");
  return result.ok ? { ok: true, state: result.payload } : { ok: false, reason: result.reason };
}

export async function buildClientCallbackUrl(
  asState: AsStateClaims,
  upstreamAccessToken: string,
  identity: Record<string, unknown>,
  config: OAuthConfig,
): Promise<string> {
  const codeClaims: AuthCodeClaims = {
    typ: "code",
    client_id: asState.client_id,
    redirect_uri: asState.redirect_uri,
    code_challenge: asState.code_challenge,
    code_challenge_method: asState.code_challenge_method,
    upstream_access_token: upstreamAccessToken,
    identity,
    scope: asState.scope,
  };
  const code = await encryptJwe(codeClaims, config.signingKey, TTL.authCode);

  const url = new URL(asState.redirect_uri);
  url.searchParams.set("code", code);
  if (asState.client_state) url.searchParams.set("state", asState.client_state);
  return url.toString();
}

export function buildClientErrorUrl(
  asState: AsStateClaims,
  error: string,
  errorDescription: string,
): string {
  const url = new URL(asState.redirect_uri);
  url.searchParams.set("error", error);
  url.searchParams.set("error_description", errorDescription);
  if (asState.client_state) url.searchParams.set("state", asState.client_state);
  return url.toString();
}

export function checkAllowlist(
  identity: { email?: string | null; workspaceId?: string | null },
  allowedEmails: string[],
  allowedWorkspaceIds: string[],
): boolean {
  if (identity.email && allowedEmails.includes(identity.email.toLowerCase())) return true;
  if (identity.workspaceId && allowedWorkspaceIds.includes(identity.workspaceId)) return true;
  return false;
}
