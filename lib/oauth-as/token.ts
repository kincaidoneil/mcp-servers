import { z } from "zod";
import { decryptJwe, encryptJwe } from "./jwt";
import { verifyPkce } from "./pkce";
import type { AccessTokenClaims, AuthCodeClaims, OAuthConfig, RefreshTokenClaims } from "./types";
import { TTL } from "./types";

const TokenRequestSchema = z.discriminatedUnion("grant_type", [
  z.object({
    grant_type: z.literal("authorization_code"),
    code: z.string().min(1),
    redirect_uri: z.string().min(1),
    code_verifier: z.string().min(1),
    client_id: z.string().min(1).optional(),
  }),
  z.object({
    grant_type: z.literal("refresh_token"),
    refresh_token: z.string().min(1),
    scope: z.string().optional(),
    client_id: z.string().min(1).optional(),
  }),
]);

export interface TokenSuccess {
  access_token: string;
  refresh_token: string;
  token_type: "Bearer";
  expires_in: number;
  scope?: string;
}

export interface TokenError {
  error: "invalid_request" | "invalid_grant" | "unsupported_grant_type" | "invalid_scope";
  error_description: string;
  status: number;
}

export async function handleTokenRequest(
  rawBody: Record<string, string | null> | unknown,
  config: OAuthConfig,
): Promise<{ ok: true; response: TokenSuccess } | { ok: false; error: TokenError }> {
  const parsed = TokenRequestSchema.safeParse(rawBody);
  if (!parsed.success) {
    return invalid(
      "invalid_request",
      parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
    );
  }

  if (parsed.data.grant_type === "authorization_code") {
    return handleAuthorizationCode(parsed.data, config);
  }
  return handleRefreshToken(parsed.data, config);
}

async function handleAuthorizationCode(
  body: { code: string; redirect_uri: string; code_verifier: string; client_id?: string },
  config: OAuthConfig,
): Promise<{ ok: true; response: TokenSuccess } | { ok: false; error: TokenError }> {
  const decoded = await decryptJwe<AuthCodeClaims>(body.code, config.signingKey, "code");
  if (!decoded.ok) {
    return invalidGrant(`authorization code rejected (${decoded.reason})`);
  }
  const code = decoded.payload;

  if (code.redirect_uri !== body.redirect_uri) {
    return invalidGrant("redirect_uri does not match the value used during /authorize");
  }
  if (body.client_id && body.client_id !== code.client_id) {
    return invalidGrant("client_id does not match the value used during /authorize");
  }
  if (!verifyPkce(body.code_verifier, code.code_challenge, code.code_challenge_method)) {
    return invalidGrant("code_verifier does not match code_challenge");
  }

  return issueTokenPair(
    {
      client_id: code.client_id,
      upstream_access_token: code.upstream_access_token,
      identity: code.identity,
      scope: code.scope,
    },
    config,
  );
}

async function handleRefreshToken(
  body: { refresh_token: string; client_id?: string; scope?: string },
  config: OAuthConfig,
): Promise<{ ok: true; response: TokenSuccess } | { ok: false; error: TokenError }> {
  const decoded = await decryptJwe<RefreshTokenClaims>(
    body.refresh_token,
    config.signingKey,
    "refresh",
  );
  if (!decoded.ok) {
    return invalidGrant(`refresh token rejected (${decoded.reason})`);
  }
  const refresh = decoded.payload;

  if (body.client_id && body.client_id !== refresh.client_id) {
    return invalidGrant("client_id does not match refresh token");
  }

  // Optional scope narrowing (RFC 6749 §6) — we accept identical or subset only.
  let scope = refresh.scope;
  if (body.scope !== undefined) {
    if (!isSubsetScope(body.scope, refresh.scope)) {
      return {
        ok: false,
        error: {
          error: "invalid_scope",
          error_description: "requested scope exceeds original",
          status: 400,
        },
      };
    }
    scope = body.scope;
  }

  return issueTokenPair(
    {
      client_id: refresh.client_id,
      upstream_access_token: refresh.upstream_access_token,
      identity: refresh.identity,
      scope,
    },
    config,
  );
}

async function issueTokenPair(
  payload: {
    client_id: string;
    upstream_access_token: string;
    identity: Record<string, unknown>;
    scope: string;
  },
  config: OAuthConfig,
): Promise<{ ok: true; response: TokenSuccess }> {
  const access: AccessTokenClaims = { typ: "access", ...payload };
  const refresh: RefreshTokenClaims = { typ: "refresh", ...payload };
  const [accessToken, refreshToken] = await Promise.all([
    encryptJwe(access, config.signingKey, TTL.accessToken),
    encryptJwe(refresh, config.signingKey, TTL.refreshToken),
  ]);
  return {
    ok: true,
    response: {
      access_token: accessToken,
      refresh_token: refreshToken,
      token_type: "Bearer",
      expires_in: TTL.accessToken,
      ...(payload.scope ? { scope: payload.scope } : {}),
    },
  };
}

function invalid(
  error: TokenError["error"],
  description: string,
): { ok: false; error: TokenError } {
  return { ok: false, error: { error, error_description: description, status: 400 } };
}

function invalidGrant(description: string): { ok: false; error: TokenError } {
  return {
    ok: false,
    error: { error: "invalid_grant", error_description: description, status: 400 },
  };
}

function isSubsetScope(requested: string, granted: string): boolean {
  const grantedSet = new Set(granted.split(/\s+/).filter(Boolean));
  const requestedScopes = requested.split(/\s+/).filter(Boolean);
  return requestedScopes.every((s) => grantedSet.has(s));
}
