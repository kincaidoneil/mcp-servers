export interface AuthorizationServerMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint: string;
  jwks_uri?: string;
  scopes_supported?: string[];
  response_types_supported: string[];
  grant_types_supported: string[];
  token_endpoint_auth_methods_supported: string[];
  code_challenge_methods_supported: string[];
  service_documentation?: string;
}

export function authorizationServerMetadata(
  baseUrl: string,
  scopes: string[],
): AuthorizationServerMetadata {
  const issuer = stripTrailingSlash(baseUrl);
  return {
    issuer,
    authorization_endpoint: `${issuer}/oauth/authorize`,
    token_endpoint: `${issuer}/oauth/token`,
    registration_endpoint: `${issuer}/oauth/register`,
    scopes_supported: scopes,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    token_endpoint_auth_methods_supported: ["none"],
    code_challenge_methods_supported: ["S256"],
  };
}

export interface ProtectedResourceMetadata {
  resource: string;
  authorization_servers: string[];
  bearer_methods_supported: string[];
  scopes_supported?: string[];
}

export function protectedResourceMetadata(
  baseUrl: string,
  scopes: string[],
): ProtectedResourceMetadata {
  const issuer = stripTrailingSlash(baseUrl);
  return {
    resource: issuer,
    authorization_servers: [issuer],
    bearer_methods_supported: ["header"],
    scopes_supported: scopes,
  };
}

function stripTrailingSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}
