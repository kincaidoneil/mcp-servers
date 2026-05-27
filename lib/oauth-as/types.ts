// Token payloads carried inside JWS/JWE artifacts. `typ` is the disambiguator
// so a leaked refresh token can never be replayed as an access token, etc.

export interface ClientIdClaims {
  typ: "client";
  client_name: string | null;
  redirect_uris: string[];
  iat?: number;
}

export interface AsStateClaims {
  typ: "as-state";
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  code_challenge_method: "S256";
  client_state: string | null;
  scope: string;
  iat?: number;
  exp?: number;
}

export interface AuthCodeClaims {
  typ: "code";
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  code_challenge_method: "S256";
  upstream_access_token: string;
  identity: Record<string, unknown>;
  scope: string;
  iat?: number;
  exp?: number;
}

export interface AccessTokenClaims {
  typ: "access";
  client_id: string;
  upstream_access_token: string;
  identity: Record<string, unknown>;
  scope: string;
  iat?: number;
  exp?: number;
}

export interface RefreshTokenClaims {
  typ: "refresh";
  client_id: string;
  upstream_access_token: string;
  identity: Record<string, unknown>;
  scope: string;
  iat?: number;
  exp?: number;
}

export interface OAuthConfig {
  baseUrl: string;
  signingKey: Uint8Array;
}

export const TTL = {
  asState: 10 * 60,
  authCode: 5 * 60,
  accessToken: 60 * 60,
  refreshToken: 365 * 24 * 60 * 60,
} as const;
